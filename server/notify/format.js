'use strict';

/**
 * 通知事件构造与文本渲染
 * 所有渠道共用同一个 event 对象，适配器只负责「怎么发」。
 */

const LEVELS = { info: 0, warn: 1, down: 2 };

const KIND_LABEL = {
  'monitor.down': '访问异常',
  'monitor.up': '已恢复',
  'cert.expiring': '证书到期提醒',
  'maintenance.start': '计划维护开始',
  'maintenance.end': '计划维护结束',
  test: '测试通知',
};

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function scopeText(w) {
  if (!w) return '';
  if (w.scope === 'all') return '全站';
  if (w.scope === 'group') return `分组：${w.group_name || '—'}`;
  return `监控 #${w.monitor_id}`;
}

function buildEvent(kind, ctx = {}) {
  const ts = ctx.ts || Date.now();
  const monitor = ctx.monitor
    ? {
        id: ctx.monitor.id,
        name: ctx.monitor.name,
        url: ctx.monitor.url,
        group: ctx.monitor.group_name || ctx.monitor.group || '',
      }
    : null;
  const result = ctx.result || null;
  const cert = ctx.cert || null;
  const win = ctx.window || null;
  const occ = ctx.occ || null;

  const titleMap = {
    'monitor.down': `🔴 ${monitor ? monitor.name : '监控项'} 访问异常`,
    'monitor.up': `✅ ${monitor ? monitor.name : '监控项'} 已恢复`,
    'cert.expiring':
      cert && cert.days < 0
        ? `🔴 证书已过期：${cert.host}`
        : `⚠️ 证书 ${cert ? cert.days : '?'} 天后到期：${cert ? cert.host : ''}`,
    'maintenance.start': `🔧 计划维护开始：${win ? win.title : ''}`,
    'maintenance.end': `✅ 计划维护结束：${win ? win.title : ''}`,
    test: '🔔 Beacon Monitor 测试通知',
  };

  const lines = [];
  if (kind === 'monitor.down' || kind === 'monitor.up') {
    lines.push(kind === 'monitor.up' ? '服务已恢复正常访问。' : '服务检测失败，请及时处理。');
    lines.push(`站点：${monitor ? monitor.name : '—'}`);
    lines.push(`地址：${monitor ? monitor.url : '—'}`);
    lines.push(`时间：${fmtTime(ts)}`);
    if (result) {
      if (result.statusCode != null) lines.push(`状态码：${result.statusCode}`);
      if (result.latency != null) lines.push(`延迟：${result.latency}ms`);
      if (result.error) lines.push(`原因：${result.error}`);
    }
    if (ctx.mins != null && ctx.mins > 0) {
      lines.push(kind === 'monitor.up' ? `中断时长：约 ${ctx.mins} 分钟` : `持续：${ctx.mins} 分钟`);
    }
    if (ctx.repeat) lines[0] = '故障仍未恢复，继续提醒。';
  } else if (kind === 'cert.expiring') {
    lines.push(cert && cert.days < 0 ? '证书已经过期，HTTPS 会直接报错。' : '证书即将到期，请及时续签。');
    lines.push(`域名：${cert ? cert.host : '—'}`);
    if (cert) {
      lines.push(`剩余：${cert.days < 0 ? `已过期 ${Math.abs(cert.days)} 天` : `${cert.days} 天`}`);
      lines.push(`到期：${fmtTime(cert.expiresAt)}`);
      if (cert.issuer) lines.push(`签发：${cert.issuer}`);
    }
  } else if (kind === 'maintenance.start' || kind === 'maintenance.end') {
    lines.push(kind === 'maintenance.start' ? '进入计划维护期，期间检测异常不再告警。' : '维护窗口已结束，恢复正常告警。');
    if (win) {
      lines.push(`维护：${win.title}`);
      lines.push(`范围：${scopeText(win)}`);
      if (occ) {
        lines.push(`开始：${fmtTime(occ.start)}`);
        lines.push(`预计结束：${fmtTime(occ.end)}`);
      } else if (win.starts_at) {
        lines.push(`窗口：${fmtTime(win.starts_at)} ~ ${fmtTime(win.ends_at)}`);
      }
      if (win.note) lines.push(`说明：${win.note}`);
    }
    if (ctx.affected != null) lines.push(`影响监控：${ctx.affected} 个`);
  } else if (kind === 'test') {
    lines.push('这是一条测试通知，收到说明渠道配置正确。');
    lines.push(`时间：${fmtTime(ts)}`);
  }

  const level =
    ctx.level ||
    (kind === 'monitor.down' ? 'down' : kind === 'cert.expiring' ? (cert && cert.days <= 3 ? 'down' : 'warn') : 'info');

  return {
    kind,
    level,
    title: ctx.title || titleMap[kind] || kind,
    body: lines.filter(Boolean).join('\n'),
    ts,
    monitor,
    result,
    cert,
    window: win,
    refKey: ctx.refKey || (monitor ? `m:${monitor.id}` : win ? `w:${win.id}` : `k:${kind}`),
  };
}

function renderHtml(event) {
  return `<b>${escHtml(event.title)}</b>\n\n${escHtml(event.body)}`;
}

function renderPlain(event) {
  return `${event.title}\n${event.body}`;
}

module.exports = { LEVELS, KIND_LABEL, buildEvent, renderHtml, renderPlain, fmtTime, escHtml };
