import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotMap, PRESEEDED_BOTS, resolveBot, isBotConfigured } from "./bots.js";

describe("loadBotMap", () => {
  it("pre-seeds all required bot ids with display names", () => {
    const map = loadBotMap({
      dataDir: "/nonexistent",
      defaultBotId: "task-os",
    });
    assert.equal(map.size, PRESEEDED_BOTS.length);
    assert.equal(resolveBot(map, "task-os")?.name, "任务管家");
    assert.equal(resolveBot(map, "ai-ops")?.name, "如何用好AI");
    assert.equal(isBotConfigured(resolveBot(map, "task-os")!), false);
  });

  it("merges BOTS_JSON and legacy GROKBOT webhook into default bot", () => {
    const map = loadBotMap({
      dataDir: "/nonexistent",
      defaultBotId: "task-os",
      botsJsonEnv: JSON.stringify({
        inspiration: { webhookUrl: "https://insp.example/hook", webhookKey: "k1" },
      }),
      legacyGrokbotWebhookUrl: "https://legacy.example/hook",
      legacyGrokbotWebhookKey: "legacy-key",
    });
    const taskOs = resolveBot(map, "task-os")!;
    assert.equal(taskOs.webhookUrl, "https://legacy.example/hook");
    assert.equal(taskOs.webhookKey, "legacy-key");
    const inspiration = resolveBot(map, "inspiration")!;
    assert.equal(inspiration.webhookUrl, "https://insp.example/hook");
    assert.equal(inspiration.webhookKey, "k1");
  });

  it("BOTS_JSON overrides legacy url on default bot", () => {
    const map = loadBotMap({
      dataDir: "/nonexistent",
      defaultBotId: "task-os",
      botsJsonEnv: JSON.stringify({
        "task-os": { webhookUrl: "https://task.example/hook", webhookKey: "t1" },
      }),
      legacyGrokbotWebhookUrl: "https://legacy.example/hook",
    });
    const taskOs = resolveBot(map, "task-os")!;
    assert.equal(taskOs.webhookUrl, "https://task.example/hook");
    assert.equal(taskOs.webhookKey, "t1");
  });

  it("loads bots.json from data dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-test-"));
    writeFileSync(
      join(dir, "bots.json"),
      JSON.stringify({ code: { webhookUrl: "https://code.example/h", webhookKey: "c" } })
    );
    const map = loadBotMap({ dataDir: dir, defaultBotId: "task-os" });
    assert.equal(resolveBot(map, "code")?.webhookUrl, "https://code.example/h");
  });
});
