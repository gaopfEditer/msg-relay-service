import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { assertAuth } from "./auth.js";
import { findPrioritySource } from "./priority-sources.js";
import type { PrioritySubscriberHub } from "./priority-ws.js";
import {
  parseEnqueueBody,
  parsePriorityLimit,
  type PriorityQueueStore,
} from "./priority-queue.js";

export function registerPriorityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  queue: PriorityQueueStore,
  hub: PrioritySubscriberHub
): void {
  app.get("/queue/priority/sources", async (req) => {
    assertAuth(req, config.relaySecret);
    return {
      sources: config.prioritySources.map((source) => ({
        id: source.id,
        name: source.name,
      })),
    };
  });

  app.get("/queue/priority", async (req, reply) => {
    assertAuth(req, config.relaySecret);
    const query = req.query as Record<string, unknown>;
    const sourceRaw = typeof query.source === "string" ? query.source.trim() : "";
    if (sourceRaw && !findPrioritySource(config.prioritySources, sourceRaw)) {
      return reply.status(422).send({
        error: "unknown_source",
        source: sourceRaw,
        message: `Source is not in the priority allowlist: ${sourceRaw}`,
      });
    }
    const limitRaw = typeof query.limit === "string" ? query.limit : undefined;
    const limitParsed = parsePriorityLimit(limitRaw);
    if (!limitParsed.ok) {
      return reply.status(422).send({
        error: "invalid_limit",
        message: limitParsed.message,
      });
    }

    const items = await queue.runExclusive(() =>
      queue.recent({
        source: sourceRaw || undefined,
        limit: limitParsed.limit,
      })
    );
    return { items };
  });

  app.post("/queue/priority", async (req, reply) => {
    assertAuth(req, config.relaySecret);
    const parsed = parseEnqueueBody(req.body);
    if (!parsed.ok) {
      return reply.status(422).send({
        error: "invalid_body",
        message: parsed.message,
      });
    }

    const source = findPrioritySource(config.prioritySources, parsed.value.source);
    if (!source) {
      return reply.status(422).send({
        error: "unknown_source",
        source: parsed.value.source,
        message: `Source is not in the priority allowlist: ${parsed.value.source}`,
      });
    }

    const item = {
      id: randomUUID(),
      source: source.id,
      card: parsed.value.card,
      meta: parsed.value.meta,
      createdAt: new Date().toISOString(),
    };

    await queue.append(item, (stored) => hub.publish(stored));

    return reply.status(202).send({
      id: item.id,
      source: item.source,
      createdAt: item.createdAt,
    });
  });
}
