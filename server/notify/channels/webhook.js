'use strict';

const crypto = require('crypto');
const { renderPlain, renderHtml } = require('../format');

/** 只做字符串替换，不求值，避免模板注入 */
function applyTemplate(tpl, event) {
  const vars = {
    '{{event}}': event.kind,
    '{{level}}': event.level,
    '{{title}}': event.title,
    '{{body}}': event.body,
    '{{text}}': renderPlain(event),
    '{{html}}': renderHtml(event),
    '{{monitor.name}}': event.monitor ? event.monitor.name : '',
    '{{monitor.url}}': event.monitor ? event.monitor.url : '',
    '{{monitor.id}}': event.monitor ? String(event.monitor.id) : '',
    '{{cert.host}}': event.cert ? event.cert.host : '',
    '{{cert.days}}': event.cert && event.cert.days != null ? String(event.cert.days) : '',
    '{{window.title}}': event.window ? event.window.title : '',
    '{{ts}}': String(event.ts),
  };
  let out = String(tpl);
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

/**
 * 通用 Webhook
 * config: { url, method?, headers?, secret?, template? }
 */
async function send(channel, event) {
  const cfg = channel.config || {};
  const url = String(cfg.url || '').trim();
  if (!url) return { ok: false, error: '未填写 Webhook 地址' };

  const method = String(cfg.method || 'POST').toUpperCase();
  let raw;
  if (cfg.template) {
    raw = applyTemplate(cfg.template, event);
    // 模板不是合法 JSON 时按纯文本发，content-type 自动降级
  } else {
    raw = JSON.stringify({
      event: event.kind,
      level: event.level,
      title: event.title,
      body: event.body,
      monitor: event.monitor,
      result: event.result,
      cert: event.cert,
      window: event.window,
      ts: event.ts,
    });
  }

  let isJson = false;
  try {
    JSON.parse(raw);
    isJson = true;
  } catch {
    isJson = false;
  }

  const headers = Object.assign(
    { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8' },
    cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}
  );

  if (cfg.secret) {
    headers['x-beacon-signature'] =
      'sha256=' + crypto.createHmac('sha256', String(cfg.secret)).update(raw).digest('hex');
  }

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : raw,
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      statusCode: res.status,
      error: `HTTP ${res.status}${text ? ' · ' + text.slice(0, 120) : ''}`,
      retryAfter: res.headers.get('retry-after'),
    };
  }
  return { ok: true, statusCode: res.status };
}

module.exports = { send, applyTemplate };
