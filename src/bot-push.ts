import type { AppConfig } from "./config.js";
import { isBotConfigured, resolveBot } from "./bots.js";
import type { MessageStore } from "./store.js";
import { createMessage, toStoredRecord, type Message } from "./message.js";
import { postJson } from "./forward.js";

function webhookAuthHeaders(webhookKey?: string): Record<string, string> | undefined {
  const key = webhookKey?.trim();
  if (!key) return undefined;
  return { Authorization: `Bearer ${key}` };
}

export interface BotPushResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  message?: Message;
  recordStatus?: string;
}

export async function pushToBotWebhook(
  config: AppConfig,
  store: MessageStore,
  botId: string,
  type: string,
  payload: unknown,
  traceId?: string,
  sourcePrefix = "grokbot"
): Promise<BotPushResult> {
  const bot = resolveBot(config.bots, botId);
  if (!bot) {
    return {
      ok: false,
      httpStatus: 404,
      body: {
        error: "bot_not_found",
        botId,
        message: `Unknown bot id: ${botId}`,
      },
    };
  }

  if (!isBotConfigured(bot)) {
    return {
      ok: false,
      httpStatus: 422,
      body: {
        error: "bot_not_configured",
        botId,
        name: bot.name,
        message:
          `Bot "${botId}" (${bot.name}) has no webhook URL configured. ` +
          `Set webhookUrl/webhookKey via BOTS_JSON, bots.json, or legacy GROKBOT_WEBHOOK_URL for the default bot.`,
      },
    };
  }

  const source = `${sourcePrefix}:${botId}`;
  const message = createMessage(source, type, payload, traceId);

  let record = toStoredRecord(message, "received", { direction: "outbound" });
  await store.save(record);

  const result = await postJson(
    bot.webhookUrl!,
    message,
    webhookAuthHeaders(bot.webhookKey)
  );
  record = toStoredRecord(message, result.ok ? "forwarded" : "failed", {
    direction: "outbound",
    error: result.error,
  });
  await store.save(record);

  return {
    ok: true,
    httpStatus: 202,
    body: {
      traceId: message.traceId,
      status: record.status,
      botId,
    },
    message,
    recordStatus: record.status,
  };
}
