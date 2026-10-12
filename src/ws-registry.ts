import type { WebSocket } from "ws";

export interface WsClientMeta {
  clientId: string;
  botId?: string;
  connectedAt: string;
}

interface RegisteredClient {
  socket: WebSocket;
  meta: WsClientMeta;
}

/**
 * In-memory registry of connected WebSocket clients (one active socket per clientId).
 */
export class WsClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();

  register(clientId: string, socket: WebSocket, meta: Omit<WsClientMeta, "clientId" | "connectedAt">): void {
    const existing = this.clients.get(clientId);
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(1000, "replaced");
      } catch {
        // ignore
      }
    }
    this.clients.set(clientId, {
      socket,
      meta: {
        clientId,
        botId: meta.botId,
        connectedAt: new Date().toISOString(),
      },
    });
  }

  unregister(clientId: string, socket: WebSocket): void {
    const entry = this.clients.get(clientId);
    if (entry && entry.socket === socket) {
      this.clients.delete(clientId);
    }
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  isConnected(clientId: string): boolean {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    return entry.socket.readyState === entry.socket.OPEN;
  }

  send(clientId: string, data: string): boolean {
    const entry = this.clients.get(clientId);
    if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
      return false;
    }
    entry.socket.send(data);
    return true;
  }

  listConnected(): WsClientMeta[] {
    const out: WsClientMeta[] = [];
    for (const entry of this.clients.values()) {
      if (entry.socket.readyState === entry.socket.OPEN) {
        out.push(entry.meta);
      }
    }
    return out;
  }
}
