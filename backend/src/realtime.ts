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
const PUBLISH_TIMEOUT_MS = 500;

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
  // Fail fast while Redis is down rather than queueing: a booking must never wait on a broadcast.
  const pub = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const sub = new Redis(url);
  const hub = new LocalHub();

  // ioredis reconnects on its own; log the outage at most every 10s instead of on every retry.
  let lastLogged = 0;
  const onError = (err: Error) => {
    if (Date.now() - lastLogged < 10_000) return;
    lastLogged = Date.now();
    console.error('[realtime] redis unavailable:', err.message);
  };
  pub.on('error', onError);
  sub.on('error', onError);

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
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          pub.publish(CHANNEL, JSON.stringify(update)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no reply within ${PUBLISH_TIMEOUT_MS}ms`)), PUBLISH_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        // Bookings never fail because of Redis; clients heal by refetching on reconnect.
        onPublishFailure?.();
        console.error('[realtime] publish failed', (err as Error).message);
      } finally {
        clearTimeout(timer);
      }
    },
    subscribe: (key, listener) => hub.subscribe(key, listener),
    async close() {
      pub.disconnect();
      sub.disconnect();
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
