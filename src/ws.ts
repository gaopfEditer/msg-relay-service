import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import type { MessageStore } from "./store.js";
import { isValidRelaySecret } from "./auth.js";
import { pushToBotWebhook } from "./bot-push.js";
import { createMessage, toStoredRecord } from "./message.js";
import type { WsClientRegistry } from "./ws-registry.js";

interface ClientFrame {
  type?: string;
  payload?: unknown;
  traceId?: string;
  botId?: string;
  forwardToBot?: string;
}

function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const parsed = JSON.parse(raw) as ClientFrame;
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function registerWebSocketRoutes(
  app: FastifyInstance,
  config: AppConfig,
  store: MessageStore,
  registry: WsClientRegistry
): void {
  app.get(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req) => {
      const query = req.query as Record<string, string | undefined>;
      const token = typeof query.token === "string" ? query.token : undefined;
      const clientId = typeof query.clientId === "string" ? query.clientId.trim() : "";
      const botId =
        typeof query.botId === "string" && query.botId.trim()
          ? query.botId.trim()
          : undefined;

      if (!isValidRelaySecret(token, config.relaySecret)) {
        socket.close(1008, "unauthorized");
        return;
      }

      if (!clientId) {
        socket.close(1008, "clientId_required");
        return;
      }

      registry.register(clientId, socket, { botId });

      socket.on("message", (buf) => {
        void handleClientMessage(config, store, clientId, botId, buf.toString("utf8"), socket);
      });

      socket.on("close", () => {
        registry.unregister(clientId, socket);
      });

      socket.on("error", () => {
        registry.unregister(clientId, socket);
      });

      socket.send(
        JSON.stringify({
          type: "connected",
          clientId,
          botId: botId ?? null,
          time: new Date().toISOString(),
        })
      );
    }
  );
}

async function handleClientMessage(
  config: AppConfig,
  store: MessageStore,
  clientId: string,
  registeredBotId: string | undefined,
  raw: string,
  socket: WebSocket
): Promise<void> {
  const frame = parseClientFrame(raw);
  if (!frame) {
    socket.send(
      JSON.stringify({ type: "error", error: "invalid_json", message: "Expected JSON object" })
    );
    return;
  }

  const type = frame.type ?? "data";
  const payload = frame.payload ?? frame;
  const source = `ws:${clientId}`;
  const message = createMessage(source, type, payload, frame.traceId);

  let record = toStoredRecord(message, "received", { direction: "inbound" });
  await store.save(record);

  const targetBotId =
    frame.forwardToBot?.trim() ||
    frame.botId?.trim() ||
    registeredBotId;

  let forwardStatus: string | undefined;
  if (targetBotId) {
    const push = await pushToBotWebhook(
      config,
      store,
      targetBotId,
      type,
      payload,
      message.traceId,
      "ws-forward"
    );
    forwardStatus = push.recordStatus ?? (push.ok ? "forwarded" : "failed");
    if (!push.ok) {
      record = toStoredRecord(message, "failed", {
        direction: "inbound",
        error: JSON.stringify(push.body),
      });
      await store.save(record);
    } else {
      record = toStoredRecord(
        message,
        push.recordStatus === "forwarded" ? "forwarded" : "failed",
        {
          direction: "inbound",
          error: push.recordStatus === "failed" ? "bot_webhook_failed" : undefined,
        }
      );
      await store.save(record);
    }
  }

  socket.send(
    JSON.stringify({
      type: "ack",
      traceId: message.traceId,
      status: record.status,
      forwardStatus: forwardStatus ?? null,
    })
  );
}

export interface PushLocalBody {
  type?: string;
  payload?: unknown;
  traceId?: string;
}

export async function handlePushLocal(
  config: AppConfig,
  store: MessageStore,
  registry: WsClientRegistry,
  clientId: string,
  body: PushLocalBody
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const type = body.type ?? "push";
  const payload = body.payload ?? body;
  const source = `push-local:${clientId}`;
  const message = createMessage(source, type, payload, body.traceId);

  if (!registry.isConnected(clientId)) {
    const record = toStoredRecord(message, "failed", {
      direction: "outbound",
      error: "client_offline",
    });
    await store.save(record);
    return {
      statusCode: 503,
      body: {
        error: "client_offline",
        clientId,
        traceId: message.traceId,
        message: `No WebSocket client connected for clientId: ${clientId}`,
      },
    };
  }

  let record = toStoredRecord(message, "received", { direction: "outbound" });
  await store.save(record);

  const frame = JSON.stringify({
    traceId: message.traceId,
    source: message.source,
    type: message.type,
    payload: message.payload,
    createdAt: message.createdAt,
  });

  const sent = registry.send(clientId, frame);
  if (!sent) {
    record = toStoredRecord(message, "failed", {
      direction: "outbound",
      error: "client_send_failed",
    });
    await store.save(record);
    return {
      statusCode: 503,
      body: {
        error: "client_offline",
        clientId,
        traceId: message.traceId,
        message: `Failed to deliver to clientId: ${clientId}`,
      },
    };
  }

  record = toStoredRecord(message, "forwarded", { direction: "outbound" });
  await store.save(record);

  return {
    statusCode: 202,
    body: {
      traceId: message.traceId,
      status: record.status,
      clientId,
    },
  };
}
