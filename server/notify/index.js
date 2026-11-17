'use strict';

const { db, getSetting, setSetting } = require('../db');
const { LEVELS, buildEvent, renderPlain } = require('./format');
const telegram = require('./channels/telegram');
const webhook = require('./channels/webhook');
const legacy = require('./channels/legacy');

const CHANNEL_TYPES = ['telegram', 'webhook', 'wecom', 'bark', 'feishu', 'dingtalk'];
const MIN_LEVELS = ['info', 'warn', 'down'];
const SCOPES = ['all', 'group', 'monitor'];
const MASK = '****';

const adapters = {
  telegram,
  webhook,
  wecom: legacy,
  bark: legacy,
  feishu: legacy,
  dingtalk: legacy,
};

// ---------- 基础工具 ----------

function parseConfig(channel) {
  if (!channel) return {};
  if (channel.config && typeof channel.config === 'object') return channel.config;
  try {
    const parsed = JSON.parse(channel.config || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function maskToken(token) {
  const raw = String(token || '');
  if (!raw) return '';
  const idx = raw.indexOf(':');
  return idx > 0 ? `${raw.slice(0, idx)}:${MASK}` : MASK;
}

function maskUrl(url) {
  return String(url || '').replace(
    /([?&](?:key|token|secret|access_token|sign|password)=)([^&#]+)/gi,
    (_, head) => `${head}${MASK}`
  );
}

function maskConfig(type, cfg) {
  const out = { ...cfg };
  if (type === 'telegram' && out.bot_token) out.bot_token = maskToken(out.bot_token);
  if (out.url) out.url = maskUrl(out.url);
  if (out.secret) out.secret = MASK;
  if (out.headers && typeof out.headers === 'object') {
    out.headers = { ...out.headers };
    for (const key of Object.keys(out.headers)) {
      if (/authorization|api[-_]?key|cookie|token/i.test(key)) out.headers[key] = MASK;
    }
  }
  return out;
}

function isMasked(value) {
  return typeof value === 'string' && value.includes(MASK);
}

/** 前端回传脱敏值时保留旧值 */
function mergeConfig(oldCfg, newCfg) {
  const out = { ...oldCfg };
  for (const [key, value] of Object.entries(newCfg || {})) {
    if (isMasked(value)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(oldCfg[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function detectLegacyType(url) {
  const u = String(url || '');
  if (u.includes('qyapi.weixin.qq.com')) return 'wecom';
  if (/api\.day\.app|bark/i.test(u)) return 'bark';
  if (u.includes('open.feishu.cn')) return 'feishu';
  if (u.includes('oapi.dingtalk.com')) return 'dingtalk';
  return 'webhook';
}

// ---------- 渠道 CRUD ----------

const getStmt = db.prepare('SELECT * FROM notify_channel WHERE id = ?');

function getChannel(id) {
  return getStmt.get(Number(id)) || null;
}

function decorate(ch) {
  const config = parseConfig(ch);
  return {
    ...ch,
    config: maskConfig(ch.type, config),
    scope: ch.scope || 'all',
    min_level: ch.min_level || 'info',
  };
}

function listChannels({ withSecrets = false } = {}) {
  const rows = db.prepare('SELECT * FROM notify_channel ORDER BY id ASC').all();
  if (withSecrets) return rows.map((c) => ({ ...c, config: parseConfig(c) }));
  return rows.map(decorate);
}

function normalizeChannel(input) {
  const type = CHANNEL_TYPES.includes(input.type) ? input.type : 'webhook';
  const scope = SCOPES.includes(input.scope) ? input.scope : 'all';
  const minLevel = MIN_LEVELS.includes(input.min_level) ? input.min_level : 'info';
  const cooldown = Math.min(86400, Math.max(30, Number(input.cooldown_sec) || 300));

  const row = {
    name: String(input.name || '').trim().slice(0, 40) || `${type} 渠道`,
    type,
    scope,
    group_name: scope === 'group' ? String(input.group_name || '').trim().slice(0, 40) || null : null,
    monitor_id: scope === 'monitor' && Number(input.monitor_id) > 0 ? Number(input.monitor_id) : null,
    min_level: minLevel,
    cooldown_sec: cooldown,
    active: input.active === 0 || input.active === '0' || input.active === false ? 0 : 1,
  };

  if (scope === 'group' && !row.group_name) throw new Error('请填写分组名');
  if (scope === 'monitor' && !row.monitor_id) throw new Error('请选择监控项');

  return row;
}

function createChannel(input) {
  const row = normalizeChannel(input);
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  validateConfig(row.type, config);

  const info = db
    .prepare(
      `INSERT INTO notify_channel
        (name, type, config, scope, group_name, monitor_id, min_level, active, cooldown_sec, created_at)
       VALUES (@name, @type, @config, @scope, @group_name, @monitor_id, @min_level, @active, @cooldown_sec, @created_at)`
    )
    .run({ ...row, config: JSON.stringify(config), created_at: Date.now() });

  return getChannel(info.lastInsertRowid);
}

function validateConfig(type, config) {
  if (type === 'telegram') {
    if (!String(config.bot_token || '').trim()) throw new Error('请填写 Bot Token');
    if (!String(config.chat_id || '').trim()) throw new Error('请填写 Chat ID');
  } else {
    const url = String(config.url || '').trim();
    if (!url) throw new Error('请填写 Webhook 地址');
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      throw new Error('Webhook 地址格式不正确');
    }
  }
}

function updateChannel(id, input) {
  const current = getChannel(id);
  if (!current) throw new Error('渠道不存在');

  const merged = normalizeChannel({
    ...current,
    ...input,
    min_level: input.min_level !== undefined ? input.min_level : current.min_level,
    active: input.active !== undefined ? input.active : current.active,
  });
  const config = mergeConfig(parseConfig(current), input.config || {});
  validateConfig(merged.type, config);

  db.prepare(
    `UPDATE notify_channel SET
       name = @name, type = @type, config = @config, scope = @scope, group_name = @group_name,
       monitor_id = @monitor_id, min_level = @min_level, active = @active, cooldown_sec = @cooldown_sec
     WHERE id = @id`
  ).run({ ...merged, config: JSON.stringify(config), id: current.id });

  return getChannel(current.id);
}

function deleteChannel(id) {
  return db.prepare('DELETE FROM notify_channel WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- 发送 ----------

function channelMatches(channel, event) {
  if (channel.scope === 'all') return true;
  if (!event.monitor) return false;
  if (channel.scope === 'monitor') return Number(channel.monitor_id) === Number(event.monitor.id);
  if (channel.scope === 'group') return String(channel.group_name || '') === String(event.monitor.group || '');
  return false;
}

function inCooldown(channel, event, now) {
  const sec = Number(channel.cooldown_sec) || 0;
  if (sec <= 0) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM notification_log
        WHERE channel_id = ? AND kind = ? AND ref_key = ? AND ok = 1 AND created_at > ?
        LIMIT 1`
    )
    .get(channel.id, event.kind, event.refKey, now - sec * 1000);
  return Boolean(row);
}

async function sendWithRetry(channel, event) {
  const adapter = adapters[channel.type] || webhook;
  let last = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      last = await adapter.send(channel, event);
    } catch (err) {
      const cause = err.cause && (err.cause.code || err.cause.message);
      last = {
        ok: false,
        error:
          err.name === 'TimeoutError'
            ? '请求超时（8s）'
            : cause
              ? `${err.message}（${cause}）`
              : err.message || '发送失败',
      };
    }
    if (last.ok) return last;

    const status = Number(last.statusCode) || 0;
    // 配置类错误重试没有意义；429 单独按 retry_after 处理
    if (status >= 400 && status < 500 && status !== 429) return last;
    if (attempt === 2) return last;

    const wait = last.retryAfter
      ? Math.min(5000, Math.max(500, Number(last.retryAfter) * 1000))
      : attempt === 0
        ? 400
        : 1200;
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

function logNotification(channel, event, result, monitorId) {
  db.prepare(
    `INSERT INTO notification_log
      (channel_id, monitor_id, ref_key, kind, level, title, body, ok, status_code, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    channel ? channel.id : null,
    monitorId || (event.monitor ? event.monitor.id : null),
    event.refKey,
    event.kind,
    event.level,
    event.title,
    String(event.body || '').slice(0, 2000),
    result.ok ? 1 : 0,
    result.statusCode ?? null,
    result.ok ? null : String(result.error || '').slice(0, 500) || null,
    Date.now()
  );
}

function markChannelHealth(channel, result) {
  if (!channel) return;
  if (result.ok) {
    db.prepare('UPDATE notify_channel SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(
      Date.now(),
      channel.id
    );
  } else {
    db.prepare('UPDATE notify_channel SET last_error = ? WHERE id = ?').run(
      String(result.error || '发送失败').slice(0, 300),
      channel.id
    );
  }
}

/**
 * 统一分发入口
 * @param {object} event buildEvent() 的产物
 * @param {{ monitorId?: number }} opts
 */
async function dispatch(event, opts = {}) {
  if (getSetting('notify_enabled') === '0') return [];
  const now = Date.now();
  const channels = listChannels({ withSecrets: true }).filter(
    (c) => c.active && channelMatches(c, event) && LEVELS[c.min_level || 'info'] <= LEVELS[event.level]
  );
  if (!channels.length) return [];

  const results = [];
  for (const channel of channels) {
    if (inCooldown(channel, event, now)) {
      console.log(`[notify] 冷却中跳过 channel#${channel.id} ${event.kind}`);
      continue;
    }
    const result = await sendWithRetry(channel, event);
    logNotification(channel, event, result, opts.monitorId);
    markChannelHealth(channel, result);
    if (!result.ok) {
      console.warn(`[notify] channel#${channel.id} 发送失败: ${result.error}`);
    }
    results.push({ channelId: channel.id, ...result });
  }
  return results;
}

/** 某监控某类事件最近一次发送成功的时间 */
function lastNotifiedAt(monitorId, kind, refKey) {
  const row = db
    .prepare(
      `SELECT created_at FROM notification_log
        WHERE monitor_id = ? AND kind = ? AND ref_key = ? AND ok = 1
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(Number(monitorId), kind, refKey || `m:${Number(monitorId)}`);
  return row ? row.created_at : null;
}

async function testChannel(id) {
  const row = getChannel(id);
  if (!row) throw new Error('渠道不存在');
  const channel = { ...row, config: parseConfig(row) };

  const event = buildEvent('test', { ts: Date.now() });
  const started = Date.now();
  const result = await sendWithRetry(channel, event);
  logNotification(channel, event, result, null);
  markChannelHealth(channel, result);

  return {
    ok: Boolean(result.ok),
    statusCode: result.statusCode ?? null,
    error: result.ok ? null : result.error || '发送失败',
    latencyMs: Date.now() - started,
    channel: decorate(getChannel(id)),
  };
}

// ---------- 日志 ----------

function listLogs({ limit = 50, monitorId = null, kind = null } = {}) {
  const where = [];
  const params = [];
  if (monitorId) {
    where.push('l.monitor_id = ?');
    params.push(Number(monitorId));
  }
  if (kind) {
    where.push('l.kind = ?');
    params.push(String(kind));
  }
  const sql = `SELECT l.*, c.name AS channel_name, c.type AS channel_type, m.name AS monitor_name
                 FROM notification_log l
                 LEFT JOIN notify_channel c ON c.id = l.channel_id
                 LEFT JOIN monitors m ON m.id = l.monitor_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY l.created_at DESC LIMIT ?`;
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  return db.prepare(sql).all(...params);
}

// ---------- 旧版 webhook_url 兼容 ----------

function syncLegacyWebhook() {
  const url = String(getSetting('webhook_url') || '').trim();
  const id = Number(getSetting('legacy_channel_id') || 0);

  if (id) {
    const ch = getChannel(id);
    if (!ch) return null; // 用户已删除，尊重这个决定，不再自动重建
    if (!url) return ch;
    const config = { ...parseConfig(ch), url };
    db.prepare('UPDATE notify_channel SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
    return getChannel(id);
  }

  if (!url) return null;
  const created = createChannel({
    name: '旧版 Webhook',
    type: detectLegacyType(url),
    config: { url },
    min_level: 'info',
    cooldown_sec: 300,
  });
  setSetting('legacy_channel_id', String(created.id));
  setSetting('notify_migrated', '1');
  console.log('[notify] 已把 settings.webhook_url 迁移为通知渠道 #' + created.id);
  return created;
}

module.exports = {
  CHANNEL_TYPES,
  MIN_LEVELS,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  dispatch,
  buildEvent,
  testChannel,
  listLogs,
  lastNotifiedAt,
  syncLegacyWebhook,
  detectLegacyType,
  renderPlain,
};
