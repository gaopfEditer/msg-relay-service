import type { FastifyRequest } from "fastify";

export function extractSecret(req: FastifyRequest): string | undefined {
  const header = req.headers["x-relay-secret"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return undefined;
}

export function assertAuth(req: FastifyRequest, secret: string): void {
  const provided = extractSecret(req);
  if (!provided || provided !== secret) {
    const err = new Error("Unauthorized") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
}

export function isValidRelaySecret(provided: string | undefined, secret: string): boolean {
  return Boolean(provided && provided === secret);
}
