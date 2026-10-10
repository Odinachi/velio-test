'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ActivityMeta, AvailabilityBar, LiveBadge, Skeleton } from '@/components/bits';
import { get } from '@/lib/api';
import { applyUpdate, useLiveAvailability } from '@/lib/live';
import { useSession } from '@/lib/session';
import type { Activity, Booking } from '@/lib/types';

export default function BrowsePage() {
  const { user } = useSession();
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [mine, setMine] = useState<(Booking & { activity: Activity })[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<{ activities: Activity[] }>('/activities?upcoming=true')
      .then((r) => {
        setActivities(r.activities);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    if (!user) return setMine([]);
    get<{ bookings: (Booking & { activity: Activity })[] }>('/me/bookings').then((r) => setMine(r.bookings)).catch(() => {});
  }, [user]);

  useLiveAvailability(
    'all',
    (u) => setActivities((list) => list?.map((a) => applyUpdate(a, u)) ?? list),
    load,
  );

  const myIds = new Set(mine.map((b) => b.activityId));

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <h1>Things to do with friends</h1>
          <p className="muted" style={{ margin: 0 }}>Grab a spot, then bring your people.</p>
        </div>
        <LiveBadge />
      </div>

      {mine.length > 0 && (
        <section className="stack">
          <h2>Your plans</h2>
          <div className="row">
            {mine.map((b) => (
              <Link key={b.id} href={`/activities/${b.activityId}`} className="pill pill-ok">
                ✓ {b.activity.title}
              </Link>
            ))}
          </div>
        </section>
      )}

      {error && (
        <div className="banner banner-warn">
          <span className="emoji">⚠️</span>
          <div className="stack" style={{ gap: 6 }}>
            <span>{error}</span>
            <button className="btn" onClick={load} style={{ alignSelf: 'flex-start' }}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!activities && !error && (
        <div className="grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} h={170} />
          ))}
        </div>
      )}

      {activities && activities.length === 0 && (
        <div className="card empty">
          <h2>Nothing on yet</h2>
          <p className="muted">Switch to Host and create the first activity.</p>
        </div>
      )}

      {activities && activities.length > 0 && (
        <div className="grid">
          {activities.map((a) => (
            <Link key={a.id} href={`/activities/${a.id}`} className="card activity-card">
              <div className="row spread">
                <h3>{a.title}</h3>
                {myIds.has(a.id) && <span className="pill pill-ok">Going</span>}
              </div>
              <ActivityMeta activity={a} />
              <div className="tiny muted">Hosted by {a.host.name}</div>
              <AvailabilityBar activity={a} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
