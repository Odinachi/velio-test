'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityMeta, AvailabilityBar, Avatar, LiveBadge, Skeleton, useToast } from '@/components/bits';
import { InvitePanel } from '@/components/InvitePanel';
import { formatWhen, get } from '@/lib/api';
import { applyUpdate, useLiveAvailability } from '@/lib/live';
import type { Activity, Attendee } from '@/lib/types';

export default function LiveAttendancePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);

  const loadAttendees = useCallback(async () => {
    const r = await get<{ attendees: Attendee[] }>(`/activities/${id}/attendees`);
    // Highlight people who just joined.
    if (known.current) {
      const added = r.attendees.filter((a) => !known.current!.has(a.userId)).map((a) => a.userId);
      if (added.length) {
        setFresh(new Set(added));
        setTimeout(() => setFresh(new Set()), 2500);
      }
    }
    known.current = new Set(r.attendees.map((a) => a.userId));
    setAttendees(r.attendees);
  }, [id]);

  const load = useCallback(async () => {
    const r = await get<{ activity: Activity }>(`/activities/${id}`);
    setActivity((cur) => (cur && cur.version > r.activity.version ? cur : r.activity));
    await loadAttendees();
  }, [id, loadAttendees]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveAvailability(
    id ? [id] : null,
    (u) => {
      setActivity((a) => (a ? applyUpdate(a, u) : a));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => loadAttendees().catch(() => {}), 300);
    },
    () => load().catch(() => {}),
  );

  if (!activity) return <Skeleton h={300} />;

  const viaInvite = attendees.filter((a) => a.via !== 'direct').length;
  const vouched = attendees.filter((a) => a.via === 'vouch').length;

  return (
    <div className="two-col">
      <section className="stack" style={{ gap: 16 }}>
        <Link href="/host" className="small muted">← Your activities</Link>
        <div className="row spread">
          <h1>{activity.title}</h1>
          <LiveBadge />
        </div>
        <ActivityMeta activity={activity} />
        <div className="card stack">
          <AvailabilityBar activity={activity} />
          <div className="row small muted">
            <span>{attendees.length - viaInvite} booked directly</span>·<span>{viaInvite} came through invites</span>·<span>{vouched} vouched</span>
          </div>
        </div>
        <InvitePanel activity={activity} onCopied={() => toast.show('Link copied')} />
      </section>
      <aside className="card stack">
        <h2>Live attendance</h2>
        {attendees.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>No one yet. Share your activity to get it moving.</p>
        ) : (
          <ul className="list">
            {attendees.map((p) => (
              <li key={p.userId} style={fresh.has(p.userId) ? { background: 'var(--ok-soft)', borderRadius: 8 } : undefined}>
                <span className="row" style={{ gap: 10 }}>
                  <Avatar name={p.name} />
                  <span className="stack" style={{ gap: 0 }}>
                    <span className="small">{p.name}</span>
                    <span className="tiny muted">
                      {formatWhen(p.bookedAt)}
                      {p.invitedBy ? ` · invited by ${p.invitedBy}` : ''}
                    </span>
                  </span>
                </span>
                <span className={`pill tiny ${p.via === 'vouch' ? 'pill-vouch' : p.via === 'public' ? 'pill-brand' : ''}`}>
                  {p.via === 'direct' ? 'direct' : p.via === 'vouch' ? 'vouch' : 'link'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {toast.node}
    </div>
  );
}
