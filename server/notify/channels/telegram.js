'use strict';

const { renderHtml } = require('../format');

/**
 * Telegram Bot 适配器
 * config: { bot_token, chat_id, thread_id?, parse_mode? }
 */
async function send(channel, event) {
  const cfg = channel.config || {};
  const token = String(cfg.bot_token || '').trim();
  const chatId = String(cfg.chat_id || '').trim();
  if (!token || !chatId) {
    return { ok: false, error: '缺少 bot_token 或 chat_id' };
  }

  const body = {
    chat_id: chatId,
    text: renderHtml(event).slice(0, 4000),
    parse_mode: cfg.parse_mode === 'MarkdownV2' ? 'MarkdownV2' : 'HTML',
    disable_web_page_preview: true,
  };
  if (cfg.thread_id) body.message_thread_id = Number(cfg.thread_id);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return {
      ok: false,
      statusCode: res.status,
      error: data.description || `HTTP ${res.status}`,
      retryAfter: data.parameters && data.parameters.retry_after,
    };
  }
  return { ok: true, statusCode: 200 };
}

module.exports = { send };
