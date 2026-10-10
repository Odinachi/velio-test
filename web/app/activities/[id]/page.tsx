'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityMeta, AvailabilityBar, Avatar, LiveBadge, Skeleton, useToast } from '@/components/bits';
import { InvitePanel } from '@/components/InvitePanel';
import { ApiError, del, formatPrice, get, post } from '@/lib/api';
import { applyUpdate, useLiveAvailability } from '@/lib/live';
import { useSession } from '@/lib/session';
import type { Activity, Attendee, Booking } from '@/lib/types';

type BookState =
  | { kind: 'idle' }
  | { kind: 'pending'; key: string }
  | { kind: 'sold_out' }
  | { kind: 'failed'; key: string; message: string };

export default function ActivityPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const toast = useToast();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [state, setState] = useState<BookState>({ kind: 'idle' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [justBooked, setJustBooked] = useState(false);
  const viewed = useRef(false);

  const load = useCallback(async () => {
    try {
      const [detail, people] = await Promise.all([
        get<{ activity: Activity; myBooking: Booking | null; isHost: boolean }>(`/activities/${id}`),
        get<{ attendees: Attendee[] }>(`/activities/${id}/attendees`),
      ]);
      setActivity((cur) => (cur && cur.version > detail.activity.version ? cur : detail.activity));
      setBooking(detail.myBooking);
      setIsHost(detail.isHost);
      setAttendees(people.attendees);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  useEffect(() => {
    if (viewed.current || !activity) return;
    viewed.current = true;
    post('/events', { events: [{ name: 'activity_viewed', activityId: id }] }).catch(() => {});
  }, [activity, id]);

  // Refresh the guest list a beat after availability changes (batched, not per message).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveAvailability(
    id ? [id] : null,
    (u) => {
      setActivity((a) => (a ? applyUpdate(a, u) : a));
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        get<{ attendees: Attendee[] }>(`/activities/${id}/attendees`).then((r) => setAttendees(r.attendees)).catch(() => {});
      }, 400);
    },
    load,
  );

  async function book(key = crypto.randomUUID()) {
    if (!activity) return;
    setState({ kind: 'pending', key });
    try {
      const r = await post<{ booking: Booking; activity: Activity }>(`/activities/${id}/bookings`, { idempotencyKey: key });
      setBooking(r.booking);
      setActivity((a) => (a && a.version > r.activity.version ? a : r.activity));
      setState({ kind: 'idle' });
      setJustBooked(true);
      if ('vibrate' in navigator) navigator.vibrate?.(30);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'SOLD_OUT') setState({ kind: 'sold_out' });
      else if (err.code === 'ALREADY_BOOKED') {
        setState({ kind: 'idle' });
        load();
      } else if (err.retryable) {
        // Same key on retry, so a request that actually went through can't book twice.
        setState({ kind: 'failed', key, message: err.message });
      } else setState({ kind: 'failed', key: crypto.randomUUID(), message: err.message });
    }
  }

  async function cancel() {
    if (!booking || !confirm('Give up your spot? Someone else will be able to take it.')) return;
    try {
      await del(`/bookings/${booking.id}`);
      setBooking(null);
      setJustBooked(false);
      toast.show('Your spot is released');
      load();
    } catch (e) {
      toast.show((e as Error).message);
    }
  }

  if (loadError && !activity) {
    return (
      <div className="card empty stack">
        <h2>We couldn&apos;t load this activity</h2>
        <p className="muted">{loadError}</p>
        <button className="btn" onClick={load} style={{ alignSelf: 'center' }}>
          Try again
        </button>
      </div>
    );
  }
  if (!activity) return <Skeleton h={320} />;

  // Optimistic view: while the request is in flight we already show the spot as taken.
  const pending = state.kind === 'pending';
  const shown = pending ? { ...activity, spotsLeft: Math.max(0, activity.spotsLeft - 1), spotsTaken: Math.min(activity.capacity, activity.spotsTaken + 1) } : activity;
  const going = !!booking || pending;
  const soldOut = activity.spotsLeft === 0 && !going;

  return (
    <div className="two-col">
      <section className="stack" style={{ gap: 20 }}>
        <Link href="/" className="small muted">← All activities</Link>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row spread">
            <h1>{activity.title}</h1>
            <LiveBadge />
          </div>
          <ActivityMeta activity={activity} />
          <div className="small muted">Hosted by {activity.host.name}</div>
        </div>
        {activity.description && <p style={{ margin: 0 }}>{activity.description}</p>}

        <div className="card stack">
          <AvailabilityBar activity={shown} />

          {going ? (
            <div className="banner banner-ok">
              <span className="emoji">🎉</span>
              <div className="stack" style={{ gap: 4 }}>
                <strong>{pending ? "You're in! Confirming your spot…" : "You're going!"}</strong>
                {!pending && <span className="small muted">Price shown at booking: {formatPrice(activity.priceCents, activity.currency)} (no payment in this prototype).</span>}
              </div>
            </div>
          ) : state.kind === 'sold_out' || soldOut ? (
            <div className="banner banner-warn">
              <span className="emoji">😕</span>
              <div className="stack" style={{ gap: 6 }}>
                <strong>{state.kind === 'sold_out' ? 'So close. Someone grabbed the last spot a moment before you.' : 'This one is full.'}</strong>
                <span className="small">Spots open up when people cancel, and this page updates live, so keep it open or browse other plans.</span>
                <Link href="/" className="btn" style={{ alignSelf: 'flex-start' }}>
                  See other activities
                </Link>
              </div>
            </div>
          ) : isHost ? (
            <div className="banner banner-brand">
              <span className="emoji">🧭</span>
              <span>You&apos;re hosting this one. <Link href={`/host/${activity.id}`} style={{ textDecoration: 'underline' }}>See live attendance</Link>.</span>
            </div>
          ) : !user ? (
            <div className="banner banner-brand">
              <span className="emoji">👋</span>
              <span>Pick a profile (top right) to book a spot.</span>
            </div>
          ) : (
            <button className="btn btn-primary btn-lg btn-block" disabled={activity.hasStarted} onClick={() => book()}>
              Book a spot · {formatPrice(activity.priceCents, activity.currency)}
            </button>
          )}

          {state.kind === 'failed' && (
            <div className="banner banner-warn">
              <span className="emoji">📶</span>
              <div className="stack" style={{ gap: 6 }}>
                <span>{state.message}</span>
                <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => book(state.key)}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {booking && !pending && (
            <button className="btn btn-ghost small" style={{ alignSelf: 'flex-start' }} onClick={cancel}>
              Can&apos;t make it? Release my spot
            </button>
          )}
        </div>

        {(booking || isHost) && !pending && (
          <InvitePanel activity={activity} highlight={justBooked} onCopied={() => toast.show('Link copied')} />
        )}
      </section>

      <aside className="card stack">
        <div className="row spread">
          <h2>Who&apos;s going</h2>
          <span className="tiny muted">{attendees.length} of {activity.capacity}</span>
        </div>
        {attendees.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>Nobody yet. Be the first.</p>
        ) : (
          <ul className="list">
            {attendees.map((p) => (
              <li key={p.userId}>
                <span className="row" style={{ gap: 10 }}>
                  <Avatar name={p.name} />
                  <span className="stack" style={{ gap: 0 }}>
                    <span className="small">{p.name}{p.userId === user?.id ? ' (you)' : ''}</span>
                    {p.invitedBy && <span className="tiny muted">invited by {p.invitedBy}</span>}
                  </span>
                </span>
                {p.via === 'vouch' && <span className="pill pill-vouch">vouched</span>}
              </li>
            ))}
          </ul>
        )}
      </aside>
      {toast.node}
    </div>
  );
}
