# msg-relay-service

万能消息中转后台（MVP）：支撑 **Grok Bot** 消息的接收、存储与可选转发，并支持**多 Bot 出站推送**（每个 Bot 有稳定 `id`，对应 Cursor Automations Webhook URL + Bearer Key）。本地或长驻客户端可通过 **WebSocket** 与中转站双向通信（HTTP 触发下发、WS 回传结果）。另外提供一条独立的**优先消息队列**（如胖猫社区卡片）：可落盘，订阅者离线时仍然入队。日志与队列均为本地 JSONL，无 Redis / BullMQ / PostgreSQL。

## 技术栈

- Node.js 20+、TypeScript、Fastify
- Docker

## 环境变量

复制 `.env.example` 为 `.env` 并按需修改：

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 监听端口，默认 `3000` |
| `RELAY_SECRET` | 是 | 鉴权密钥；HTTP 支持 `Authorization: Bearer <secret>` 或 `X-Relay-Secret`；WebSocket 连接使用查询参数 `token`（见下文） |
| `FORWARD_URL` | 否 | 配置后，`POST /webhook/grokbot` 会将统一 Message 转发到此 URL |
| `DEFAULT_BOT_ID` | 否 | `/push/grokbot` 别名指向的 bot id，默认 `task-os` |
| `BOTS_JSON` | 否 | JSON 字符串，按 bot id 配置 `webhookUrl` / `webhookKey`（见下方示例） |
| `BOTS_CONFIG_PATH` | 否 | bots 配置文件路径；未设置时使用 `DATA_DIR/bots.json` |
| `GROKBOT_WEBHOOK_URL` | 否 | **兼容旧部署**：当默认 bot（`task-os`）未配置 `webhookUrl` 时，作为其出站 Webhook |
| `GROKBOT_WEBHOOK_KEY` / `GROKBOT_WEBHOOK_AUTH` | 否 | 与上配套的 Bearer Token（二者等价，任选其一） |
| `DATA_DIR` | 否 | 数据目录，默认 `data` |
| `PRIORITY_SOURCES_PATH` | 否 | 优先队列来源白名单，默认 `DATA_DIR/priority-sources.json`。文件不存在时仅允许 `pangmao` |
| `PRIORITY_QUEUE_FILE` | 否 | 优先队列 JSONL，默认 `DATA_DIR/priority-queue.jsonl` |

### 预置 Bot 注册表（稳定 id）

| id | 显示名 |
|----|--------|
| `task-os` | 任务管家 |
| `inspiration` | 灵感随笔 |
| `content` | 资讯创作官 |
| `trading` | 交易观察员 |
| `code` | 代码大师 |
| `overseas` | 出海大师 |
| `internet` | 互联网大咖 |
| `jokes` | 段子大师 |
| `ai-ops` | 如何用好AI |

启动时会合并：`bots.example.json` 仅作模板；实际配置来自 `BOTS_JSON` 和/或 `data/bots.json`（勿将含真实密钥的文件提交到 Git）。可参考仓库根目录的 `bots.example.json`。

`BOTS_JSON` 示例（对象或数组均可）：

```json
{
  "task-os": {
    "webhookUrl": "https://your-automation.example/hooks/task-os",
    "webhookKey": "paste-bearer-token-here"
  },
  "code": {
    "webhookUrl": "https://your-automation.example/hooks/code",
    "webhookKey": "another-token"
  }
}
```

## 本地启动

```bash
npm install
export RELAY_SECRET=dev-secret
npm run build
npm start
```

开发模式（热重载）：

```bash
npm run dev
```

测试：

```bash
npm test
```

## Docker

```bash
docker build -t msg-relay-service .
docker run --rm -p 3000:3000 \
  -e RELAY_SECRET=dev-secret \
  -v "$(pwd)/data:/app/data" \
  msg-relay-service
```

## 统一 Message 结构

```json
{
  "traceId": "uuid",
  "source": "grokbot:task-os",
  "type": "event",
  "payload": {},
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

出站推送的 `source` 为 `grokbot:<botId>`。存储记录额外包含 `status`（`received` | `forwarded` | `failed`）、`updatedAt`，失败时可能有 `error`。

## HTTP 接口

### `GET /health`

健康检查。

```bash
curl -s http://localhost:3000/health | jq
```

### `GET /bots`

列出已注册的 bot（需鉴权）。返回 `id`、`name`、`configured`（是否已配置 `webhookUrl`），**不返回** URL 或密钥。

```bash
curl -s http://localhost:3000/bots \
  -H "Authorization: Bearer dev-secret" | jq
```

### `POST /webhook/grokbot`

Grok Bot（或其它上游）回调入口：鉴权 → 归一化为 Message → 写入 JSONL → 若配置了 `FORWARD_URL` 则转发。

```bash
curl -s -X POST http://localhost:3000/webhook/grokbot \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"chat","payload":{"text":"hello"}}' | jq
```

或使用请求头鉴权：

```bash
curl -s -X POST http://localhost:3000/webhook/grokbot \
  -H "X-Relay-Secret: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"chat","payload":{"text":"hello"}}' | jq
```

### `POST /push/:botId`

向外推送到指定 bot：鉴权 → 若 bot 未知返回 **404**；若已知但未配置 `webhookUrl` 返回 **422**（**不写入** JSONL，便于调用方立即重试配置）；已配置则生成 Message、写入 JSONL，并向该 bot 的 Webhook `POST`，请求头 `Authorization: Bearer <webhookKey>`（未配置 key 时不带 Bearer 头）。

```bash
curl -s -X POST http://localhost:3000/push/task-os \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"notify","payload":{"user":"u1","text":"hi"}}' | jq
```

### `POST /push/grokbot`

与 `POST /push/<DEFAULT_BOT_ID>` 相同，默认 `DEFAULT_BOT_ID=task-os`。仍支持仅设置 `GROKBOT_WEBHOOK_URL`（及可选 `GROKBOT_WEBHOOK_KEY`）的旧部署方式。

```bash
curl -s -X POST http://localhost:3000/push/grokbot \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"notify","payload":{"user":"u1","text":"hi"}}' | jq
```

### `GET /status/:traceId`

按 `traceId` 查询最近一次状态。

```bash
curl -s http://localhost:3000/status/<traceId> | jq
```

## WebSocket 本地客户端通道

用于让 **Grok Bot / 上游 HTTP 调用方** 通过中转站触达本机或内网长连接客户端，并由客户端经 WS 回传结果。不引入消息队列：客户端离线时 `POST /push-local` 返回 **503**（`client_offline`），可选在 JSONL 中记录 `failed`。

### 连接

- **URL**：`ws://<host>:<port>/ws?token=<RELAY_SECRET>&clientId=<唯一客户端ID>`
- **可选**：`&botId=<botId>` — 注册默认转发目标；客户端帧里也可再指定 `botId` / `forwardToBot` 覆盖。
- **鉴权**：仅使用查询参数 `token`（与 `RELAY_SECRET` 相同）。无效 `token` 时连接以 WebSocket 关闭码 `1008` 结束。

连接成功后服务端会发送一帧：

```json
{"type":"connected","clientId":"my-laptop","botId":null,"time":"2026-10-12T00:00:00.000Z"}
```

### 服务端 → 客户端（HTTP 触发）

`POST /push-local/:clientId`（需 HTTP 鉴权，与 `/push` 相同）

```bash
curl -s -X POST http://localhost:3000/push-local/my-laptop \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"task","payload":{"cmd":"sync-notes"}}' | jq
```

- 客户端**在线**：**202**，`status: forwarded`；经 WS 下发统一 Message 形状：

```json
{
  "traceId": "uuid",
  "source": "push-local:my-laptop",
  "type": "task",
  "payload": {"cmd": "sync-notes"},
  "createdAt": "2026-10-12T00:00:00.000Z"
}
```

- 客户端**离线**：**503**，`error: client_offline`（仍会生成 `traceId` 并写入 JSONL，`status: failed`）。

Grok Bot 或其它自动化可在需要调用本机工具时请求 `push-local`，而不是直接访问内网。

### 客户端 → 服务端（WS 帧）

发送 JSON 文本帧，例如：

```json
{
  "type": "result",
  "traceId": "<与下发任务相同的 traceId，可选>",
  "payload": {"ok": true, "data": {}},
  "botId": "code"
}
```

- 归一化为 Message（`source`: `ws:<clientId>`），追加 JSONL。
- 若存在 `botId` / `forwardToBot` 或连接时带了 `botId`，且该 bot 已配置 webhook，则复用与 `POST /push/:botId` 相同的出站转发逻辑（`source`: `ws-forward:<botId>`）。
- 服务端回复：`{"type":"ack","traceId":"...","status":"received|forwarded|failed","forwardStatus":...}`

### 重连建议（本地客户端）

1. 使用稳定 `clientId`（如主机名 + 用途）。
2. `token` 失效或网络断开时指数退避重连；新连接会替换同 `clientId` 的旧连接。
3. 处理 `push-local` 下发的 `traceId`，在结果帧中带回便于 `GET /status/:traceId` 对账。
4. 离线期间的任务不会被队列缓存；调用方收到 503 后自行重试或降级。

### `GET /ws/clients`

列出当前已连接的 WS 客户端（需 HTTP 鉴权），返回 `clientId`、`botId`、`connectedAt`。

```bash
curl -s http://localhost:3000/ws/clients \
  -H "Authorization: Bearer dev-secret" | jq
```

### 手动冒烟测试

```bash
# 终端 1：启动服务
export RELAY_SECRET=dev-secret
npm run dev

# 终端 2：模拟本地客户端（需 npx wscat 或自写脚本）
npx --yes wscat -c "ws://localhost:3000/ws?token=dev-secret&clientId=smoke-1"

# 终端 3：下发任务
curl -s -X POST http://localhost:3000/push-local/smoke-1 \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"ping","payload":{"n":1}}' | jq
```

在 wscat 中应看到下发帧；回发 `{"type":"result","payload":{"ok":true}}` 后，检查 `data/messages.jsonl` 与 `ack` 帧。

## 优先消息队列

与 `GET /ws`、`POST /push-local/:clientId` **分开**。`/ws` 仍是在线双向中继：客户端不在线时 `push-local` 返回 **503** `client_offline`，不排队。优先队列用来保存重要卡片（例如胖猫社区消息），没有订阅者时入队也成功，稍后仍可拉取或回放。

持久化文件为 `data/priority-queue.jsonl`（可用 `PRIORITY_QUEUE_FILE` 覆盖）。进程内只保留最近 **1000** 条索引（`PRIORITY_MEMORY_CAP`）。更早的行仍在 JSONL 中，但 HTTP 列表和 WebSocket 回放只覆盖这 1000 条窗口。单次列表 / 回放默认 **50** 条，最多 **200** 条。

### 来源白名单

启动时读取 `DATA_DIR/priority-sources.json`（或 `PRIORITY_SOURCES_PATH`）。文件不存在时，允许列表只有：

| id | 名称 |
|----|------|
| `pangmao` | 胖猫社区 |

仓库根目录的 `priority-sources.example.json` 是模板。增加来源时复制为 `data/priority-sources.json` 并编辑 `sources`，然后**重启进程**。这是配置变更，不需要改代码。文件存在时**整体替换**内置默认值（请在文件里保留仍要使用的来源）。未知 `source` 返回 **422** `unknown_source`，**不会**写入 JSONL。

### `POST /queue/priority`

鉴权与其它 HTTP 写接口相同（`Authorization: Bearer <RELAY_SECRET>` 或 `X-Relay-Secret`）。

```bash
curl -s -X POST http://localhost:3000/queue/priority \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "pangmao",
    "card": {"title": "示例", "body": "卡片正文"},
    "meta": {"via": "ocr", "yield_pct": 1.25}
  }' | jq
```

`card` 是不透明 JSON 对象，按原样保存。`meta.via` 只能是 `"ocr"` 或 `"text"`。`meta.yield_pct` 必须是有限数字或 `null`。

成功：**202**

```json
{ "id": "uuid", "source": "pangmao", "createdAt": "2026-01-01T00:00:00.000Z" }
```

没有 WebSocket 订阅者时同样返回 202。校验失败（缺字段、`card` 不是对象）为 **422** `invalid_body`。

### `GET /queue/priority`

鉴权后查看内存窗口里的最近记录，不返回密钥。`source` 可选；给出时必须在白名单内，否则 **422**。`limit` 默认 50，大于 200 时截断为 200。结果按时间从旧到新，是「最近 N 条」而不是全量历史。

```bash
curl -s "http://localhost:3000/queue/priority?source=pangmao&limit=50" \
  -H "Authorization: Bearer dev-secret" | jq
```

```json
{
  "items": [
    {
      "id": "uuid",
      "source": "pangmao",
      "card": {},
      "meta": { "via": "ocr", "yield_pct": null },
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /queue/priority/sources`

鉴权后返回当前白名单，只有 `id` 和 `name`。

```bash
curl -s http://localhost:3000/queue/priority/sources \
  -H "Authorization: Bearer dev-secret" | jq
```

### `GET /ws/priority`

订阅优先队列。可有多个订阅者。入队不依赖是否有人在线。

- **URL**：`ws://<host>:<port>/ws/priority?token=<RELAY_SECRET>`
- **可选** `source`：省略则订阅全部已允许来源；填写时必须在白名单内，否则连接以关闭码 `1008`、原因 `unknown_source` 结束。
- **鉴权**：查询参数 `token`，与 `RELAY_SECRET` 相同。无效时关闭码 `1008`、原因 `unauthorized`。
- **回放默认关闭**。连接后先收到一帧 `connected`，其中 `replayed` 为随后紧跟的历史帧数量（默认 0）。之后只推送新入队的消息。
- **显式回放**：`replay=1`（也接受 `true` / `yes`）发送该订阅范围内最近 `limit` 条（默认 50，最大 200），从旧到新，帧类型与实时推送相同。
- **游标**：`since=<id>` 表示回放该 id **之后**的记录（同样受 `limit` 限制，从游标后的第一条算起）。`since` 本身就会打开回放。id 不在当前内存窗口内时，`sinceFound` 为 `false`，`replayed` 为 0，不回退成「最近 N 条」。
- `limit` 不是正整数时关闭码 `1008`、原因 `invalid_limit`。

连接确认示例：

```json
{
  "type": "connected",
  "channel": "priority",
  "source": "pangmao",
  "replayed": 0,
  "time": "2026-01-01T00:00:00.000Z"
}
```

未带 `source` 时 `source` 为 `null`。使用 `since` 时还会带上 `since` 和 `sinceFound`。

之后每条消息一帧：

```json
{
  "type": "priority_card",
  "id": "uuid",
  "source": "pangmao",
  "card": {"title": "示例"},
  "meta": {"via": "text", "yield_pct": null},
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

```bash
npx --yes wscat -c "ws://localhost:3000/ws/priority?token=dev-secret&source=pangmao&replay=1&limit=50"
```

## 目录结构

```
src/
  server.ts   # 入口
  app.ts      # Fastify 实例
  config.ts   # 配置
  bots.ts     # 多 bot 注册与加载
  routes.ts   # HTTP 路由
  ws.ts       # WebSocket /push-local 逻辑
  ws-registry.ts
  priority-sources.ts  # 优先队列来源白名单
  priority-queue.ts    # 优先队列 JSONL + 内存索引
  priority-routes.ts   # POST/GET /queue/priority
  priority-ws.ts       # GET /ws/priority
  auth.ts
  bot-push.ts # 出站 bot webhook 复用
  message.ts  # Message 类型与构造
  store.ts    # JSONL 存储
  forward.ts  # HTTP 转发
bots.example.json
priority-sources.example.json
```

## 更新已有部署

优先队列与现有 `/ws` 路由一起发布。在已有安装目录拉取后构建并重启进程即可，例如：

```bash
cd /www/wwwroot/op.g.ezcoin.ink/msg-relay-service
git pull
npm install
npm run build
# 按现有方式重启 Node（宝塔 / pm2 / systemd）。不要把 .env 或真实密钥提交到 Git。
```

未放置 `data/priority-sources.json` 时，来源只有胖猫社区。要增加来源，改该文件后再次重启。

## 许可证

MIT（如仓库未另行说明）
