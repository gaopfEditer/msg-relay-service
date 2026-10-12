export interface ForwardResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<ForwardResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        statusCode: res.status,
        error: text || `HTTP ${res.status}`,
      };
    }

    return { ok: true, statusCode: res.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
