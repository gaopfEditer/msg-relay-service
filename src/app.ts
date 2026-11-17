import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { AppConfig } from "./config.js";
import type { MessageStore } from "./store.js";
import { registerRoutes } from "./routes.js";
import { WsClientRegistry } from "./ws-registry.js";
import { registerWebSocketRoutes } from "./ws.js";
import { PriorityQueueStore } from "./priority-queue.js";
import { registerPriorityRoutes } from "./priority-routes.js";
import { PrioritySubscriberHub, registerPriorityWebSocket } from "./priority-ws.js";

export interface BuildAppOptions {
  enableWebSocket?: boolean;
}

export async function buildApp(
  config: AppConfig,
  store: MessageStore,
  options: BuildAppOptions = {}
) {
  const enableWebSocket = options.enableWebSocket ?? true;
  const wsRegistry = enableWebSocket ? new WsClientRegistry() : undefined;
  const priorityQueue = new PriorityQueueStore(config.priorityQueueFile);
  await priorityQueue.init();
  const priorityHub = new PrioritySubscriberHub();

  const app = Fastify({
    logger: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode =
      typeof (err as { statusCode?: number }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : String(err);
    reply.status(statusCode).send({
      error: statusCode === 401 ? "unauthorized" : "internal_error",
      message,
    });
  });

  if (wsRegistry) {
    await app.register(websocket);
    registerWebSocketRoutes(app, config, store, wsRegistry);
    registerPriorityWebSocket(app, config, priorityQueue, priorityHub);
  }
  registerRoutes(app, config, store, wsRegistry);
  registerPriorityRoutes(app, config, priorityQueue, priorityHub);
  return app;
}
