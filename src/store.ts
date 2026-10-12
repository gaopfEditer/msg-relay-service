import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredRecord } from "./message.js";

export class MessageStore {
  private readonly filePath: string;
  private readonly byTraceId = new Map<string, StoredRecord>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as StoredRecord;
          if (record.traceId) {
            this.byTraceId.set(record.traceId, record);
          }
        } catch {
          // skip corrupt lines
        }
      }
    } catch (err: unknown) {
      if (isENOENT(err)) return;
      throw err;
    }
  }

  get(traceId: string): StoredRecord | undefined {
    return this.byTraceId.get(traceId);
  }

  async save(record: StoredRecord): Promise<void> {
    this.byTraceId.set(record.traceId, record);
    const line = JSON.stringify(record) + "\n";
    await appendFile(this.filePath, line, "utf8");
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
