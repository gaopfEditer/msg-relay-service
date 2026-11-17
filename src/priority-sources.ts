import { readFileSync } from "node:fs";

export interface PrioritySource {
  id: string;
  name: string;
}

/** Used when DATA_DIR/priority-sources.json does not exist yet. */
export const DEFAULT_PRIORITY_SOURCES: readonly PrioritySource[] = [
  { id: "pangmao", name: "胖猫社区" },
];

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRawList(parsed: unknown, filePath: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.sources)) return parsed.sources;
  throw new Error(
    `Priority sources file ${filePath} must be an array or { "sources": [...] }`
  );
}

/**
 * Load the priority-queue source allowlist.
 * Missing file → built-in default (pangmao only).
 * Present file replaces the default entirely, so adding a source is a config edit.
 */
export function loadPrioritySources(filePath: string): PrioritySource[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return DEFAULT_PRIORITY_SOURCES.map((source) => ({ ...source }));
    }
    throw new Error(
      `Failed to load priority sources from ${filePath}: ${formatErr(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    throw new Error(
      `Invalid priority sources JSON in ${filePath}: ${formatErr(err)}`
    );
  }

  const map = new Map<string, PrioritySource>();
  for (const item of extractRawList(parsed, filePath)) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!SOURCE_ID_RE.test(id)) {
      throw new Error(
        `Invalid priority source id in ${filePath}: ${JSON.stringify(item.id)}`
      );
    }
    const name =
      typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    map.set(id, { id, name });
  }

  if (map.size === 0) {
    throw new Error(`Priority sources file ${filePath} has no valid sources`);
  }

  return [...map.values()];
}

export function findPrioritySource(
  sources: readonly PrioritySource[],
  id: string
): PrioritySource | undefined {
  return sources.find((source) => source.id === id);
}
