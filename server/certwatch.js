'use strict';

/**
 * 证书巡检：按 host 去重，跨过阈值才提醒，续期后自动重置标记
 */

const { db, getSetting } = require('./db');
const { getCertInfo } = require('./checker');
const notify = require('./notify');

const HOUR = 3600 * 1000;

function thresholds() {
  return String(getSetting('cert_alert_days') || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 3650)
    .sort((a, b) => b - a);
}

/** 活跃监控里的 https 目标，按 host 去重（同一域名只查一次） */
function targets() {
  const rows = db
    .prepare(
      `SELECT id, name, group_name, url FROM monitors
        WHERE active = 1 AND url LIKE 'https://%' ORDER BY id ASC`
    )
    .all();
  const map = new Map();
  for (const m of rows) {
    let host;
    try {
      host = new URL(m.url).hostname;
    } catch {
      continue;
    }
    if (!map.has(host)) {
      map.set(host, {
        host,
        url: m.url,
        monitor: m,
        count: 1,
      });
    } else {
      map.get(host).count += 1;
    }
  }
  return [...map.values()];
}

// ---------- 状态读写 ----------

function getState(host) {
  return db.prepare('SELECT * FROM cert_state WHERE host = ?').get(host) || null;
}

function marksOf(host) {
  const row = getState(host);
  if (!row || !row.notified_marks) return [];
  return String(row.notified_marks)
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function saveMarks(host, marks) {
  const unique = [...new Set(marks)].sort((a, b) => b - a);
  db.prepare('UPDATE cert_state SET notified_marks = ? WHERE host = ?').run(unique.join(','), host);
}

function addMarks(host, days) {
  saveMarks(host, [...marksOf(host), ...days]);
}

function clearMarks(host) {
  db.prepare('UPDATE cert_state SET notified_marks = ? WHERE host = ?').run('', host);
}

function upsertSuccess(t, info) {
  db.prepare(
    `INSERT INTO cert_state
       (host, monitor_id, subject, issuer, expires_at, days, last_check, fail_count, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(host) DO UPDATE SET
       monitor_id = excluded.monitor_id,
       subject    = excluded.subject,
       issuer     = excluded.issuer,
       expires_at = excluded.expires_at,
       days       = excluded.days,
       last_check = excluded.last_check,
       fail_count = 0,
       last_error = NULL`
  ).run(t.host, t.monitor.id, info.subject || null, info.issuer || null, info.expiresAt, info.days, Date.now());
}

function upsertFailure(t, message) {
  db.prepare(
    `INSERT INTO cert_state
       (host, monitor_id, last_check, fail_count, last_error)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(host) DO UPDATE SET
       last_check = excluded.last_check,
       fail_count = cert_state.fail_count + 1,
       last_error = excluded.last_error`
  ).run(t.host, t.monitor.id, Date.now(), String(message || 'TLS 握手失败').slice(0, 200));
}

function certLevel(days) {
  if (days == null) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= 3) return 'critical';
  if (days <= 14) return 'warn';
  return 'ok';
}

/** 后台列表：按剩余天数升序 */
function listCertState() {
  const rows = db
    .prepare(
      `SELECT c.*, m.name AS monitor_name, m.url AS monitor_url
         FROM cert_state c
         LEFT JOIN monitors m ON m.id = c.monitor_id
        ORDER BY (c.days IS NULL) ASC, c.days ASC, c.host ASC`
    )
    .all();
  return rows.map((r) => ({ ...r, level: certLevel(r.days) }));
}

// ---------- 巡检 ----------

let scanning = false;

async function scanCertificates({ force = false } = {}) {
  if (scanning) return { busy: true, scanned: 0, alerted: 0, items: [] };
  scanning = true;
  const started = Date.now();
  const result = { scanned: 0, alerted: 0, failed: 0, items: [] };

  try {
    if (getSetting('cert_alert_enabled') === '0') return result;

    const limits = thresholds();
    const maxLimit = limits.length ? limits[0] : 30;
    const list = targets();

    for (const t of list) {
      let info = null;
      try {
        info = await getCertInfo(t.url, { force });
      } catch {
        info = null;
      }

      if (!info) {
        result.failed += 1;
        upsertFailure(t, '无法读取证书（握手失败或非 HTTPS）');
        continue;
      }

      const prev = getState(t.host);
      upsertSuccess(t, info);
      result.scanned += 1;

      // 续期：到期时间变晚 → 清空已提醒标记
      if (prev && prev.expires_at && info.expiresAt > prev.expires_at) {
        clearMarks(t.host);
      }
      // 离到期还很远：确保标记为空，避免误报
      if (info.days > maxLimit) {
        clearMarks(t.host);
        result.items.push({ host: t.host, days: info.days, level: certLevel(info.days), alerted: false });
        continue;
      }

      const marks = marksOf(t.host);
      const crossed = limits.filter((d) => info.days <= d && !marks.includes(d));
      if (!crossed.length) {
        result.items.push({ host: t.host, days: info.days, level: certLevel(info.days), alerted: false });
        continue;
      }

      const event = notify.buildEvent('cert.expiring', {
        cert: {
          host: t.host,
          days: info.days,
          expiresAt: info.expiresAt,
          issuer: info.issuer,
          subject: info.subject,
        },
        monitor: t.monitor,
        level: info.days <= 3 ? 'down' : 'warn',
        refKey: `c:${t.host}`,
      });

      const results = await notify.dispatch(event, { monitorId: t.monitor.id });
      const delivered = results.some((r) => r.ok);
      if (delivered) {
        addMarks(t.host, crossed);
        result.alerted += 1;
      }
      result.items.push({
        host: t.host,
        days: info.days,
        level: certLevel(info.days),
        alerted: delivered,
        thresholds: crossed,
      });
    }

    console.log(
      `[cert] 巡检完成 ${result.scanned}/${list.length}，告警 ${result.alerted}，` +
        `失败 ${result.failed}，耗时 ${Date.now() - started}ms`
    );
    return result;
  } finally {
    scanning = false;
  }
}

let timer = null;

function start() {
  if (timer) return;
  const hours = Math.min(168, Math.max(1, Number(getSetting('cert_check_hours')) || 6));
  // 启动 90 秒后首跑，避开首轮检测高峰
  setTimeout(() => {
    scanCertificates({ force: true }).catch((err) => console.warn('[cert] 首轮巡检失败:', err.message));
  }, 90 * 1000).unref?.();

  timer = setInterval(() => {
    scanCertificates().catch((err) => console.warn('[cert] 巡检失败:', err.message));
  }, hours * HOUR);
  timer.unref?.();
  console.log(`[cert] 证书巡检已启动，每 ${hours} 小时一次`);
}

module.exports = { scanCertificates, listCertState, thresholds, certLevel, start, targets };
