import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotMap } from "./bots.js";
import { MessageStore } from "./store.js";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";

const SECRET = "test-secret";

function makeConfig(overrides: Partial<AppConfig> & { botsJson?: string }): AppConfig {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), "relay-test-"));
  const bots = loadBotMap({
    dataDir,
    botsJsonEnv: overrides.botsJson,
    legacyGrokbotWebhookUrl: overrides.grokbotWebhookUrl,
    legacyGrokbotWebhookKey: overrides.grokbotWebhookKey,
    defaultBotId: overrides.defaultBotId ?? "task-os",
  });
  return {
    port: 3000,
    relaySecret: SECRET,
    forwardUrl: overrides.forwardUrl,
    grokbotWebhookUrl: overrides.grokbotWebhookUrl,
    grokbotWebhookKey: overrides.grokbotWebhookKey,
    dataDir,
    messagesFile: join(dataDir, "messages.jsonl"),
    defaultBotId: overrides.defaultBotId ?? "task-os",
    bots,
  };
}

describe("push routes", () => {
  let dataDir: string;

  after(() => {
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("unknown bot returns 404", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const config = makeConfig({ dataDir });
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);

    const res = await app.inject({
      method: "POST",
      url: "/push/no-such-bot",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "notify", payload: { text: "hi" } },
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /bot_not_found/);
    await app.close();
  });

  it("unconfigured bot returns 422 without storing", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const config = makeConfig({ dataDir });
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);

    const res = await app.inject({
      method: "POST",
      url: "/push/inspiration",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "notify", payload: { text: "hi" } },
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /bot_not_configured/);
    await app.close();
  });

  it("GET /bots lists bots without secrets", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const config = makeConfig({
      dataDir,
      botsJson: JSON.stringify({
        "task-os": { webhookUrl: "https://hook.example/a", webhookKey: "secret" },
      }),
    });
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);

    const res = await app.inject({
      method: "GET",
      url: "/bots",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { bots: Array<{ id: string; configured: boolean }> };
    assert.ok(body.bots.some((b) => b.id === "task-os" && b.configured));
    assert.ok(body.bots.some((b) => b.id === "jokes" && !b.configured));
    assert.ok(!res.body.includes("secret"));
    await app.close();
  });

  it("configured push sends Bearer to webhook", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const webhookUrl = "https://relay-push-test.example/inbound";
    const config = makeConfig({
      dataDir,
      botsJson: JSON.stringify({
        code: { webhookUrl, webhookKey: "wh-key-123" },
      }),
    });
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);

    const originalFetch = globalThis.fetch;
    let capturedAuth: string | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === webhookUrl) {
        capturedAuth =
          (init?.headers as Record<string, string>)?.Authorization ??
          (init?.headers as Headers)?.get?.("Authorization") ??
          null;
        return new Response("ok", { status: 200 });
      }
      return originalFetch(input, init);
    };

    const res = await app.inject({
      method: "POST",
      url: "/push/code",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "notify", payload: { text: "hi" } },
    });

    globalThis.fetch = originalFetch;
    assert.equal(res.statusCode, 202);
    assert.equal(capturedAuth, "Bearer wh-key-123");
    const body = JSON.parse(res.body) as { status: string; botId: string };
    assert.equal(body.status, "forwarded");
    assert.equal(body.botId, "code");
    await app.close();
  });

  it("/push/grokbot uses legacy env when task-os unset in BOTS_JSON", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    const webhookUrl = "https://legacy-grok.example/h";
    const config = makeConfig({
      dataDir,
      grokbotWebhookUrl: webhookUrl,
      grokbotWebhookKey: "leg",
    });
    const store = new MessageStore(config.messagesFile);
    await store.init();
    const app = await buildApp(config, store);

    const originalFetch = globalThis.fetch;
    let hit = false;
    globalThis.fetch = async (input) => {
      if (String(input) === webhookUrl) {
        hit = true;
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const res = await app.inject({
      method: "POST",
      url: "/push/grokbot",
      headers: { authorization: `Bearer ${SECRET}` },
      payload: { payload: { t: 1 } },
    });

    globalThis.fetch = originalFetch;
    assert.equal(res.statusCode, 202);
    assert.equal(hit, true);
    await app.close();
  });
});
