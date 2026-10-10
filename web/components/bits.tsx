'use client';

import { useEffect, useRef, useState } from 'react';
import { formatPrice, formatWhen } from '@/lib/api';
import type { Activity } from '@/lib/types';

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return <span className="avatar" aria-hidden>{initials || '?'}</span>;
}

/** Spots-left counter that pulses when a live update changes it. */
export function SpotsLeft({ activity }: { activity: Activity }) {
  const [bump, setBump] = useState(false);
  const prev = useRef(activity.spotsLeft);
  useEffect(() => {
    if (prev.current !== activity.spotsLeft) {
      prev.current = activity.spotsLeft;
      setBump(true);
      const t = setTimeout(() => setBump(false), 500);
      return () => clearTimeout(t);
    }
  }, [activity.spotsLeft]);

  if (activity.hasStarted) return <span className="pill">Started</span>;
  if (activity.spotsLeft === 0) return <span className="pill pill-warn">Sold out</span>;
  return (
    <span className={`pill ${activity.spotsLeft <= 3 ? 'pill-brand' : 'pill-ok'} ${bump ? 'bump' : ''}`} aria-live="polite">
      {activity.spotsLeft} {activity.spotsLeft === 1 ? 'spot' : 'spots'} left
    </span>
  );
}

export function AvailabilityBar({ activity }: { activity: Activity }) {
  const pct = Math.round((activity.spotsTaken / activity.capacity) * 100);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={`bar ${activity.spotsLeft === 0 ? 'full' : ''}`} role="progressbar" aria-valuenow={activity.spotsTaken} aria-valuemax={activity.capacity}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row spread tiny muted">
        <span>
          {activity.spotsTaken} / {activity.capacity} going
        </span>
        <SpotsLeft activity={activity} />
      </div>
    </div>
  );
}

export function ActivityMeta({ activity }: { activity: Activity }) {
  return (
    <div className="row small muted" style={{ gap: 8 }}>
      <span>📅 {formatWhen(activity.startsAt)}</span>
      {activity.location && <span>📍 {activity.location}</span>}
      <span>💳 {formatPrice(activity.priceCents, activity.currency)}</span>
    </div>
  );
}

export function LiveBadge() {
  return (
    <span className="row tiny muted" style={{ gap: 6 }}>
      <span className="live-dot" /> Live
    </span>
  );
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2200);
    return () => clearTimeout(t);
  }, [msg]);
  return { show: setMsg, node: msg ? <div className="toast" role="status">{msg}</div> : null };
}

export function CopyBox({ value, onCopied }: { value: string; onCopied?: () => void }) {
  return (
    <div className="copy-box">
      <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label="Invite link" />
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            onCopied?.();
          } catch {}
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} />;
}
