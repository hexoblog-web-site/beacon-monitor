'use strict';

const {
  listMonitors,
  saveCheck,
  cleanup,
  getSetting,
  getMonitor,
  markDownSince,
  clearDownSince,
} = require('./db');
const { runHttpCheck, getCertInfo } = require('./checker');
const maintenance = require('./maintenance');
const notify = require('./notify');

const MAX_CONCURRENT = 6;
const nextRun = new Map();
const running = new Set();
let ticker = null;

function scheduleNext(monitor, delayMs) {
  const interval = Math.max(15, Number(monitor.interval_sec) || 60) * 1000;
  nextRun.set(monitor.id, Date.now() + (delayMs != null ? delayMs : interval));
}

function fire(kind, ctx, monitorId) {
  notify
    .dispatch(notify.buildEvent(kind, ctx), { monitorId })
    .catch((err) => console.warn('[notify] 通知发送失败:', err.message));
}

/**
 * 状态变化处理：
 * - 恢复：只在「上次是故障」时发一次，带中断时长
 * - 故障：翻转时发一次；持续故障按 alert_repeat_min 重复提醒
 * - 维护期由调用方拦截，不进入这里
 */
function handleResult(monitor, result, prevOk) {
  const now = result.ts || Date.now();

  if (result.ok) {
    const wasDown = prevOk === 0;
    const since = monitor.down_since;
    clearDownSince(monitor.id);
    if (wasDown) {
      const mins = since ? Math.max(1, Math.round((now - since) / 60000)) : null;
      fire('monitor.up', { monitor, result, mins }, monitor.id);
    }
    return;
  }

  markDownSince(monitor.id, now);

  // 首次检测就失败：不告警，避免新增监控立刻炸一条通知
  if (prevOk == null) return;

  if (prevOk !== 0) {
    fire('monitor.down', { monitor, result, mins: 0 }, monitor.id);
    return;
  }

  // 持续故障：翻转已完成，按间隔补提醒
  const repeatMin = Number(getSetting('alert_repeat_min'));
  if (!Number.isFinite(repeatMin) || repeatMin <= 0) return;
  const last = notify.lastNotifiedAt(monitor.id, 'monitor.down');
  if (!last || now - last < repeatMin * 60000) return;

  const since = monitor.down_since;
  const mins = since ? Math.max(1, Math.round((now - since) / 60000)) : null;
  fire('monitor.down', { monitor, result, mins, repeat: true }, monitor.id);
}

async function checkMonitor(monitor, { manual = false } = {}) {
  if (running.has(monitor.id)) return null;
  running.add(monitor.id);
  const prevOk = monitor.last_ok;
  try {
    const result = await runHttpCheck(monitor);
    const mw = maintenance.activeWindowFor(monitor, result.ts);

    // 维护期照常记录，但打标：不告警、不累计故障、不计入可用率
    saveCheck(monitor.id, result, { inMaint: Boolean(mw) });
    scheduleNext(monitor);

    // 预热证书信息缓存（异步，不影响检测结果）
    if (/^https:/i.test(monitor.url)) {
      getCertInfo(monitor.url).catch(() => {});
    }

    if (mw) {
      clearDownSince(monitor.id);
    } else {
      handleResult(monitor, result, prevOk);
    }

    const flag = mw ? 'MAINT' : result.ok ? 'UP   ' : 'DOWN ';
    console.log(
      `[check] ${flag} ${monitor.name.padEnd(12, ' ')} ${result.latency}ms ` +
        `${result.statusCode ?? '-'}${result.error ? ' ' + result.error : ''}${manual ? ' (手动)' : ''}`
    );
    return result;
  } catch (err) {
    console.warn(`[check] 检测异常 ${monitor.name}:`, err.message);
    return null;
  } finally {
    running.delete(monitor.id);
  }
}

function tick() {
  const monitors = listMonitors(true);
  const ids = new Set(monitors.map((m) => m.id));
  for (const id of nextRun.keys()) if (!ids.has(id)) nextRun.delete(id);

  const now = Date.now();
  for (const monitor of monitors) {
    if (running.size >= MAX_CONCURRENT) break;
    if (!nextRun.has(monitor.id)) {
      nextRun.set(monitor.id, now);
    }
    if (now < nextRun.get(monitor.id)) continue;
    if (running.has(monitor.id)) continue;
    // 先占位，避免同一轮重复触发
    nextRun.set(monitor.id, now + Math.max(15, monitor.interval_sec) * 1000);
    checkMonitor(monitor);
  }
}

function start() {
  if (ticker) return;
  // 启动后错峰发起首轮检测，避免瞬间打满
  listMonitors(true).forEach((m, i) => nextRun.set(m.id, Date.now() + i * 800));
  ticker = setInterval(tick, 3000);
  ticker.unref?.();

  const retentionTimer = setInterval(() => {
    try {
      const removed = cleanup(getSetting('retention_days'));
      if (removed) console.log(`[cleanup] 清理历史记录 ${removed} 条`);
    } catch (err) {
      console.warn('[cleanup] 清理失败:', err.message);
    }
  }, 6 * 3600 * 1000);
  retentionTimer.unref?.();

  maintenance.startWatcher();

  console.log('[scheduler] 已启动，最大并发 ' + MAX_CONCURRENT);
}

async function runNow(id) {
  const monitor = getMonitor(id);
  if (!monitor) return null;
  const result = await checkMonitor(monitor, { manual: true });
  return result;
}

module.exports = { start, runNow, checkMonitor };
