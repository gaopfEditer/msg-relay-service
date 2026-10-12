import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { listBotsPublic } from "./bots.js";
import type { MessageStore } from "./store.js";
import { createMessage, toStoredRecord } from "./message.js";
import { postJson } from "./forward.js";
import { assertAuth } from "./auth.js";
import { pushToBotWebhook } from "./bot-push.js";
import type { WsClientRegistry } from "./ws-registry.js";
import { handlePushLocal, type PushLocalBody } from "./ws.js";

interface WebhookBody {
  type?: string;
  payload?: unknown;
  traceId?: string;
  source?: string;
}

interface PushBody {
  type?: string;
  payload?: unknown;
  traceId?: string;
}

async function handleOutboundPush(
  req: FastifyRequest<{ Body: PushBody }>,
  reply: FastifyReply,
  config: AppConfig,
  store: MessageStore,
  botId: string
) {
  assertAuth(req, config.relaySecret);

  const type = req.body?.type ?? "push";
  const payload = req.body?.payload ?? req.body;
  const result = await pushToBotWebhook(
    config,
    store,
    botId,
    type,
    payload,
    req.body?.traceId,
    "grokbot"
  );

  if (!result.ok) {
    return reply.status(result.httpStatus).send(result.body);
  }

  return reply.status(result.httpStatus).send(result.body);
}

export function registerRoutes(
  app: FastifyInstance,
  config: AppConfig,
  store: MessageStore,
  wsRegistry?: WsClientRegistry
): void {
  app.get("/health", async () => ({
    ok: true,
    service: "msg-relay-service",
    time: new Date().toISOString(),
  }));

  app.get("/bots", async (req, reply) => {
    assertAuth(req, config.relaySecret);
    return { bots: listBotsPublic(config.bots) };
  });

  app.get<{ Params: { traceId: string } }>(
    "/status/:traceId",
    async (req, reply) => {
      const record = store.get(req.params.traceId);
      if (!record) {
        return reply.status(404).send({ error: "not_found", traceId: req.params.traceId });
      }
      return {
        traceId: record.traceId,
        status: record.status,
        source: record.source,
        type: record.type,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        error: record.error,
      };
    }
  );

  app.post<{ Body: WebhookBody }>("/webhook/grokbot", async (req, reply) => {
    assertAuth(req, config.relaySecret);

    const type = req.body?.type ?? "event";
    const payload = req.body?.payload ?? req.body;
    const message = createMessage(
      req.body?.source ?? "grokbot",
      type,
      payload,
      req.body?.traceId
    );

    let record = toStoredRecord(message, "received", { direction: "inbound" });
    await store.save(record);

    if (config.forwardUrl) {
      const result = await postJson(config.forwardUrl, message);
      record = toStoredRecord(message, result.ok ? "forwarded" : "failed", {
        direction: "inbound",
        error: result.error,
      });
      await store.save(record);
    }

    return reply.status(202).send({
      traceId: message.traceId,
      status: record.status,
    });
  });

  app.post<{ Body: PushBody }>("/push/grokbot", async (req, reply) => {
    return handleOutboundPush(req, reply, config, store, config.defaultBotId);
  });

  app.post<{ Params: { botId: string }; Body: PushBody }>(
    "/push/:botId",
    async (req, reply) => {
      const { botId } = req.params;
      if (botId === "grokbot") {
        return handleOutboundPush(req, reply, config, store, config.defaultBotId);
      }
      return handleOutboundPush(req, reply, config, store, botId);
    }
  );

  app.post<{ Params: { clientId: string }; Body: PushLocalBody }>(
    "/push-local/:clientId",
    async (req, reply) => {
      assertAuth(req, config.relaySecret);
      if (!wsRegistry) {
        return reply.status(503).send({
          error: "ws_unavailable",
          message: "WebSocket relay is not enabled on this server instance",
        });
      }
      const result = await handlePushLocal(
        config,
        store,
        wsRegistry,
        req.params.clientId,
        req.body ?? {}
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.get("/ws/clients", async (req, reply) => {
    assertAuth(req, config.relaySecret);
    if (!wsRegistry) {
      return { clients: [] };
    }
    return { clients: wsRegistry.listConnected() };
  });
}
