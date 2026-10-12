import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { MessageStore } from "./store.js";
import { createMessage, toStoredRecord } from "./message.js";
import { postJson } from "./forward.js";

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

function extractSecret(req: FastifyRequest): string | undefined {
  const header = req.headers["x-relay-secret"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return undefined;
}

function assertAuth(req: FastifyRequest, secret: string): void {
  const provided = extractSecret(req);
  if (!provided || provided !== secret) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
}

export function registerRoutes(
  app: FastifyInstance,
  config: AppConfig,
  store: MessageStore
): void {
  app.get("/health", async () => ({
    ok: true,
    service: "msg-relay-service",
    time: new Date().toISOString(),
  }));

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
    assertAuth(req, config.relaySecret);

    const type = req.body?.type ?? "push";
    const payload = req.body?.payload ?? req.body;
    const message = createMessage("grokbot", type, payload, req.body?.traceId);

    let record = toStoredRecord(message, "received", { direction: "outbound" });
    await store.save(record);

    if (config.grokbotWebhookUrl) {
      const result = await postJson(config.grokbotWebhookUrl, message);
      record = toStoredRecord(message, result.ok ? "forwarded" : "failed", {
        direction: "outbound",
        error: result.error,
      });
      await store.save(record);
    }

    return reply.status(202).send({
      traceId: message.traceId,
      status: record.status,
    });
  });
}
