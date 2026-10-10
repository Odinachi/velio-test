export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** True when retrying the same request might succeed (network trouble or a server error). */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

const USER_KEY = 'velio.userId';
const DEVICE_KEY = 'velio.deviceId';

function storage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getUserId() {
  return storage(USER_KEY);
}

export function setUserId(id: string | null) {
  try {
    if (id) localStorage.setItem(USER_KEY, id);
    else localStorage.removeItem(USER_KEY);
  } catch {
    // Private mode: identity just won't survive a reload.
  }
}

/** A stable anonymous id per browser, so invite opens can be de-duplicated. */
export function getDeviceId() {
  let id = storage(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {}
  }
  return id;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-device-id': getDeviceId() };
  const userId = getUserId();
  if (userId) headers['x-user-id'] = userId;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(API_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', "We couldn't reach Velio. Check your connection and try again.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? 'Something went wrong.');
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const del = <T>(path: string) => api<T>('DELETE', path);

export function formatPrice(cents: number, currency: string) {
  if (cents === 0) return 'Free';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export function formatWhen(iso: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}
