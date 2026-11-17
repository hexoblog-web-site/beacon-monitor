# 落地方案：维护窗口 + 多渠道通知 + 证书到期告警

> 目标版本：**v1.4.0**（当前 1.3.1，属新增特性，升 minor）
> 适用范围：beacon-monitor 现有架构（Node 20 + Express + better-sqlite3 单库）
> 设计原则：**不加新依赖、不加新进程、不改部署方式**；所有新表 `CREATE TABLE IF NOT EXISTS` 自动建，升级时只重建容器即可。

---

## 一、现状盘点（方案的事实基础）

| 能力 | 现状 | 缺口 |
|---|---|---|
| 表结构 | `monitors` / `checks` / `settings` / `discovery_ignored` + 友链三表 | 无维护窗口、无通知渠道（只有 `settings.webhook_url` 单值）、无证书状态 |
| 检测 | `scheduler.js` 每 3s tick，按 `interval_sec` 调度，`MAX_CONCURRENT=6` | 维护期内照常告警 |
| 告警 | `notifyStatusChange()` 只在 `last_ok` 翻转时发一次，按 URL 嗅探企业微信/Bark/飞书/钉钉 | 无 Telegram、无重试、无落库、无冷却、持续故障不重复提醒、重启即失忆 |
| 证书 | `checker.getCertInfo()` 返回 `{days, expiresAt, issuer, subject}`，内存缓存 6h；仅 `/api/status` 展示 | 只展示不告警 |
| 状态 | `statusOf()` → `up/slow/down/pending`；前台 `app.js` 用 `STATUS_TEXT` 映射 | 无 `maintenance` 状态 |

**两个必须同时解决的隐性问题**（否则维护窗口会带来新 bug）：

1. 维护期检测失败会写入 `checks`，**拉低 24h/7d/30d 可用率** —— 必须给 `checks` 加维护标记并在统计中排除。
2. 现在通知靠 `monitor.last_ok` 的上一轮值判断翻转，**重启后第一轮 `prevOk` 不为空但语义不明**，且无 `down_since`，无法表达"已持续故障 45 分钟" —— 加 `down_since` 列一并修掉。

---

## 二、总体设计

```
                     ┌──────────────────────────┐
  scheduler.tick ───▶│ 维护判定 maintenance.js  │──▶ in_maintenance?
                     └──────────────────────────┘
                                  │
                     ┌────────────▼─────────────┐
                     │ saveCheck(in_maint)      │  维护期照常检测（不能瞎），
                     └────────────┬─────────────┘  但告警被抑制、可用率不计数
                                  │
                     ┌────────────▼─────────────┐
                     │ notify/dispatch.js       │  统一事件总线：级别 + 作用域 + 冷却 + 去重 + 重试
                     └───┬──────────┬───────┬───┘
             ┌───────────┘          │       └────────────┐
      telegram.js            webhook.js        wecom/bark/feishu/dingtalk.js
                                  │
                     ┌────────────▼─────────────┐
                     │ notification_log 落库    │  后台可查、可重发、可诊断
                     └──────────────────────────┘

  certwatch.js（独立 6h 定时）──▶ cert_state ──▶ 阈值触发 ──▶ dispatch(cert.expiring)
```

**关键决策与理由**

| 决策 | 理由 |
|---|---|
| 维护窗口用独立表 + `scope`（all/group/monitor） | 要支持"整组站点迁服务器"这种计划维护，给 `monitors` 加字段表达不了 |
| 维护期**继续检测**、只抑制告警 | 若完全跳过检测，窗口结束时服务仍是坏的，反而更晚发现 |
| 维护期 `checks.in_maint=1`，统计排除 | 计划停机不算故障，可用率才可信 |
| 通知事件对象统一，渠道只负责渲染 | 新增渠道只写一个 `send(event)`，不碰业务 |
| 去重/冷却**落库**而非内存 | 容器重启后不会重复轰炸 |
| 证书按 **host** 而非 monitor 存 | 一个域名常被多个监控引用，避免同一张证书告警 N 次 |
| 证书阈值用「已提醒标记」而非"上次天数比较" | 天数只会降不会升，标记法在续期后可精确重置 |

---

## 三、表结构（DDL）

全部追加到 `server/db.js` 的 `db.exec(...)` 建表块中。

### 3.1 维护窗口

```sql
CREATE TABLE IF NOT EXISTS maintenance_window (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL DEFAULT '计划维护',
  -- 作用域：all=全站 / group=某分组 / monitor=单个监控
  scope       TEXT    NOT NULL DEFAULT 'all' CHECK (scope IN ('all','group','monitor')),
  group_name  TEXT,
  monitor_id  INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  -- 一次性窗口用 starts_at/ends_at；周期窗口用 rrule + duration_min，starts_at 为首次生效时间
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER,
  duration_min INTEGER,
  -- RRULE 子集：FREQ=DAILY|WEEKLY|MONTHLY;BYDAY=SU,MO;BYHOUR=3;BYMINUTE=0
  rrule       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  notify      INTEGER NOT NULL DEFAULT 1,   -- 是否推送「维护开始/结束」
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mw_scope   ON maintenance_window (scope, monitor_id, group_name);
CREATE INDEX IF NOT EXISTS idx_mw_starts  ON maintenance_window (starts_at);
```

> `ends_at` 与 `duration_min` 二选一：一次性窗口写 `ends_at`；周期窗口写 `duration_min`（每次持续多少分钟）。服务端做校验，避免出现两者皆空。

### 3.2 通知渠道

```sql
CREATE TABLE IF NOT EXISTS notify_channel (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'webhook'
              CHECK (type IN ('telegram','webhook','wecom','bark','feishu','dingtalk')),
  -- JSON：telegram {bot_token,chat_id,thread_id,parse_mode}
  --       webhook  {url,method,headers,secret,template}
  config      TEXT    NOT NULL DEFAULT '{}',
  scope       TEXT    NOT NULL DEFAULT 'all' CHECK (scope IN ('all','group','monitor')),
  group_name  TEXT,
  monitor_id  INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
  min_level   TEXT    NOT NULL DEFAULT 'down' CHECK (min_level IN ('down','warn','info')),
  active      INTEGER NOT NULL DEFAULT 1,
  cooldown_sec INTEGER NOT NULL DEFAULT 300,   -- 同渠道+同监控+同类别事件的静默期
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ch_active ON notify_channel (active);
```

### 3.3 通知日志（去重依据 + 审计）

```sql
CREATE TABLE IF NOT EXISTS notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER,
  monitor_id  INTEGER,
  kind        TEXT    NOT NULL,   -- monitor.down / monitor.up / cert.expiring /
                                  -- maintenance.start / maintenance.end / test
  level       TEXT    NOT NULL,   -- info / warn / down
  title       TEXT,
  body        TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nlog_monitor ON notification_log (monitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nlog_lookup  ON notification_log (channel_id, kind, monitor_id, created_at DESC);
```

### 3.4 证书状态

```sql
CREATE TABLE IF NOT EXISTS cert_state (
  host         TEXT PRIMARY KEY,
  monitor_id   INTEGER,              -- 首次发现该 host 的监控（仅作参考）
  subject      TEXT,
  issuer       TEXT,
  expires_at   INTEGER,
  days         INTEGER,
  last_check   INTEGER,
  -- 已提醒过的天数阈值，逗号串，如 "30,14,7"，续期后清空
  notified_marks TEXT NOT NULL DEFAULT '',
  last_error   TEXT
);
```

### 3.5 存量表迁移（`server/db.js` 内，沿用现有 `migrate()` 的 PRAGMA 探列写法）

```js
// monitors: 记录本次故障开始时间，用于「持续故障 N 分钟」文案
if (!cols.includes('down_since')) {
  db.exec('ALTER TABLE monitors ADD COLUMN down_since INTEGER');
}

// checks: 标记该次检测发生在维护窗口内，统计时排除
const checkCols = db.prepare('PRAGMA table_info(checks)').all().map(c => c.name);
if (!checkCols.includes('in_maint')) {
  db.exec('ALTER TABLE checks ADD COLUMN in_maint INTEGER NOT NULL DEFAULT 0');
}
```

### 3.6 新增 settings 默认值（`DEFAULT_SETTINGS`）

```js
notify_enabled:      '1',
alert_repeat_min:    '30',              // 持续故障重复提醒间隔，0=只在翻转时提醒
cert_alert_enabled:  '1',
cert_alert_days:     '30,14,7,3,1',     // 过期前多少天提醒
cert_check_hours:    '6',
maint_timezone:      'Asia/Shanghai',   // 仅用于周期窗口按本地时间展开
```

---

## 四、接口清单

### 4.1 维护窗口（后台）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/maintenance` | 列表，附 `state`（active/upcoming/past）与 `next_at` |
| POST | `/api/admin/maintenance` | 新建 |
| PUT | `/api/admin/maintenance/:id` | 修改（含 `active` 开关） |
| DELETE | `/api/admin/maintenance/:id` | 删除 |
| GET | `/api/admin/maintenance/preview?scope=&monitor_id=&group_name=` | 试算当前/未来 3 个窗口，新建前先看效果 |

**POST 请求体**

```json
{
  "title": "服务器迁移",
  "scope": "group",
  "group_name": "站点",
  "starts_at": 1763424000000,
  "ends_at": 1763431200000,
  "notify": true,
  "note": "迁到新机器，预计 2 小时"
}
```

周期示例（每周日 03:00 维护 30 分钟）：

```json
{
  "title": "每周例行备份",
  "scope": "all",
  "starts_at": 1763424000000,
  "rrule": "FREQ=WEEKLY;BYDAY=SU;BYHOUR=3;BYMINUTE=0",
  "duration_min": 30
}
```

**响应**

```json
{
  "window": {
    "id": 3, "title": "服务器迁移", "scope": "group", "group_name": "站点",
    "monitor_id": null, "starts_at": 1763424000000, "ends_at": 1763431200000,
    "rrule": null, "duration_min": null, "active": 1, "notify": 1,
    "state": "upcoming", "next_at": 1763424000000
  }
}
```

校验规则（`400` + `{error}`）：
- `starts_at` 必填，且 `< ends_at`（一次性）或 `duration_min ∈ [5, 10080]`（周期）
- 一次性窗口跨度 ≤ 90 天；`starts_at` 允许过去时间（用于补录）
- `scope='monitor'` 必须有存在且未删除的 `monitor_id`
- `scope='group'` 必须有 `group_name`
- `rrule` 只允许 `FREQ=DAILY|WEEKLY|MONTHLY` + `BYDAY/BYHOUR/BYMINUTE/BYMONTHDAY`，出现 `COUNT`/`UNTIL` 直接拒绝（避免无限展开歧义）

### 4.2 通知渠道（后台）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/notify/channels` | 列表（**密钥脱敏**，见下） |
| POST | `/api/admin/notify/channels` | 新建 |
| PUT | `/api/admin/notify/channels/:id` | 修改 |
| DELETE | `/api/admin/notify/channels/:id` | 删除 |
| POST | `/api/admin/notify/channels/:id/test` | 发一条测试消息，返回真实状态码/耗时 |
| GET | `/api/admin/notify/logs?limit=50&monitor_id=&kind=` | 最近通知记录 |

**Telegram 渠道请求体**

```json
{
  "name": "我的 Telegram",
  "type": "telegram",
  "config": { "bot_token": "123456:ABC-DEF...", "chat_id": "-1001234567890", "thread_id": null },
  "scope": "all",
  "min_level": "down",
  "cooldown_sec": 300,
  "active": true
}
```

**通用 Webhook 请求体**

```json
{
  "name": "自建中转",
  "type": "webhook",
  "config": {
    "url": "https://example.com/hook",
    "method": "POST",
    "headers": { "Authorization": "Bearer xxx" },
    "secret": "用于 HMAC 签名，可空",
    "template": null
  },
  "min_level": "warn",
  "cooldown_sec": 600
}
```

**测试响应**

```json
{ "ok": true, "statusCode": 200, "latencyMs": 187, "channel": { "id": 2, "last_ok_at": 1763424123456 } }
```

失败时 `{ "ok": false, "statusCode": 401, "error": "Unauthorized: invalid bot token" }`（HTTP 仍为 200，便于前端展示细节）。

**密钥脱敏规则**（GET 与任何回显）：
- `telegram.bot_token` → `123456:****`（保留冒号前 bot id）
- `webhook.url` 中 `?key=`/`?token=`/`?secret=` 的值 → `****`
- `webhook.headers` 中的 `authorization`/`x-api-key`/`cookie` → `****`
- PUT 时收到 `"****"` 或字段缺失 → **保留原值**，不覆盖

### 4.3 证书（后台）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/cert` | 全部 host 证书状态，按剩余天数升序 |
| POST | `/api/admin/cert/check` | 立即刷新（`force` 绕过 6h 缓存），返回刷新结果 |

**GET 响应**

```json
{
  "enabled": true,
  "thresholds": [30, 14, 7, 3, 1],
  "items": [
    { "host": "beacon.manimblog.cn", "monitorName": "Beacon 后台", "days": 87,
      "expiresAt": 1771000000000, "issuer": "ZeroSSL", "subject": "beacon.manimblog.cn",
      "level": "ok", "notifiedMarks": "30", "lastCheck": 1763424000000 }
  ]
}
```

### 4.4 公开接口变更

| 路径 | 变更 |
|---|---|
| `GET /api/status` | 每个 monitor 增加 `maintenance: {active, title, until, startsAt}` 与 `rawStatus`；`status` 可为 `"maintenance"`；`summary` 增加 `maintenance` 计数（**不计入 down**） |
| `GET /api/e/maintenance.json` | **新增**：当前与未来 24h 的维护窗口，供博客/状态页显示横幅 |
| `GET /api/summary.json` | 增加 `maintenance` 字段 |
| `GET /api/badge.svg` | 新增 `maintenance` 配色（蓝灰 `#2563eb`），`?label=` 行为不变 |
| `GET /api/monitors/:id/history` | 返回的 bucket 不含维护期数据（uptime 计算已排除） |

```json
// GET /api/e/maintenance.json
{
  "active": [
    { "title": "服务器迁移", "scope": "group", "group_name": "站点",
      "startsAt": 1763424000000, "endsAt": 1763431200000,
      "monitorIds": [1, 2, 5] }
  ],
  "upcoming": [
    { "title": "每周例行备份", "scope": "all", "startsAt": 1764028800000, "endsAt": 1764030600000 }
  ],
  "updatedAt": 1763424300000
}
```

---

## 五、核心逻辑

### 5.1 维护判定（`server/maintenance.js`）

```js
/** 该监控在 ts 时刻是否处于维护窗口，返回命中的窗口或 null */
function activeWindowFor(monitor, ts = Date.now()) {
  const rows = stmtActive.all();               // active=1，按 scope 过滤，走索引
  for (const w of rows) {
    if (!matchScope(w, monitor)) continue;
    if (occurrenceCovers(w, ts)) return w;
  }
  return null;
}
```

`occurrenceCovers` 两种分支：

```js
// 一次性
if (!w.rrule) return ts >= w.starts_at && ts < (w.ends_at || w.starts_at + 3600_000);

// 周期：以 starts_at 为锚点，按 FREQ 展开到 ts 所在的那一天，再比较
const dur = (w.duration_min || 60) * 60_000;
const occ = occurrenceStart(w, ts);   // DAILY: 当天 HH:mm；WEEKLY: BYDAY 命中才返回；MONTHLY: BYMONTHDAY
return occ != null && ts >= occ && ts < occ + dur;
```

- 周期展开按 `settings.maint_timezone` 换算，不依赖容器 TZ（避免部署环境不同导致窗口漂移）
- `occurrenceStart` 内部用 `Date` + 固定 UTC 偏移计算，**不引入 dayjs/moment**

### 5.2 检测与告警抑制（`server/scheduler.js`）

```js
async function checkMonitor(monitor, { manual = false } = {}) {
  const prevOk = monitor.last_ok;
  const result = await runHttpCheck(monitor);

  const mw = maintenance.activeWindowFor(monitor, result.ts);
  saveCheck(monitor.id, result, { inMaint: Boolean(mw) });   // 照常记录，但要打标
  scheduleNext(monitor);

  if (mw) {
    db.clearDownSince(monitor.id);      // 维护期内不累计故障时长，也不发 down
    return result;                       // 恢复事件同样不发（避免"维护中恢复"噪音）
  }

  const wasDown = prevOk === 0;
  if (result.ok && wasDown) {
    const mins = downMinutes(monitor);
    db.clearDownSince(monitor.id);
    dispatch(buildEvent('monitor.up', { monitor, result, mins }));
  } else if (!result.ok) {
    db.markDownSince(monitor.id, result.ts);   // 仅首次写入，COALESCE 保证不覆盖
    if (!wasDown) {
      dispatch(buildEvent('monitor.down', { monitor, result, mins: 0 }));
    } else if (shouldRepeat(monitor, result.ts)) {
      dispatch(buildEvent('monitor.down', { monitor, result, mins: downMinutes(monitor), repeat: true }));
    }
  }
}
```

**注意保留原有语义**：`prevOk === null`（首次检测）时**不发任何通知**，避免新加监控就告警。

`shouldRepeat`：`settings.alert_repeat_min` > 0 且 `now - 该 monitor 最近一次 kind='monitor.down' 且 ok=1 的日志时间 ≥ 间隔`。

### 5.3 通知分发（`server/notify/dispatch.js`）

```js
async function dispatch(event, { monitorId = null } = {}) {
  if (getSetting('notify_enabled') !== '1') return [];
  const channels = listChannels().filter((c) =>
    c.active && matchScope(c, monitorRef) && LEVELS[c.min_level] <= LEVELS[event.level]
  );
  const results = [];
  for (const ch of channels) {
    if (await inCooldown(ch, event, monitorId)) continue;   // 查 notification_log
    const sent = await sendWithRetry(ch, event);            // 8s 超时 + 2 次退避重试
    logNotification(ch, event, sent, monitorId);
    updateChannelHealth(ch, sent);
    results.push({ channelId: ch.id, ...sent });
  }
  return results;
}
```

**重试策略**

| 情况 | 行为 |
|---|---|
| 网络错误 / 5xx | 重试 2 次，退避 400ms、1200ms |
| 4xx（401/403/404） | 不重试，直接记 `last_error` |
| 429 | 读 `retry_after`（Telegram）或 `Retry-After` 头，等待后重试 1 次 |
| 超时 8s | 按网络错误处理 |

**冷却判定**（同渠道 + 同监控 + 同 `kind`）：

```sql
SELECT 1 FROM notification_log
 WHERE channel_id=? AND kind=? AND COALESCE(monitor_id,0)=?
   AND ok=1 AND created_at > ?
 LIMIT 1
```

冷却期内**不写日志**（否则会污染"最近告警时间"），仅 `console.log` 一行 skip 原因。

### 5.4 Telegram 适配器（`server/notify/channels/telegram.js`）

```js
async function send(channel, event) {
  const { bot_token, chat_id, thread_id, parse_mode = 'HTML' } = channel.config;
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
  const text = renderTelegram(event);            // HTML parse_mode
  const body = {
    chat_id,
    text: text.slice(0, 4000),
    parse_mode,
    disable_web_page_preview: true,
    ...(thread_id ? { message_thread_id: Number(thread_id) } : {}),
  };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return { ok: false, statusCode: res.status, error: data.description || `HTTP ${res.status}` };
  }
  return { ok: true, statusCode: 200 };
}
```

要点：
- 转义仅需 `& < >`（HTML 模式），`renderTelegram` 用 `esc()` 统一处理，避免站点名含 `&` 导致 400
- 超过 4096 字符截断（本站文案约 300 字，够用）
- `chat_id` 支持 `@channelusername` 与数字 ID（数字含负号为群组，不要 `Number()` 强转）

消息样式：

```
🔴 <b>Blog 首页 访问异常</b>

站点：Blog 首页
地址：https://www.manimblog.cn/
时间：2026-11-18 06:42:31
状态码：502
延迟：3821ms
原因：状态码 502 不符合预期（200-399）
持续：12 分钟
```

### 5.5 通用 Webhook 适配器（`server/notify/channels/webhook.js`）

默认发送完整事件对象，方便对接任意自动化（n8n、自建中转、Server 酱等）：

```json
{
  "event": "monitor.down",
  "level": "down",
  "title": "🔴 Blog 首页 访问异常",
  "body": "站点：...\n地址：...",
  "monitor": { "id": 1, "name": "Blog 首页", "url": "https://..." },
  "result": { "ok": false, "statusCode": 502, "latency": 3821, "error": "..." },
  "ts": 1763424151000
}
```

- 配了 `template` 时按 `{{title}}` / `{{body}}` / `{{event}}` / `{{monitor.name}}` 做字符串替换（**只替换，不求值**，防注入）
- 配了 `secret` 时加头 `X-Beacon-Signature: sha256=<hmac(secret, rawBody)>`
- **保留现有 URL 嗅探适配器**（企业微信/Bark/飞书/钉钉）作为独立 `type`，代码从 `scheduler.js` 整体搬到 `channels/` 下

### 5.6 证书巡检（`server/certwatch.js`）

```js
async function scanCertificates({ force = false } = {}) {
  if (getSetting('cert_alert_enabled') !== '1') return { scanned: 0 };
  const targets = db.prepare(`
    SELECT url, MIN(id) AS monitor_id, MIN(name) AS monitor_name
      FROM monitors WHERE active = 1 AND url LIKE 'https://%' GROUP BY url
  `).all();
  // 再按 host 去重，一个 host 只查一次
  for (const t of byHost(targets)) {
    const info = await getCertInfo(t.url, { force });   // force 绕过 6h 内存缓存
    const prev = getCertState(t.host);
    upsertCertState(t, info);
    if (!info) continue;
    if (prev && prev.expires_at && info.expiresAt > prev.expires_at) {
      clearMarks(t.host);      // 已续期，重置标记
    }
    const crossed = thresholds().filter(d => info.days <= d && !marks.includes(d));
    if (!crossed.length) continue;
    const level = info.days <= 3 ? 'down' : 'warn';
    await dispatch(buildEvent('cert.expiring', { host: t.host, info, level, monitor: t }));
    addMarks(t.host, crossed);
  }
}
```

- 定时：`setInterval(scanCertificates, cert_check_hours * 3600_000)`，启动后延迟 90 秒首跑（避开首轮检测高峰）
- **一次只报最紧急的那一档**：若同时跨过 30/14/7，只按 `days` 报一条，但把已跨过的阈值全部写入 `notified_marks`，避免补发一串
- 证书已过期（`days < 0`）走 `level='down'`，文案明确「已过期 N 天」
- 握手失败（`info === null`）记 `last_error`，**不告警**（避免网络抖动误报），连续 3 次失败才按 `warn` 报一次

---

## 六、代码改动清单

### 新增

| 文件 | 行数估算 | 职责 |
|---|---|---|
| `server/maintenance.js` | ~220 | 窗口 CRUD、`activeWindowFor`、rrule 子集展开、`/preview` 试算 |
| `server/notify/index.js` | ~90 | `buildEvent`、`dispatch`、渠道 CRUD、脱敏、日志查询 |
| `server/notify/format.js` | ~90 | 事件 → 标题/正文；HTML/Markdown 转义 |
| `server/notify/channels/telegram.js` | ~70 | Telegram 适配器 |
| `server/notify/channels/webhook.js` | ~80 | 通用 Webhook + HMAC |
| `server/notify/channels/legacy.js` | ~70 | 企微/Bark/飞书/钉钉（从 scheduler 平移） |
| `server/certwatch.js` | ~140 | 证书巡检与阈值告警 |

### 修改

| 文件 | 改动 |
|---|---|
| `server/db.js` | 4 张新表 + `monitors.down_since` / `checks.in_maint` 迁移 + `DEFAULT_SETTINGS` 补充 + `saveCheck` 支持 `inMaint` + `uptimeSince`/`history` 排除维护期 + `markDownSince`/`clearDownSince` |
| `server/checker.js` | `getCertInfo(url, { force })` 支持绕过缓存 |
| `server/scheduler.js` | 接入维护判定与抑制、持续故障重复提醒、调用 `dispatch`、启动 certwatch |
| `server/index.js` | 新增 12 个后台路由 + `/api/e/maintenance.json`；`buildPublicMonitor` 注入 `maintenance`/`rawStatus`；`statusOf` 结果叠加维护态；badge 加色 |
| `public/admin.html` | 3 张卡片：维护窗口（列表+表单）、通知渠道（列表+表单+测试按钮）、证书（列表+立即检查） |
| `public/assets/admin.js` | 对应 CRUD 与渲染；导航增加三个锚点 |
| `public/assets/admin.css` | `.mw-active` / `.ch-bad` / `.cert-warn` / `.cert-bad` 等状态样式 |
| `public/assets/app.js` | `STATUS_TEXT` 加 `maintenance: '计划维护'`；卡片加 `is-maint` 类；hero 统计加维护计数 |
| `public/assets/app.css` | `.pill-maintenance` / `.card.is-maint` / `.hb-bar.maint` |
| `package.json` | `version` → `1.4.0` |
| `README.md` | 功能表 + 新配置项 + `/api/e/maintenance.json` 用法 |

### 兼容旧配置

`settings.webhook_url` 保留不删。启动时一次性迁移：

```js
if (getSetting('notify_migrated') !== '1' && (getSetting('webhook_url') || '').trim()) {
  createChannel({ name: '旧版 Webhook', type: detectLegacyType(url), config: { url }, min_level: 'down' });
  setSetting('notify_migrated', '1');
}
```

`PUT /api/admin/settings` 仍接受 `webhook_url`（写入后同步到迁移渠道），保证老用户不改配置也继续收到告警。

---

## 七、分期与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0**（半天） | 建表迁移 + `maintenance.js` + 调度抑制 + `checks.in_maint` 统计排除 + 状态展示 | 建一个 10 分钟窗口 → 手动 `POST /api/admin/monitors/:id/check` 造失败 → **不发通知**、`/api/status` 显示"计划维护"、30d 可用率不变 |
| **P1**（1 天） | 渠道表 + `dispatch` + Telegram + 通用 Webhook + 测试按钮 + 日志 | 后台填 bot token → 点「测试」收到消息；拔掉一个监控 → 只收 1 条 down、恢复收 1 条 up、重启容器不重发 |
| **P2**（半天） | `certwatch.js` + 阈值 + 后台证书页 | 把 `cert_alert_days` 设为 `3650` 触发一次告警，`notified_marks` 写入，再跑不重复 |
| **P3**（可选） | 周期窗口 UI、通知日志页、维护横幅组件 | 能配「每周日 3 点」并生效 |

**本地验证命令**

```bash
cd beacon-monitor
DATA_DIR=.tmp-data ADMIN_PASSWORD=test1234 node server/index.js
# 另开一窗
curl -s -X POST localhost:8080/api/admin/login -H 'content-type: application/json' \
  -d '{"password":"test1234"}' -c /tmp/ck
curl -s -b /tmp/ck -X POST localhost:8080/api/admin/maintenance \
  -H 'content-type: application/json' \
  -d '{"title":"测试","scope":"all","starts_at":'$(date +%s000)'","ends_at":'$(( $(date +%s) + 600 ))000'}'
curl -s localhost:8080/api/status | head -c 600
```

---

## 八、风险与边界

| 风险 | 处理 |
|---|---|
| 维护期完全抑制告警，窗口结束仍故障 | 窗口结束后的第一次检测若失败会正常发 down（`wasDown` 为真但 `down_since` 已在维护期清除，等价于新故障） |
| 容器 TZ 与用户时区不一致导致周期窗口漂移 | 周期展开显式用 `settings.maint_timezone` 计算，不依赖 `process.env.TZ`；建议 compose 补 `TZ=Asia/Shanghai` |
| Telegram 429 限流 | 单渠道串行发送（`for...of`），全局并发上限 2；429 按 `retry_after` 退避 |
| 通知日志膨胀 | `cleanup()` 顺带清理 30 天前 `notification_log`（与 `retention_days` 独立，固定 30 天） |
| 密钥明文存 SQLite | 与现有 `ADMIN_PASSWORD` 同级别（库文件在数据卷内），接口层全部脱敏；文档标注"勿提交数据库文件" |
| 同一 host 多监控重复告警 | `cert_state` 按 host 唯一，一个 host 一轮只报一次 |
| rrule 无 `COUNT/UNTIL` 会无限存在 | 展开只算「当前时刻」与「未来 3 次」，不物化历史；`active=0` 可停 |

---

## 九、与 Uptime Kuma 的取舍说明

本方案只取「投入产出比高」的三项，明确**不做**：Push 心跳监控（另开 P4，实现极简但需要独立 URL 与 dead-man 语义）、浏览器引擎检测、Globalping 多地域探测。理由：个人博客场景的真实痛点顺序是「计划停机别误报 → 坏了能第一时间知道 → 证书别过期」，这三项正好覆盖前 80% 的体验。
