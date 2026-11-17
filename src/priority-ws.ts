import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AppConfig } from "./config.js";
import { isValidRelaySecret } from "./auth.js";
import { findPrioritySource } from "./priority-sources.js";
import {
  parsePriorityLimit,
  toPriorityFrame,
  type PriorityItem,
  type PriorityQueueStore,
} from "./priority-queue.js";

interface PrioritySubscriber {
  socket: WebSocket;
  source: string | null;
}

/**
 * Fan-out for /ws/priority. Any number of subscribers may listen.
 * A null source means "every allowlisted source".
 */
export class PrioritySubscriberHub {
  private readonly subs = new Set<PrioritySubscriber>();

  add(socket: WebSocket, source: string | null): void {
    const sub: PrioritySubscriber = { socket, source };
    if (socket.readyState !== socket.OPEN) return;
    this.subs.add(sub);
    const remove = () => {
      this.subs.delete(sub);
    };
    socket.on("close", remove);
    socket.on("error", remove);
  }

  publish(item: PriorityItem): void {
    const frame = toPriorityFrame(item);
    for (const sub of this.subs) {
      if (sub.source && sub.source !== item.source) continue;
      if (sub.socket.readyState !== sub.socket.OPEN) {
        this.subs.delete(sub);
        continue;
      }
      try {
        sub.socket.send(frame);
      } catch {
        this.subs.delete(sub);
      }
    }
  }
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function wantsReplay(replay: string | undefined, since: string): boolean {
  if (since) return true;
  if (!replay) return false;
  return ["1", "true", "yes"].includes(replay.trim().toLowerCase());
}

export function registerPriorityWebSocket(
  app: FastifyInstance,
  config: AppConfig,
  queue: PriorityQueueStore,
  hub: PrioritySubscriberHub
): void {
  app.get("/ws/priority", { websocket: true }, (socket: WebSocket, req) => {
    const query = req.query as Record<string, unknown>;
    const token = queryString(query.token);
    if (!isValidRelaySecret(token, config.relaySecret)) {
      socket.close(1008, "unauthorized");
      return;
    }

    const sourceRaw = (queryString(query.source) ?? "").trim();
    let source: string | null = null;
    if (sourceRaw) {
      if (!findPrioritySource(config.prioritySources, sourceRaw)) {
        socket.close(1008, "unknown_source");
        return;
      }
      source = sourceRaw;
    }

    const since = (queryString(query.since) ?? "").trim();
    const replayRaw = queryString(query.replay);
    const limitParsed = parsePriorityLimit(queryString(query.limit));
    if (!limitParsed.ok) {
      socket.close(1008, "invalid_limit");
      return;
    }

    const replay = wantsReplay(replayRaw, since);
    void queue
      .runExclusive(() => {
        let items: PriorityItem[] = [];
        let sinceFound: boolean | undefined;
        if (replay && since) {
          const page = queue.after(since, {
            source: source ?? undefined,
            limit: limitParsed.limit,
          });
          sinceFound = page.found;
          items = page.items;
        } else if (replay) {
          items = queue.recent({
            source: source ?? undefined,
            limit: limitParsed.limit,
          });
        }

        hub.add(socket, source);

        const ack: Record<string, unknown> = {
          type: "connected",
          channel: "priority",
          source,
          replayed: items.length,
          time: new Date().toISOString(),
        };
        if (since) {
          ack.since = since;
          ack.sinceFound = sinceFound === true;
        }
        try {
          socket.send(JSON.stringify(ack));
          for (const item of items) {
            if (socket.readyState !== socket.OPEN) return;
            socket.send(toPriorityFrame(item));
          }
        } catch {
          // client went away while the backlog was being written
        }
      })
      .catch(() => {
        try {
          socket.close(1011, "replay_failed");
        } catch {
          // ignore
        }
      });
  });
}
