export const SECURITY_EVENT_QUEUE_KEY = 'prynx_security_event_queue_v1';

const MAX_QUEUE_SIZE = 50;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

export interface PendingSecurityEvent {
  id: string;
  eventType: string;
  details: Record<string, unknown>;
  occurredAt: number;
  lastOccurredAt: number;
  occurrences: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function getStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPendingEvent(value: unknown): value is PendingSecurityEvent {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.eventType === 'string'
    && isRecord(value.details)
    && typeof value.occurredAt === 'number'
    && typeof value.lastOccurredAt === 'number'
    && typeof value.occurrences === 'number';
}

function makeEventId(now: number): string {
  try {
    return crypto.randomUUID();
  } catch {
    return now.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}

function writeQueue(queue: PendingSecurityEvent[], storage?: StorageLike): void {
  const target = getStorage(storage);
  if (!target) return;
  if (queue.length === 0) {
    target.removeItem(SECURITY_EVENT_QUEUE_KEY);
    return;
  }
  target.setItem(SECURITY_EVENT_QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_SIZE)));
}

export function getPendingSecurityEvents(
  now = Date.now(),
  storage?: StorageLike,
): PendingSecurityEvent[] {
  const target = getStorage(storage);
  if (!target) return [];

  try {
    const raw = target.getItem(SECURITY_EVENT_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('queue is not an array');

    const valid = parsed
      .filter(isPendingEvent)
      .filter((event) => now - event.lastOccurredAt <= MAX_EVENT_AGE_MS)
      .slice(-MAX_QUEUE_SIZE);

    if (valid.length !== parsed.length) writeQueue(valid, target);
    return valid;
  } catch {
    target.removeItem(SECURITY_EVENT_QUEUE_KEY);
    return [];
  }
}

export function enqueueSecurityEvent(
  eventType: string,
  details: Record<string, unknown> = {},
  now = Date.now(),
  storage?: StorageLike,
): PendingSecurityEvent | null {
  const normalizedType = eventType.trim();
  if (!normalizedType || normalizedType.length > 80) return null;

  const queue = getPendingSecurityEvents(now, storage);
  const duplicate = [...queue].reverse().find(
    (event) => event.eventType === normalizedType && now - event.lastOccurredAt <= DEDUPE_WINDOW_MS,
  );

  if (duplicate) {
    duplicate.details = { ...duplicate.details, ...details };
    duplicate.lastOccurredAt = now;
    duplicate.occurrences += 1;
    writeQueue(queue, storage);
    return duplicate;
  }

  const event: PendingSecurityEvent = {
    id: makeEventId(now),
    eventType: normalizedType,
    details: { ...details },
    occurredAt: now,
    lastOccurredAt: now,
    occurrences: 1,
  };
  queue.push(event);
  writeQueue(queue, storage);
  return event;
}

export function removePendingSecurityEvent(id: string, storage?: StorageLike): void {
  const queue = getPendingSecurityEvents(Date.now(), storage).filter((event) => event.id !== id);
  writeQueue(queue, storage);
}

export function clearPendingSecurityEvents(storage?: StorageLike): void {
  getStorage(storage)?.removeItem(SECURITY_EVENT_QUEUE_KEY);
}

export function toSecuritySignalDetails(event: PendingSecurityEvent): Record<string, unknown> {
  return {
    ...event.details,
    occurred_at: new Date(event.occurredAt).toISOString(),
    last_occurred_at: new Date(event.lastOccurredAt).toISOString(),
    occurrences: event.occurrences,
  };
}
