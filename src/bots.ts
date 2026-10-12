import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BotEntry {
  id: string;
  name: string;
  webhookUrl?: string;
  webhookKey?: string;
}

export type BotMap = Map<string, BotEntry>;

/** Stable registry: id → display name (url/key filled via env or config file). */
export const PRESEEDED_BOTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "task-os", name: "任务管家" },
  { id: "inspiration", name: "灵感随笔" },
  { id: "content", name: "资讯创作官" },
  { id: "trading", name: "交易观察员" },
  { id: "code", name: "代码大师" },
  { id: "overseas", name: "出海大师" },
  { id: "internet", name: "互联网大咖" },
  { id: "jokes", name: "段子大师" },
  { id: "ai-ops", name: "如何用好AI" },
];

export interface BotLoaderOptions {
  dataDir: string;
  botsConfigPath?: string;
  botsJsonEnv?: string;
  /** Legacy single-bot webhook; applied to default bot when that bot has no URL. */
  legacyGrokbotWebhookUrl?: string;
  legacyGrokbotWebhookKey?: string;
  defaultBotId: string;
}

function emptyBotMap(): BotMap {
  const map = new Map<string, BotEntry>();
  for (const { id, name } of PRESEEDED_BOTS) {
    map.set(id, { id, name });
  }
  return map;
}

type RawBotConfig =
  | Record<string, Partial<BotEntry> & { name?: string; webhookUrl?: string; webhookKey?: string }>
  | Array<Partial<BotEntry> & { id: string }>;

function mergeRawIntoMap(map: BotMap, raw: RawBotConfig): void {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item?.id) continue;
      const existing = map.get(item.id);
      const name = item.name?.trim() || existing?.name || item.id;
      map.set(item.id, {
        id: item.id,
        name,
        webhookUrl: pickUrl(item.webhookUrl, existing?.webhookUrl),
        webhookKey: pickKey(item.webhookKey, existing?.webhookKey),
      });
    }
    return;
  }

  for (const [key, item] of Object.entries(raw)) {
    const id = (item?.id ?? key).trim();
    if (!id) continue;
    const existing = map.get(id);
    const name = item.name?.trim() || existing?.name || id;
    map.set(id, {
      id,
      name,
      webhookUrl: pickUrl(item.webhookUrl, existing?.webhookUrl),
      webhookKey: pickKey(item.webhookKey, existing?.webhookKey),
    });
  }
}

function pickUrl(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function pickKey(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function readBotsFile(filePath: string): RawBotConfig | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    return JSON.parse(text) as RawBotConfig;
  } catch (err: unknown) {
    if (isENOENT(err)) return undefined;
    throw new Error(`Failed to load bots config from ${filePath}: ${formatErr(err)}`);
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadBotMap(options: BotLoaderOptions): BotMap {
  const map = emptyBotMap();

  const configPath =
    options.botsConfigPath?.trim() ||
    resolve(options.dataDir, "bots.json");

  const fromFile = readBotsFile(configPath);
  if (fromFile) {
    mergeRawIntoMap(map, fromFile);
  }

  const envJson = options.botsJsonEnv?.trim();
  if (envJson) {
    try {
      mergeRawIntoMap(map, JSON.parse(envJson) as RawBotConfig);
    } catch (err: unknown) {
      throw new Error(`Invalid BOTS_JSON: ${formatErr(err)}`);
    }
  }

  const defaultId = options.defaultBotId;
  const defaultBot = map.get(defaultId);
  if (
    options.legacyGrokbotWebhookUrl &&
    defaultBot &&
    !defaultBot.webhookUrl
  ) {
    map.set(defaultId, {
      ...defaultBot,
      webhookUrl: options.legacyGrokbotWebhookUrl,
      webhookKey:
        options.legacyGrokbotWebhookKey ?? defaultBot.webhookKey,
    });
  }

  return map;
}

export function isBotConfigured(bot: BotEntry): boolean {
  return Boolean(bot.webhookUrl?.trim());
}

export function listBotsPublic(map: BotMap): Array<{
  id: string;
  name: string;
  configured: boolean;
}> {
  return [...map.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      configured: isBotConfigured(bot),
    }));
}

export function resolveBot(map: BotMap, botId: string): BotEntry | undefined {
  return map.get(botId);
}
