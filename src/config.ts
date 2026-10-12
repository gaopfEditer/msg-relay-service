import { loadBotMap, type BotMap } from "./bots.js";

export interface AppConfig {
  port: number;
  relaySecret: string;
  forwardUrl?: string;
  grokbotWebhookUrl?: string;
  grokbotWebhookKey?: string;
  dataDir: string;
  messagesFile: string;
  defaultBotId: string;
  bots: BotMap;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function legacyGrokbotKey(): string | undefined {
  const key =
    process.env.GROKBOT_WEBHOOK_KEY?.trim() ||
    process.env.GROKBOT_WEBHOOK_AUTH?.trim();
  return key || undefined;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid PORT");
  }

  const relaySecret = requireEnv("RELAY_SECRET", process.env.RELAY_SECRET);
  const forwardUrl = process.env.FORWARD_URL?.trim() || undefined;
  const grokbotWebhookUrl = process.env.GROKBOT_WEBHOOK_URL?.trim() || undefined;
  const grokbotWebhookKey = legacyGrokbotKey();
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  const messagesFile = `${dataDir}/messages.jsonl`;
  const defaultBotId = process.env.DEFAULT_BOT_ID?.trim() || "task-os";
  const botsConfigPath = process.env.BOTS_CONFIG_PATH?.trim() || undefined;

  const bots = loadBotMap({
    dataDir,
    botsConfigPath,
    botsJsonEnv: process.env.BOTS_JSON,
    legacyGrokbotWebhookUrl: grokbotWebhookUrl,
    legacyGrokbotWebhookKey: grokbotWebhookKey,
    defaultBotId,
  });

  if (!bots.has(defaultBotId)) {
    throw new Error(
      `DEFAULT_BOT_ID "${defaultBotId}" is not a known bot id`
    );
  }

  return {
    port,
    relaySecret,
    forwardUrl,
    grokbotWebhookUrl,
    grokbotWebhookKey,
    dataDir,
    messagesFile,
    defaultBotId,
    bots,
  };
}
