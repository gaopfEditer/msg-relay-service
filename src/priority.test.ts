import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadBotMap } from "./bots.js";
import { MessageStore } from "./store.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import {
  DEFAULT_PRIORITY_SOURCES,
  loadPrioritySources,
} from "./priority-sources.js";
import {
  PRIORITY_MEMORY_CAP,
  PriorityQueueStore,
  type PriorityItem,
} from "./priority-queue.js";

const SECRET = "test-secret-priority";

function makeConfig(dataDir: string, sourcesJson?: string): AppConfig {
  const prioritySourcesFile = join(dataDir, "priority-sources.json");
  if (sourcesJson !== undefined) {
    writeFileSync(prioritySourcesFile, sourcesJson);
  }
  const bots = loadBotMap({ dataDir, defaultBotId: "task-os" });
  return {
    port: 0,
    relaySecret: SECRET,
    dataDir,
    messagesFile: join(dataDir, "messages.jsonl"),
    defaultBotId: "task-os",
    bots,
    prioritySourcesFile,
    priorityQueueFile: join(dataDir, "priority-queue.jsonl"),
    prioritySources: loadPrioritySources(prioritySourcesFile),
  };
}

async function build(dataDir: string, sourcesJson?: string) {
  const config = makeConfig(dataDir, sourcesJson);
  const store = new MessageStore(config.messagesFile);
  await store.init();
  const app = await buildApp(config, store);
  return { config, store, app };
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  const waiters: Array<(msg: string) => void> = [];
  ws.on("message", (data) => {
    const text = data.toString("utf8");
    const waiter = waiters.shift();
    if (waiter) waiter(text);
    else queue.push(text);
  });
  return {
    get pending() {
      return queue.length;
    },
    wait(timeoutMs = 5000): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for ws message")),
          timeoutMs
        );
        const deliver = (msg: string) => {
          clearTimeout(timer);
          resolve(msg);
        };
        if (queue.length > 0) {
          deliver(queue.shift()!);
          return;
        }
        waiters.push(deliver);
      });
    },
  };
}

const card = { title: "胖猫", body: "hello card" };

function enqueuePayload(source = "pangmao", yieldPct: number | null = 3.5) {
  return {
    source,
    card,
    meta: { via: "ocr" as const, yield_pct: yieldPct },
  };
}

describe("priority sources", () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to pangmao only when the config file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-src-"));
    dirs.push(dir);
    const sources = loadPrioritySources(join(dir, "missing.json"));
    assert.deepEqual(sources, DEFAULT_PRIORITY_SOURCES.map((s) => ({ ...s })));
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.id, "pangmao");
    assert.equal(sources[0]?.name, "胖猫社区");
  });

  it("replaces the default from a config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-src-"));
    dirs.push(dir);
    const file = join(dir, "priority-sources.json");
    writeFileSync(
      file,
      JSON.stringify({
        sources: [
          { id: "pangmao", name: "胖猫社区" },
          { id: "demo", name: "示例来源" },
        ],
      })
    );
    const sources = loadPrioritySources(file);
    assert.deepEqual(
      sources.map((s) => s.id),
      ["pangmao", "demo"]
    );
  });
});

describe("priority queue store", () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only the newest items in memory and reloads them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-store-"));
    dirs.push(dir);
    const file = join(dir, "priority-queue.jsonl");
    const store = new PriorityQueueStore(file, 2);
    await store.init();
    const mk = (id: string): PriorityItem => ({
      id,
      source: "pangmao",
      card: { n: id },
      meta: { via: "text", yield_pct: null },
      createdAt: new Date().toISOString(),
    });
    await store.append(mk("a"));
    await store.append(mk("b"));
    await store.append(mk("c"));
    assert.deepEqual(
      store.recent({ limit: 10 }).map((item) => item.id),
      ["b", "c"]
    );
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);

    const reloaded = new PriorityQueueStore(file, 2);
    await reloaded.init();
    assert.deepEqual(
      reloaded.recent({ limit: 10 }).map((item) => item.id),
      ["b", "c"]
    );
    assert.equal(PRIORITY_MEMORY_CAP, 1000);
  });
});

describe("priority queue HTTP and WebSocket", () => {
  const dirs: string[] = [];

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("lists only pangmao by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-http-"));
    dirs.push(dir);
    const { app } = await build(dir);
    const res = await app.inject({
      method: "GET",
      url: "/queue/priority/sources",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { sources: Array<{ id: string; name: string }> };
    assert.deepEqual(body.sources, [{ id: "pangmao", name: "胖猫社区" }]);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    await app.close();
  });

  it("rejects missing and wrong auth on enqueue, peek, and source list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-http-"));
    dirs.push(dir);
    const { app } = await build(dir);

    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { "x-relay-secret": "wrong" },
    ]) {
      const post = await app.inject({
        method: "POST",
        url: "/queue/priority",
        headers,
        payload: enqueuePayload(),
      });
      assert.equal(post.statusCode, 401);
      assert.match(post.body, /unauthorized/);

      const list = await app.inject({
        method: "GET",
        url: "/queue/priority?source=pangmao",
        headers,
      });
      assert.equal(list.statusCode, 401);

      const sources = await app.inject({
        method: "GET",
        url: "/queue/priority/sources",
        headers,
      });
      assert.equal(sources.statusCode, 401);
    }

    const queueFile = join(dir, "priority-queue.jsonl");
    assert.equal(existsSync(queueFile), false);
    await app.close();
  });

  it("enqueues pangmao with no subscriber and peeks it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-http-"));
    dirs.push(dir);
    const { config, app } = await build(dir);
    const res = await app.inject({
      method: "POST",
      url: "/queue/priority",
      headers: { "x-relay-secret": SECRET },
      payload: enqueuePayload("pangmao", null),
    });
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body) as { id: string; source: string; createdAt: string };
    assert.equal(body.source, "pangmao");
    assert.ok(body.id);
    assert.ok(body.createdAt);
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "id", "source"]);

    const log = readFileSync(config.priorityQueueFile, "utf8");
    assert.match(log, new RegExp(body.id));
    assert.match(log, /胖猫/);
    assert.equal(log.includes(SECRET), false);
    assert.equal(existsSync(config.messagesFile), false);

    const list = await app.inject({
      method: "GET",
      url: "/queue/priority?source=pangmao&limit=50",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(list.statusCode, 200);
    const listed = JSON.parse(list.body) as {
      items: Array<{ id: string; source: string; card: { title: string }; meta: { via: string; yield_pct: null } }>;
    };
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.id, body.id);
    assert.equal(listed.items[0]?.card.title, "胖猫");
    assert.deepEqual(listed.items[0]?.meta, { via: "ocr", yield_pct: null });
    assert.equal(list.body.includes(SECRET), false);
    await app.close();
  });

  it("rejects an unknown source and does not store it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-http-"));
    dirs.push(dir);
    const { config, app } = await build(dir);
    const res = await app.inject({
      method: "POST",
      url: "/queue/priority",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: enqueuePayload("not-a-source"),
    });
    assert.equal(res.statusCode, 422);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, "unknown_source");
    assert.equal(existsSync(config.priorityQueueFile), false);

    const list = await app.inject({
      method: "GET",
      url: "/queue/priority",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const listed = JSON.parse(list.body) as { items: unknown[] };
    assert.deepEqual(listed.items, []);
    await app.close();
  });

  it("accepts a source added only in the allowlist file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-http-"));
    dirs.push(dir);
    const { app } = await build(
      dir,
      JSON.stringify({
        sources: [
          { id: "pangmao", name: "胖猫社区" },
          { id: "demo", name: "示例来源" },
        ],
      })
    );
    const sources = await app.inject({
      method: "GET",
      url: "/queue/priority/sources",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const listed = JSON.parse(sources.body) as { sources: Array<{ id: string; name: string }> };
    assert.deepEqual(
      listed.sources.map((s) => s.id),
      ["pangmao", "demo"]
    );

    const res = await app.inject({
      method: "POST",
      url: "/queue/priority",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: {
        source: "demo",
        card: { n: 1 },
        meta: { via: "text", yield_pct: 1 },
      },
    });
    assert.equal(res.statusCode, 202);

    const filtered = await app.inject({
      method: "GET",
      url: "/queue/priority?source=nope",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(filtered.statusCode, 422);
    await app.close();
  });

  it("subscriber receives a card, and a second subscriber does too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-ws-"));
    dirs.push(dir);
    const { app } = await build(dir);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const openClient = (query: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/priority?${query}`);
      const messages = createMessageQueue(ws);
      const opened = new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      return { ws, messages, opened };
    };

    const a = openClient(`token=${SECRET}&source=pangmao`);
    const b = openClient(`token=${SECRET}`);
    await Promise.all([a.opened, b.opened]);
    const ackA = JSON.parse(await a.messages.wait()) as { type: string; source: string; replayed: number };
    const ackB = JSON.parse(await b.messages.wait()) as { type: string; source: null; replayed: number };
    assert.equal(ackA.type, "connected");
    assert.equal(ackA.source, "pangmao");
    assert.equal(ackA.replayed, 0);
    assert.equal(ackB.type, "connected");
    assert.equal(ackB.source, null);
    assert.equal(ackB.replayed, 0);

    const nextA = a.messages.wait();
    const nextB = b.messages.wait();
    const res = await app.inject({
      method: "POST",
      url: "/queue/priority",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: enqueuePayload(),
    });
    assert.equal(res.statusCode, 202);
    const posted = JSON.parse(res.body) as { id: string };

    for (const next of [nextA, nextB]) {
      const frame = JSON.parse(await next) as {
        type: string;
        id: string;
        source: string;
        card: { title: string };
        meta: { via: string; yield_pct: number };
        createdAt: string;
      };
      assert.equal(frame.type, "priority_card");
      assert.equal(frame.id, posted.id);
      assert.equal(frame.source, "pangmao");
      assert.equal(frame.card.title, "胖猫");
      assert.deepEqual(frame.meta, { via: "ocr", yield_pct: 3.5 });
      assert.ok(frame.createdAt);
    }

    a.ws.close();
    b.ws.close();
    await app.close();
  });

  it("does not replay unless asked, then replays a limited window and since cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-ws-"));
    dirs.push(dir);
    const { app } = await build(dir);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await app.inject({
        method: "POST",
        url: "/queue/priority",
        headers: { authorization: `Bearer ${SECRET}` },
        payload: {
          source: "pangmao",
          card: { n },
          meta: { via: "text", yield_pct: null },
        },
      });
      assert.equal(res.statusCode, 202);
      ids.push((JSON.parse(res.body) as { id: string }).id);
    }

    const silent = new WebSocket(
      `ws://127.0.0.1:${port}/ws/priority?token=${SECRET}&source=pangmao`
    );
    const waitSilent = createMessageQueue(silent);
    await new Promise<void>((resolve, reject) => {
      silent.once("open", () => resolve());
      silent.once("error", reject);
    });
    const silentAck = JSON.parse(await waitSilent.wait()) as { replayed: number };
    assert.equal(silentAck.replayed, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(waitSilent.pending, 0);
    silent.close();

    const replay = new WebSocket(
      `ws://127.0.0.1:${port}/ws/priority?token=${SECRET}&source=pangmao&replay=1&limit=2`
    );
    const waitReplay = createMessageQueue(replay);
    await new Promise<void>((resolve, reject) => {
      replay.once("open", () => resolve());
      replay.once("error", reject);
    });
    const replayAck = JSON.parse(await waitReplay.wait()) as { replayed: number };
    assert.equal(replayAck.replayed, 2);
    const replayIds = [
      (JSON.parse(await waitReplay.wait()) as { id: string }).id,
      (JSON.parse(await waitReplay.wait()) as { id: string }).id,
    ];
    assert.deepEqual(replayIds, [ids[1], ids[2]]);
    replay.close();

    const since = new WebSocket(
      `ws://127.0.0.1:${port}/ws/priority?token=${SECRET}&source=pangmao&since=${ids[0]}`
    );
    const waitSince = createMessageQueue(since);
    await new Promise<void>((resolve, reject) => {
      since.once("open", () => resolve());
      since.once("error", reject);
    });
    const sinceAck = JSON.parse(await waitSince.wait()) as { replayed: number; sinceFound: boolean };
    assert.equal(sinceAck.sinceFound, true);
    assert.equal(sinceAck.replayed, 2);
    const sinceIds = [
      (JSON.parse(await waitSince.wait()) as { id: string }).id,
      (JSON.parse(await waitSince.wait()) as { id: string }).id,
    ];
    assert.deepEqual(sinceIds, [ids[1], ids[2]]);
    since.close();
    await app.close();
  });

  it("closes the priority socket when token or source is rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-ws-"));
    dirs.push(dir);
    const { config, app } = await build(dir);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const waitClose = (url: string) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        const ws = new WebSocket(url);
        ws.on("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
        ws.on("error", () => {
          // close follows on auth failure
        });
      });

    const badToken = await waitClose(
      `ws://127.0.0.1:${port}/ws/priority?token=wrong&source=pangmao`
    );
    assert.equal(badToken.code, 1008);
    assert.match(badToken.reason, /unauthorized/);

    const badSource = await waitClose(
      `ws://127.0.0.1:${port}/ws/priority?token=${SECRET}&source=other`
    );
    assert.equal(badSource.code, 1008);
    assert.match(badSource.reason, /unknown_source/);
    assert.equal(existsSync(config.priorityQueueFile), false);
    await app.close();
  });
});
