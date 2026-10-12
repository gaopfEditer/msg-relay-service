import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadBotMap } from "./bots.js";
import { MessageStore } from "./store.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";

const SECRET = "test-secret-ws";

function makeConfig(dataDir: string, botsJson?: string): AppConfig {
  const bots = loadBotMap({
    dataDir,
    botsJsonEnv: botsJson,
    defaultBotId: "task-os",
  });
  return {
    port: 0,
    relaySecret: SECRET,
    dataDir,
    messagesFile: join(dataDir, "messages.jsonl"),
    defaultBotId: "task-os",
    bots,
  };
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
  return function waitForMessage(timeoutMs = 5000): Promise<string> {
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
  };
}

describe("WebSocket relay", () => {
  const dirs: string[] = [];

  after(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("rejects connection with invalid token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-ws-"));
    dirs.push(dataDir);
    const config = makeConfig(dataDir);
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?token=wrong&clientId=c1`
      );
      ws.on("close", (code, reason) => {
        assert.equal(code, 1008);
        assert.match(reason.toString(), /unauthorized/);
        resolve();
      });
      ws.on("error", () => {
        // some platforms emit error before close
      });
    });

    await app.close();
  });

  it("connects, receives push-local, client reply is persisted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-ws-"));
    dirs.push(dataDir);
    const config = makeConfig(dataDir);
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const clientId = "local-agent-1";
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${SECRET}&clientId=${clientId}`
    );
    const waitForMessage = createMessageQueue(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const welcome = await waitForMessage();
    const welcomeBody = JSON.parse(welcome) as { type: string; clientId: string };
    assert.equal(welcomeBody.type, "connected");
    assert.equal(welcomeBody.clientId, clientId);

    const pushedPromise = waitForMessage();
    const pushRes = await app.inject({
      method: "POST",
      url: `/push-local/${clientId}`,
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "task", payload: { cmd: "run" } },
    });
    assert.equal(pushRes.statusCode, 202);
    const pushBody = JSON.parse(pushRes.body) as { traceId: string; status: string };
    assert.equal(pushBody.status, "forwarded");

    const pushed = await pushedPromise;
    const pushedFrame = JSON.parse(pushed) as { traceId: string; type: string; payload: unknown };
    assert.equal(pushedFrame.traceId, pushBody.traceId);
    assert.equal(pushedFrame.type, "task");

    const ackPromise = waitForMessage();
    ws.send(
      JSON.stringify({
        type: "result",
        traceId: pushBody.traceId,
        payload: { ok: true, output: "done" },
      })
    );

    const ack = await ackPromise;
    const ackBody = JSON.parse(ack) as { type: string; traceId: string };
    assert.equal(ackBody.type, "ack");
    assert.equal(ackBody.traceId, pushBody.traceId);

    const log = readFileSync(config.messagesFile, "utf8");
    assert.match(log, /ws:local-agent-1/);
    assert.match(log, /"type":"result"/);

    ws.close();
    await app.close();
  });

  it("push-local returns 503 when client is offline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-ws-"));
    dirs.push(dataDir);
    const config = makeConfig(dataDir);
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);
    await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await app.inject({
      method: "POST",
      url: "/push-local/ghost-client",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "notify", payload: { x: 1 } },
    });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body) as { error: string; traceId: string };
    assert.equal(body.error, "client_offline");
    assert.ok(body.traceId);

    const record = store.get(body.traceId);
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "client_offline");

    await app.close();
  });
});
