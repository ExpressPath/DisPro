import type { AuditEvent } from "./types.js";
import { hashObject, makeId } from "./ids.js";

export interface AuditEventInput {
  type: string;
  orderId: string;
  taskId?: string;
  actorNodeId?: string;
  payload: unknown;
}

export function appendAuditEvent(chain: readonly AuditEvent[], input: AuditEventInput, now = new Date()): AuditEvent {
  const previousHash = chain.at(-1)?.eventHash ?? "GENESIS";
  const payloadHash = hashObject(input.payload);
  const createdAt = now.toISOString();
  const base = {
    type: input.type,
    orderId: input.orderId,
    taskId: input.taskId,
    actorNodeId: input.actorNodeId,
    payloadHash,
    previousHash,
    createdAt
  };
  const eventHash = hashObject(base);
  const event: AuditEvent = {
    id: makeId("evt", { ...base, eventHash }),
    type: input.type,
    orderId: input.orderId,
    payloadHash,
    previousHash,
    eventHash,
    createdAt
  };

  if (input.taskId) {
    event.taskId = input.taskId;
  }

  if (input.actorNodeId) {
    event.actorNodeId = input.actorNodeId;
  }

  return event;
}

export function verifyAuditChain(chain: readonly AuditEvent[]): boolean {
  let previousHash = "GENESIS";

  for (const event of chain) {
    if (event.previousHash !== previousHash) {
      return false;
    }

    const base = {
      type: event.type,
      orderId: event.orderId,
      taskId: event.taskId,
      actorNodeId: event.actorNodeId,
      payloadHash: event.payloadHash,
      previousHash: event.previousHash,
      createdAt: event.createdAt
    };

    if (hashObject(base) !== event.eventHash) {
      return false;
    }

    previousHash = event.eventHash;
  }

  return true;
}
