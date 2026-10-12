import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import type { MessageStore } from "./store.js";
import { registerRoutes } from "./routes.js";

export async function buildApp(config: AppConfig, store: MessageStore) {
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

  registerRoutes(app, config, store);
  return app;
}
