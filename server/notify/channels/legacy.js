'use strict';

const { renderPlain } = require('../format');

/** 企业微信 / 飞书 / 钉钉 / Bark：保持 1.3.x 的报文结构，行为不变 */
async function send(channel, event) {
  const cfg = channel.config || {};
  const url = String(cfg.url || '').trim();
  if (!url) return { ok: false, error: '未填写 Webhook 地址' };

  const text = renderPlain(event);
  let payload;

  switch (channel.type) {
    case 'wecom':
      payload = { msgtype: 'text', text: { content: text } };
      break;
    case 'feishu':
      payload = { msg_type: 'text', content: { text } };
      break;
    case 'dingtalk':
      payload = { msgtype: 'text', text: { content: text } };
      break;
    case 'bark':
      payload = {
        title: event.title,
        body: event.body,
        group: '站点监控',
        level: event.level === 'down' ? 'timeSensitive' : 'active',
      };
      break;
    default:
      return { ok: false, error: `不支持的渠道类型：${channel.type}` };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      statusCode: res.status,
      error: `HTTP ${res.status}${body ? ' · ' + body.slice(0, 120) : ''}`,
      retryAfter: res.headers.get('retry-after'),
    };
  }
  return { ok: true, statusCode: res.status };
}

module.exports = { send };
