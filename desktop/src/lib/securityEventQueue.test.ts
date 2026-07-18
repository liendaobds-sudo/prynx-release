// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SECURITY_EVENT_QUEUE_KEY,
  clearPendingSecurityEvents,
  enqueueSecurityEvent,
  getPendingSecurityEvents,
  removePendingSecurityEvent,
  toSecuritySignalDetails,
} from './securityEventQueue';

describe('securityEventQueue', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists telemetry without storing a license key', () => {
    const event = enqueueSecurityEvent('offline_exceeded', { offlineHours: 30 }, 1_000);
    expect(event).not.toBeNull();

    const raw = localStorage.getItem(SECURITY_EVENT_QUEUE_KEY) || '';
    expect(raw).toContain('offline_exceeded');
    expect(raw).not.toContain('license_key');
    expect(getPendingSecurityEvents(1_000)).toHaveLength(1);
  });

  it('deduplicates repeated events inside the cooldown window', () => {
    enqueueSecurityEvent('supabase_blocked', { attempt: 1 }, 1_000);
    enqueueSecurityEvent('supabase_blocked', { attempt: 2 }, 2_000);

    const [event] = getPendingSecurityEvents(2_000);
    expect(event.occurrences).toBe(2);
    expect(event.details).toEqual({ attempt: 2 });
    expect(toSecuritySignalDetails(event)).toMatchObject({
      occurrences: 2,
      occurred_at: new Date(1_000).toISOString(),
      last_occurred_at: new Date(2_000).toISOString(),
    });
  });

  it('removes acknowledged events and can clear the queue', () => {
    const now = Date.now();
    const first = enqueueSecurityEvent('clock_manipulation', {}, now)!;
    enqueueSecurityEvent('offline_exceeded', {}, now + 1_000);

    removePendingSecurityEvent(first.id);
    expect(getPendingSecurityEvents(now + 1_000).map((event) => event.eventType)).toEqual(['offline_exceeded']);

    clearPendingSecurityEvents();
    expect(getPendingSecurityEvents(2_000)).toEqual([]);
  });

  it('drops corrupt and expired queue entries safely', () => {
    localStorage.setItem(SECURITY_EVENT_QUEUE_KEY, '{bad json');
    expect(getPendingSecurityEvents()).toEqual([]);

    enqueueSecurityEvent('offline_exceeded', {}, 1_000);
    const afterThirtyOneDays = 1_000 + 31 * 24 * 60 * 60 * 1000;
    expect(getPendingSecurityEvents(afterThirtyOneDays)).toEqual([]);
  });
});
