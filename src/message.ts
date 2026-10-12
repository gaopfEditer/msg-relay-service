import { randomUUID } from "node:crypto";

export type MessageStatus = "received" | "forwarded" | "failed";

export interface Message {
  traceId: string;
  source: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface StoredRecord extends Message {
  status: MessageStatus;
  updatedAt: string;
  error?: string;
  direction?: "inbound" | "outbound";
}

export function createMessage(
  source: string,
  type: string,
  payload: unknown,
  traceId?: string
): Message {
  return {
    traceId: traceId ?? randomUUID(),
    source,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}

export function toStoredRecord(
  message: Message,
  status: MessageStatus,
  extra?: Partial<Pick<StoredRecord, "error" | "direction">>
): StoredRecord {
  const now = new Date().toISOString();
  return {
    ...message,
    status,
    updatedAt: now,
    ...extra,
  };
}
