import { Redis } from 'ioredis';

export interface AvailabilityUpdate {
  activityId: string;
  spotsTaken: number;
  capacity: number;
  spotsLeft: number;
  version: number;
  /** Server time (ms) when the change committed. Lets clients measure end-to-end latency. */
  committedAt: number;
}

type Listener = (u: AvailabilityUpdate) => void;

/**
 * Fans availability changes out to every open client.
 *
 * Postgres stays the source of truth; this bus only carries notifications. Each API instance
 * publishes after commit and subscribes to the shared channel, so a booking on instance A
 * reaches SSE clients connected to instance B.
 */
export interface AvailabilityBus {
  publish(update: AvailabilityUpdate): Promise<void>;
  /** Listen for one activity, or every activity with '*'. Returns an unsubscribe function. */
  subscribe(activityId: string | '*', listener: Listener): () => void;
  close(): Promise<void>;
}

const CHANNEL = 'velio:availability';

class LocalHub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(key: string, listener: Listener) {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  dispatch(u: AvailabilityUpdate) {
    for (const key of [u.activityId, '*']) {
      for (const l of this.listeners.get(key) ?? []) {
        try {
          l(u);
        } catch (err) {
          console.error('[realtime] listener failed', err);
        }
      }
    }
  }
}

export function createRedisBus(url: string, onPublishFailure?: () => void): AvailabilityBus {
  const pub = new Redis(url, { maxRetriesPerRequest: 2 });
  const sub = new Redis(url);
  const hub = new LocalHub();

  sub.subscribe(CHANNEL).catch((err) => console.error('[realtime] subscribe failed', err.message));
  sub.on('message', (_channel: string, message: string) => {
    try {
      hub.dispatch(JSON.parse(message));
    } catch (err) {
      console.error('[realtime] bad message', err);
    }
  });

  return {
    async publish(update) {
      try {
        await pub.publish(CHANNEL, JSON.stringify(update));
      } catch (err) {
        // Bookings never fail because of Redis; clients heal by refetching on reconnect.
        onPublishFailure?.();
        console.error('[realtime] publish failed', (err as Error).message);
      }
    },
    subscribe: (key, listener) => hub.subscribe(key, listener),
    async close() {
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

/** In-process bus for tests and single-instance runs without Redis. */
export function createLocalBus(): AvailabilityBus {
  const hub = new LocalHub();
  return {
    async publish(update) {
      queueMicrotask(() => hub.dispatch(update));
    },
    subscribe: (key, listener) => hub.subscribe(key, listener),
    async close() {},
  };
}
