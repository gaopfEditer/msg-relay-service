# msg-relay-service

万能消息中转后台（MVP）：支撑 **Grok Bot** 消息的接收、存储与可选转发，并支持**多 Bot 出站推送**（每个 Bot 有稳定 `id`，对应 Cursor Automations Webhook URL + Bearer Key）。日志持久化为本地 JSONL（`data/messages.jsonl`），无 Redis / BullMQ / PostgreSQL。

## 技术栈

- Node.js 20+、TypeScript、Fastify
- Docker

## 环境变量

复制 `.env.example` 为 `.env` 并按需修改：

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 监听端口，默认 `3000` |
| `RELAY_SECRET` | 是 | 鉴权密钥，支持 `Authorization: Bearer <secret>` 或 `X-Relay-Secret` |
| `FORWARD_URL` | 否 | 配置后，`POST /webhook/grokbot` 会将统一 Message 转发到此 URL |
| `DEFAULT_BOT_ID` | 否 | `/push/grokbot` 别名指向的 bot id，默认 `task-os` |
| `BOTS_JSON` | 否 | JSON 字符串，按 bot id 配置 `webhookUrl` / `webhookKey`（见下方示例） |
| `BOTS_CONFIG_PATH` | 否 | bots 配置文件路径；未设置时使用 `DATA_DIR/bots.json` |
| `GROKBOT_WEBHOOK_URL` | 否 | **兼容旧部署**：当默认 bot（`task-os`）未配置 `webhookUrl` 时，作为其出站 Webhook |
| `GROKBOT_WEBHOOK_KEY` / `GROKBOT_WEBHOOK_AUTH` | 否 | 与上配套的 Bearer Token（二者等价，任选其一） |
| `DATA_DIR` | 否 | 数据目录，默认 `data` |

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

## 目录结构

```
src/
  server.ts   # 入口
  app.ts      # Fastify 实例
  config.ts   # 配置
  bots.ts     # 多 bot 注册与加载
  routes.ts   # 路由
  message.ts  # Message 类型与构造
  store.ts    # JSONL 存储
  forward.ts  # HTTP 转发
bots.example.json
```

## 许可证

MIT（如仓库未另行说明）
