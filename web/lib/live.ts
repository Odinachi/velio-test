'use client';

import { useEffect, useRef } from 'react';
import { API_URL, post } from './api';
import type { Activity, AvailabilityUpdate } from './types';

/** Applies a live update only if it is newer than what we hold, so stale messages can't win. */
export function applyUpdate<T extends Activity>(activity: T, u: AvailabilityUpdate): T {
  if (u.activityId !== activity.id || u.version <= activity.version) return activity;
  return { ...activity, spotsTaken: u.spotsTaken, spotsLeft: u.spotsLeft, capacity: u.capacity, version: u.version };
}

// Latency samples are batched and sent every few seconds, not per message.
const pending: { activityId: string; latencyMs: number; version: number }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function reportLatency(sample: (typeof pending)[number]) {
  pending.push(sample);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const events = pending.splice(0, 100).map((s) => ({ name: 'availability_received', ...s }));
    if (events.length) post('/events', { events }).catch(() => {});
  }, 3000);
}

/**
 * Subscribes to live availability. Pass activity ids, or 'all' for every activity.
 * `onReconnect` fires after the stream recovers so the caller can refetch anything it missed.
 */
export function useLiveAvailability(
  ids: string[] | 'all' | null,
  onUpdate: (u: AvailabilityUpdate) => void,
  onReconnect?: () => void,
) {
  const handlers = useRef({ onUpdate, onReconnect });
  useEffect(() => {
    handlers.current = { onUpdate, onReconnect };
  });
  const key = ids === null ? null : ids === 'all' ? 'all' : [...ids].sort().join(',');

  useEffect(() => {
    if (key === null || key === '') return;
    const url = `${API_URL}/stream${key === 'all' ? '' : `?activityIds=${key}`}`;
    const source = new EventSource(url);
    let clockOffset = 0; // serverTime - clientTime
    let hadError = false;

    const syncClock = (e: MessageEvent) => {
      clockOffset = JSON.parse(e.data).serverTime - Date.now();
    };
    source.addEventListener('hello', (e) => {
      syncClock(e as MessageEvent);
      if (hadError) handlers.current.onReconnect?.();
      hadError = false;
    });
    source.addEventListener('ping', (e) => syncClock(e as MessageEvent));
    source.addEventListener('availability', (e) => {
      const u = JSON.parse((e as MessageEvent).data) as AvailabilityUpdate;
      handlers.current.onUpdate(u);
      const latencyMs = Math.max(0, Date.now() + clockOffset - u.committedAt);
      reportLatency({ activityId: u.activityId, latencyMs, version: u.version });
    });
    source.onerror = () => {
      hadError = true; // EventSource reconnects on its own; we refetch once it's back.
    };
    return () => source.close();
  }, [key]);
}
