import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

/** In-memory index retains only the newest items. Older lines stay in the JSONL file. */
export const PRIORITY_MEMORY_CAP = 1000;

/** Default page size for HTTP peek and WebSocket replay. */
export const PRIORITY_DEFAULT_LIMIT = 50;

/** Hard cap for one HTTP peek or one WebSocket replay. */
export const PRIORITY_MAX_LIMIT = 200;

export interface PriorityMeta {
  via: "ocr" | "text";
  yield_pct: number | null;
}

export interface PriorityItem {
  id: string;
  source: string;
  card: Record<string, unknown>;
  meta: PriorityMeta;
  createdAt: string;
}

export interface PriorityPageOptions {
  source?: string;
  limit: number;
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredItem(value: unknown): PriorityItem | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (typeof value.source !== "string" || !value.source) return undefined;
  if (typeof value.createdAt !== "string" || !value.createdAt) return undefined;
  if (!isRecord(value.card)) return undefined;
  if (!isRecord(value.meta)) return undefined;
  if (value.meta.via !== "ocr" && value.meta.via !== "text") return undefined;
  const yieldPct = value.meta.yield_pct;
  if (yieldPct !== null && (typeof yieldPct !== "number" || !Number.isFinite(yieldPct))) {
    return undefined;
  }
  return {
    id: value.id,
    source: value.source,
    card: value.card,
    meta: { via: value.meta.via, yield_pct: yieldPct },
    createdAt: value.createdAt,
  };
}

function cloneItem(item: PriorityItem): PriorityItem {
  return {
    id: item.id,
    source: item.source,
    card: structuredClone(item.card),
    meta: { ...item.meta },
    createdAt: item.createdAt,
  };
}

export function toPriorityFrame(item: PriorityItem): string {
  return JSON.stringify({
    type: "priority_card",
    id: item.id,
    source: item.source,
    card: item.card,
    meta: item.meta,
    createdAt: item.createdAt,
  });
}

export type EnqueueBodyResult =
  | {
      ok: true;
      value: {
        source: string;
        card: Record<string, unknown>;
        meta: PriorityMeta;
      };
    }
  | { ok: false; message: string };

export function parseEnqueueBody(body: unknown): EnqueueBodyResult {
  if (!isRecord(body)) {
    return { ok: false, message: "JSON object required" };
  }
  if (typeof body.source !== "string" || body.source.trim() === "") {
    return { ok: false, message: "source is required" };
  }
  if (!isRecord(body.card)) {
    return { ok: false, message: "card must be a JSON object" };
  }
  if (!isRecord(body.meta)) {
    return { ok: false, message: "meta is required" };
  }
  if (body.meta.via !== "ocr" && body.meta.via !== "text") {
    return { ok: false, message: 'meta.via must be "ocr" or "text"' };
  }
  if (!Object.prototype.hasOwnProperty.call(body.meta, "yield_pct")) {
    return { ok: false, message: "meta.yield_pct is required (number or null)" };
  }
  const yieldPct = body.meta.yield_pct;
  if (yieldPct !== null && (typeof yieldPct !== "number" || !Number.isFinite(yieldPct))) {
    return { ok: false, message: "meta.yield_pct must be a finite number or null" };
  }

  let card: Record<string, unknown>;
  try {
    card = structuredClone(body.card);
  } catch {
    return { ok: false, message: "card must be JSON-serializable" };
  }

  return {
    ok: true,
    value: {
      source: body.source.trim(),
      card,
      meta: { via: body.meta.via, yield_pct: yieldPct },
    },
  };
}

export function parsePriorityLimit(
  raw: string | undefined,
  fallback = PRIORITY_DEFAULT_LIMIT
): { ok: true; limit: number } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, limit: fallback };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  const limit = Number(raw.trim());
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  return { ok: true, limit: Math.min(limit, PRIORITY_MAX_LIMIT) };
}

/**
 * Append-only JSONL queue plus a bounded in-memory index of the newest items.
 * `runExclusive` serializes appends and replay snapshots so a subscriber does not
 * miss or duplicate an item that is being written.
 */
export class PriorityQueueStore {
  private readonly filePath: string;
  private readonly memoryCap: number;
  private items: PriorityItem[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string, memoryCap = PRIORITY_MEMORY_CAP) {
    this.filePath = filePath;
    this.memoryCap = memoryCap;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err: unknown) {
      if (isENOENT(err)) return;
      throw err;
    }

    const loaded: PriorityItem[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = parseStoredItem(JSON.parse(trimmed) as unknown);
        if (item) loaded.push(item);
      } catch {
        // skip corrupt lines
      }
    }
    this.items = loaded.slice(-this.memoryCap);
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async append(item: PriorityItem, onStored?: (item: PriorityItem) => void): Promise<void> {
    const line = JSON.stringify(item) + "\n";
    await this.runExclusive(async () => {
      await appendFile(this.filePath, line, "utf8");
      this.items.push(item);
      if (this.items.length > this.memoryCap) {
        this.items.splice(0, this.items.length - this.memoryCap);
      }
      onStored?.(item);
    });
  }

  recent(options: PriorityPageOptions): PriorityItem[] {
    return this.filter(options.source).slice(-options.limit).map(cloneItem);
  }

  after(
    id: string,
    options: PriorityPageOptions
  ): { found: boolean; items: PriorityItem[] } {
    const filtered = this.filter(options.source);
    const index = filtered.findIndex((item) => item.id === id);
    if (index === -1) return { found: false, items: [] };
    return {
      found: true,
      items: filtered.slice(index + 1, index + 1 + options.limit).map(cloneItem),
    };
  }

  private filter(source: string | undefined): PriorityItem[] {
    if (!source) return this.items;
    return this.items.filter((item) => item.source === source);
  }
}
