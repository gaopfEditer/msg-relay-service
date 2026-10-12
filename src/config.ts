export interface AppConfig {
  port: number;
  relaySecret: string;
  forwardUrl?: string;
  grokbotWebhookUrl?: string;
  dataDir: string;
  messagesFile: string;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid PORT");
  }

  const relaySecret = requireEnv("RELAY_SECRET", process.env.RELAY_SECRET);
  const forwardUrl = process.env.FORWARD_URL?.trim() || undefined;
  const grokbotWebhookUrl = process.env.GROKBOT_WEBHOOK_URL?.trim() || undefined;
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  const messagesFile = `${dataDir}/messages.jsonl`;

  return {
    port,
    relaySecret,
    forwardUrl,
    grokbotWebhookUrl,
    dataDir,
    messagesFile,
  };
}
