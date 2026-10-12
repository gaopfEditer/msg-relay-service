# msg-relay-service

万能消息中转后台（MVP）：先支撑 **Grok Bot** 消息的接收、存储与可选转发。日志持久化为本地 JSONL（`data/messages.jsonl`），无 Redis / BullMQ / PostgreSQL。

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
| `GROKBOT_WEBHOOK_URL` | 否 | 配置后，`POST /push/grokbot` 会向 Grok Bot 推送消息 |
| `DATA_DIR` | 否 | 数据目录，默认 `data` |

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
  "source": "grokbot",
  "type": "event",
  "payload": {},
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

存储记录额外包含 `status`（`received` | `forwarded` | `failed`）、`updatedAt`，失败时可能有 `error`。

## HTTP 接口

### `GET /health`

健康检查。

```bash
curl -s http://localhost:3000/health | jq
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

### `POST /push/grokbot`

向外推送：鉴权 → 生成 Message 并存储 → 若配置了 `GROKBOT_WEBHOOK_URL` 则 POST 推送，否则仅存储，状态为 `received`。

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
  routes.ts   # 路由
  message.ts  # Message 类型与构造
  store.ts    # JSONL 存储
  forward.ts  # HTTP 转发
```

## 许可证

MIT（如仓库未另行说明）
