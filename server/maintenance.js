'use strict';

/**
 * 计划维护窗口
 * - 一次性：starts_at + ends_at
 * - 周期：starts_at（首次生效）+ rrule + duration_min
 * 展开不依赖任何第三方库，也不依赖容器 TZ：统一按 settings.maint_timezone 解释墙上时间。
 */

const { db, getSetting, listMonitors, getMonitor } = require('./db');

const SCOPES = ['all', 'group', 'monitor'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY'];
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_LOOKAHEAD_DAYS = 400;

// ---------- 时区工具 ----------

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  }
  return fmtCache.get(tz);
}

function tz() {
  const t = String(getSetting('maint_timezone') || 'Asia/Shanghai');
  try {
    formatter(t).format(new Date());
    return t;
  } catch {
    return 'UTC';
  }
}

/** 某时刻在该时区的墙上时间 */
function localParts(timezone, ts) {
  const parts = formatter(timezone)
    .formatToParts(new Date(ts))
    .reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function offsetMs(timezone, date) {
  const p = formatter(timezone)
    .formatToParts(date)
    .reduce((acc, x) => {
      if (x.type !== 'literal') acc[x.type] = x.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - date.getTime();
}

/** 当地墙上时间 → UTC 时间戳（两次逼近，覆盖 DST 切换） */
function wallToTs(timezone, y, m, d, hour, minute) {
  const base = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = base - offsetMs(timezone, new Date(base));
  const off = offsetMs(timezone, new Date(guess));
  if (off !== offsetMs(timezone, new Date(base))) {
    guess = base - off;
  }
  return guess;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------- rrule 子集 ----------

/** 解析 FREQ=WEEKLY;BYDAY=SU,MO;BYHOUR=3;BYMINUTE=0 */
function parseRRule(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const map = {};
  for (const chunk of text.split(';')) {
    const [k, v] = chunk.split('=');
    if (!k || v == null) continue;
    map[k.trim().toUpperCase()] = v.trim();
  }
  const freq = String(map.FREQ || '').toUpperCase();
  if (!FREQS.includes(freq)) return null;
  if (map.COUNT || map.UNTIL) return null; // 明确拒绝，避免无限/歧义展开

  const byday = (map.BYDAY || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s in WEEKDAYS)
    .map((s) => WEEKDAYS[s]);

  const bymonthday = (map.BYMONTHDAY || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);

  const hour = Number(map.BYHOUR);
  const minute = Number(map.BYMINUTE);

  return {
    freq,
    byday: byday.length ? byday : null,
    bymonthday: bymonthday.length ? bymonthday : null,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
  };
}

function ruleMatchesDate(rule, parts) {
  if (rule.freq === 'DAILY') return true;
  if (rule.freq === 'WEEKLY') {
    return rule.byday ? rule.byday.includes(parts.weekday) : parts.weekday === 0;
  }
  if (rule.freq === 'MONTHLY') {
    if (rule.bymonthday) return rule.bymonthday.includes(parts.day);
    return parts.day === 1;
  }
  return false;
}

/** 某次维护的结束时间 */
function windowEnd(w, start) {
  if (w.duration_min) return start + Math.max(1, Number(w.duration_min)) * 60000;
  if (w.ends_at) return Number(w.ends_at);
  return start + 3600000;
}

/**
 * 判断 ts 是否落在某个发生区间内，命中返回 {start,end}
 */
function occurrenceCovers(w, ts, timezone = tz()) {
  if (!w) return null;

  if (!w.rrule) {
    const start = Number(w.starts_at);
    const end = w.ends_at ? Number(w.ends_at) : start + 3600000;
    return ts >= start && ts < end ? { start, end } : null;
  }

  const rule = parseRRule(w.rrule);
  if (!rule) return null;

  const dur = Math.max(1, Number(w.duration_min) || 60) * 60000;
  // 跨日窗口：当前时刻与「窗口起点可能落在的前一天」都试一次
  for (const probe of [ts, ts - dur + 1000]) {
    const parts = localParts(timezone, probe);
    if (!ruleMatchesDate(rule, parts)) continue;
    if (rule.freq === 'MONTHLY' && rule.bymonthday) {
      if (parts.day > daysInMonth(parts.year, parts.month)) continue;
    }
    const start = wallToTs(timezone, parts.year, parts.month, parts.day, rule.hour, rule.minute);
    if (start < Number(w.starts_at)) continue;
    if (ts >= start && ts < start + dur) return { start, end: start + dur };
  }
  return null;
}

/** 从 ts 起（含）之后最近的一次发生起点 */
function nextOccurrence(w, ts, timezone = tz()) {
  if (!w.rrule) {
    const start = Number(w.starts_at);
    const end = w.ends_at ? Number(w.ends_at) : start + 3600000;
    return end > ts ? start : null;
  }
  const rule = parseRRule(w.rrule);
  if (!rule) return null;
  const dur = Math.max(1, Number(w.duration_min) || 60) * 60000;

  const today = localParts(timezone, ts);
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i += 1) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const parts = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
    };
    if (!ruleMatchesDate(rule, parts)) continue;
    if (rule.freq === 'MONTHLY' && rule.bymonthday && parts.day > daysInMonth(parts.year, parts.month)) {
      continue;
    }
    const start = wallToTs(timezone, parts.year, parts.month, parts.day, rule.hour, rule.minute);
    if (start < Number(w.starts_at)) continue;
    if (start + dur > ts) return start;
  }
  return null;
}

// ---------- 作用域 ----------

function matchScope(w, monitor) {
  if (!monitor) return false;
  if (w.scope === 'all') return true;
  if (w.scope === 'monitor') return Number(w.monitor_id) === Number(monitor.id);
  if (w.scope === 'group') return String(w.group_name || '') === String(monitor.group_name || '');
  return false;
}

/** 命中维护窗口时返回带 occStart/occEnd 的窗口副本 */
function activeWindowFor(monitor, ts = Date.now(), timezone = tz()) {
  if (!monitor) return null;
  const rows = stmtActiveAll.all();
  for (const w of rows) {
    if (!matchScope(w, monitor)) continue;
    const occ = occurrenceCovers(w, ts, timezone);
    if (occ) return { ...w, occStart: occ.start, occEnd: occ.end };
  }
  return null;
}

function activeWindowsFor(monitors, ts = Date.now()) {
  const rows = stmtActiveAll.all();
  const out = new Map();
  if (!rows.length) return out;
  const timezone = tz();
  for (const m of monitors) {
    for (const w of rows) {
      if (!matchScope(w, m)) continue;
      const occ = occurrenceCovers(w, ts, timezone);
      if (occ) {
        out.set(m.id, { ...w, occStart: occ.start, occEnd: occ.end });
        break;
      }
    }
  }
  return out;
}

// ---------- CRUD ----------

const stmtActiveAll = db.prepare('SELECT * FROM maintenance_window WHERE active = 1 ORDER BY starts_at ASC');
const getStmt = db.prepare('SELECT * FROM maintenance_window WHERE id = ?');

function getWindow(id) {
  return getStmt.get(Number(id)) || null;
}

function listWindows({ activeOnly = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM maintenance_window ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY starts_at DESC`)
    .all();
  const now = Date.now();
  const timezone = tz();
  return rows.map((w) => {
    const active = occurrenceCovers(w, now, timezone);
    const next = active ? active.start : nextOccurrence(w, now, timezone);
    return {
      ...w,
      state: active ? 'active' : next ? 'upcoming' : 'past',
      next_at: next,
      current_end: active ? active.end : null,
    };
  });
}

function normalizeInput(input, { partial = false } = {}) {
  const out = {};

  if (!partial || input.title !== undefined) {
    out.title = String(input.title || '计划维护').trim().slice(0, 40) || '计划维护';
  }
  if (!partial || input.scope !== undefined) {
    out.scope = SCOPES.includes(input.scope) ? input.scope : 'all';
  }
  if (!partial || input.group_name !== undefined) {
    out.group_name = input.group_name ? String(input.group_name).trim().slice(0, 40) : null;
  }
  if (!partial || input.monitor_id !== undefined) {
    const id = Number(input.monitor_id);
    out.monitor_id = Number.isInteger(id) && id > 0 ? id : null;
  }
  if (!partial || input.starts_at !== undefined) {
    out.starts_at = Math.round(Number(input.starts_at));
    if (!Number.isFinite(out.starts_at) || out.starts_at <= 0) throw new Error('开始时间不正确');
  }
  if (!partial || input.ends_at !== undefined) {
    const n = Number(input.ends_at);
    out.ends_at = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (!partial || input.duration_min !== undefined) {
    const n = Number(input.duration_min);
    out.duration_min = Number.isFinite(n) && n > 0 ? Math.min(10080, Math.max(5, Math.round(n))) : null;
  }
  if (!partial || input.rrule !== undefined) {
    out.rrule = input.rrule ? String(input.rrule).trim().slice(0, 200) : null;
  }
  if (!partial || input.active !== undefined) {
    out.active = input.active === 0 || input.active === '0' || input.active === false ? 0 : 1;
  }
  if (!partial || input.notify !== undefined) {
    out.notify = input.notify === 0 || input.notify === '0' || input.notify === false ? 0 : 1;
  }
  if (!partial || input.note !== undefined) {
    out.note = input.note ? String(input.note).slice(0, 200) : null;
  }
  return out;
}

function validate(row) {
  if (row.scope === 'monitor') {
    if (!row.monitor_id) throw new Error('请选择要维护的监控项');
    if (!getMonitor(row.monitor_id)) throw new Error('监控项不存在');
  }
  if (row.scope === 'group' && !row.group_name) throw new Error('请填写维护的分组名');

  if (row.rrule) {
    if (!parseRRule(row.rrule)) throw new Error('周期规则不合法（仅支持 DAILY / WEEKLY / MONTHLY）');
    if (!row.duration_min) throw new Error('周期维护必须填写每次持续分钟数');
    row.ends_at = null;
  } else {
    if (!row.ends_at) throw new Error('请填写结束时间');
    if (row.ends_at <= row.starts_at) throw new Error('结束时间必须晚于开始时间');
    if (row.ends_at - row.starts_at > 90 * 86400000) throw new Error('单个维护窗口不能超过 90 天');
    row.duration_min = null;
  }
  return row;
}

function createWindow(input) {
  const row = validate(normalizeInput(input));
  const info = db
    .prepare(
      `INSERT INTO maintenance_window
        (title, scope, group_name, monitor_id, starts_at, ends_at, duration_min, rrule, active, notify, note, created_at)
       VALUES (@title, @scope, @group_name, @monitor_id, @starts_at, @ends_at, @duration_min, @rrule, @active, @notify, @note, @created_at)`
    )
    .run({ ...row, created_at: Date.now() });
  return getWindow(info.lastInsertRowid);
}

function updateWindow(id, input) {
  const current = getWindow(id);
  if (!current) throw new Error('维护窗口不存在');
  const merged = validate({ ...current, ...normalizeInput(input, { partial: true }) });
  db.prepare(
    `UPDATE maintenance_window SET
       title = @title, scope = @scope, group_name = @group_name, monitor_id = @monitor_id,
       starts_at = @starts_at, ends_at = @ends_at, duration_min = @duration_min,
       rrule = @rrule, active = @active, notify = @notify, note = @note
     WHERE id = @id`
  ).run({ ...merged, id: current.id });
  return getWindow(current.id);
}

function deleteWindow(id) {
  return db.prepare('DELETE FROM maintenance_window WHERE id = ?').run(Number(id)).changes > 0;
}

/** 新建前试算：返回未来 3 次发生 */
function preview(input) {
  const row = validate(normalizeInput(input));
  const timezone = tz();
  const fake = { ...row, id: 0 };
  const out = [];
  let cursor = Date.now() - 1000;
  for (let i = 0; i < 3; i += 1) {
    const start = nextOccurrence(fake, cursor, timezone);
    if (!start) break;
    out.push({ start, end: windowEnd(fake, start) });
    cursor = windowEnd(fake, start) + 1000;
  }
  return { window: row, occurrences: out };
}

/** 公开接口用：当前 + 未来 N 小时内 */
function publicWindows(hours = 24) {
  const now = Date.now();
  const until = now + Math.max(1, hours) * 3600000;
  const monitors = listMonitors(true);
  const active = [];
  const upcoming = [];
  const timezone = tz();

  for (const w of stmtActiveAll.all()) {
    const ids = monitors.filter((m) => matchScope(w, m)).map((m) => m.id);
    if (!ids.length) continue;
    const occ = occurrenceCovers(w, now, timezone);
    if (occ) {
      active.push({
        id: w.id,
        title: w.title,
        scope: w.scope,
        group_name: w.group_name,
        startsAt: occ.start,
        endsAt: occ.end,
        note: w.note || null,
        monitorIds: ids,
      });
      continue;
    }
    const next = nextOccurrence(w, now, timezone);
    if (next && next <= until) {
      upcoming.push({
        id: w.id,
        title: w.title,
        scope: w.scope,
        group_name: w.group_name,
        startsAt: next,
        endsAt: windowEnd(w, next),
        note: w.note || null,
        monitorIds: ids,
      });
    }
  }

  upcoming.sort((a, b) => a.startsAt - b.startsAt);
  return { active, upcoming, updatedAt: now };
}

// ---------- 维护开始/结束事件 ----------

let watchTimer = null;
let activeIds = new Set();
let watchReady = false;
let dispatching = false;

function startWatcher() {
  if (watchTimer) return;
  const tick = () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const now = Date.now();
      const timezone = tz();
      const next = new Map();
      for (const w of stmtActiveAll.all()) {
        const occ = occurrenceCovers(w, now, timezone);
        if (occ) next.set(w.id, { w, occ });
      }

      if (!watchReady) {
        // 进程刚启动：只记录当前状态，不补发历史事件
        activeIds = new Set(next.keys());
        watchReady = true;
        return;
      }

      const notify = require('./notify');
      for (const [id, item] of next) {
        if (activeIds.has(id) || !item.w.notify) continue;
        notify
          .dispatch(notify.buildEvent('maintenance.start', { window: item.w, occ: item.occ }))
          .catch(() => {});
      }
      for (const id of activeIds) {
        if (next.has(id)) continue;
        const w = getWindow(id);
        if (!w || !w.notify) continue;
        notify
          .dispatch(notify.buildEvent('maintenance.end', { window: w }))
          .catch(() => {});
      }
      activeIds = new Set(next.keys());
    } catch (err) {
      console.warn('[maintenance] 事件检查失败:', err.message);
    } finally {
      dispatching = false;
    }
  };

  tick();
  watchTimer = setInterval(tick, 60 * 1000);
  watchTimer.unref?.();
}

module.exports = {
  SCOPES,
  activeWindowFor,
  activeWindowsFor,
  listWindows,
  getWindow,
  createWindow,
  updateWindow,
  deleteWindow,
  preview,
  publicWindows,
  matchScope,
  occurrenceCovers,
  nextOccurrence,
  parseRRule,
  startWatcher,
};
