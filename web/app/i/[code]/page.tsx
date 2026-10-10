'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ActivityMeta, AvailabilityBar, Skeleton } from '@/components/bits';
import { ApiError, formatPrice, get, post } from '@/lib/api';
import { applyUpdate, useLiveAvailability } from '@/lib/live';
import { useSession } from '@/lib/session';
import type { Activity, Booking, ResolvedInvite, User } from '@/lib/types';

/**
 * Web landing page for invite links. Guests mostly use the Flutter app, but a link opened on a
 * laptop (or without the app) should still work end to end.
 */
export default function InviteLanding() {
  const { code } = useParams<{ code: string }>();
  const { user, signIn } = useSession();
  const [data, setData] = useState<ResolvedInvite | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [name, setName] = useState('');
  const [claiming, setClaiming] = useState<string | null>(null); // idempotency key while in flight
  const [claimError, setClaimError] = useState<{ message: string; key?: string } | null>(null);
  const [claimed, setClaimed] = useState(false);

  const load = useCallback(() => {
    get<ResolvedInvite>(`/invites/${code}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e));
  }, [code]);
  useEffect(load, [load, user?.id]);

  useLiveAvailability(data ? [data.activity.id] : null, (u) =>
    setData((d) => (d ? { ...d, activity: applyUpdate(d.activity, u) } : d)),
  );

  async function claim(key = crypto.randomUUID()) {
    setClaiming(key);
    setClaimError(null);
    try {
      const r = await post<{ user: User; booking: Booking; activity: Activity }>(`/invites/${code}/claim`, {
        idempotencyKey: key,
        ...(user ? {} : { name: name.trim() }),
      });
      if (!user) signIn(r.user);
      setClaimed(true);
      setData((d) => (d ? { ...d, activity: r.activity, myBooking: r.booking } : d));
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'SOLD_OUT' || err.code === 'INVITE_USED' || err.code === 'INVITE_EXPIRED') load();
      setClaimError({ message: err.message, key: err.retryable ? key : undefined });
    } finally {
      setClaiming(null);
    }
  }

  if (error) {
    return (
      <div className="card empty stack" style={{ maxWidth: 480, margin: '0 auto' }}>
        <h2>{error.code === 'INVITE_NOT_FOUND' ? 'Invite not found' : "Couldn't open this invite"}</h2>
        <p className="muted">{error.message}</p>
        <Link href="/" className="btn" style={{ alignSelf: 'center' }}>Browse activities</Link>
      </div>
    );
  }
  if (!data) return <div style={{ maxWidth: 520, margin: '0 auto' }}><Skeleton h={360} /></div>;

  const { invite, activity, myBooking } = data;
  const going = !!myBooking;
  const status = activity.spotsLeft === 0 && invite.status === 'valid' ? 'full' : invite.status;

  return (
    <div className="stack" style={{ maxWidth: 520, margin: '0 auto', gap: 16 }}>
      <div className={`banner ${invite.rail === 'vouch' ? 'banner-vouch' : 'banner-brand'}`}>
        <span className="emoji">{invite.rail === 'vouch' ? '🤝' : '👋'}</span>
        <span>
          {invite.rail === 'vouch' ? (
            <><strong>{invite.inviter.name}</strong> vouched for {invite.contactLabel ? <strong>{invite.contactLabel}</strong> : 'you'} and saved you a way in.</>
          ) : (
            <><strong>{invite.inviter.name}</strong> invited you along.</>
          )}
        </span>
      </div>

      <div className="card stack">
        <h1>{activity.title}</h1>
        <ActivityMeta activity={activity} />
        {activity.description && <p style={{ margin: 0 }}>{activity.description}</p>}
        <AvailabilityBar activity={activity} />

        {data.isInviter ? (
          <div className="banner banner-brand small">This is your invite. Send it to a friend!</div>
        ) : going ? (
          <div className="banner banner-ok">
            <span className="emoji">🎉</span>
            <div className="stack" style={{ gap: 6 }}>
              <strong>{claimed ? "You're in! See you there." : "You're already going."}</strong>
              <Link href={`/activities/${activity.id}`} className="btn" style={{ alignSelf: 'flex-start' }}>See the plan</Link>
            </div>
          </div>
        ) : status === 'full' ? (
          <div className="banner banner-warn">
            <span className="emoji">😕</span>
            <div className="stack" style={{ gap: 6 }}>
              <strong>This one filled up.</strong>
              <span className="small">Keep this page open: if someone cancels, you&apos;ll see the spot appear here.</span>
            </div>
          </div>
        ) : status === 'used' ? (
          <div className="banner banner-warn small">This invite was already claimed. Ask {invite.inviter.name} for a new one, or book directly below.</div>
        ) : status === 'expired' ? (
          <div className="banner banner-warn small">This invite has expired.</div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              claim();
            }}
          >
            {!user && (
              <div className="field">
                <label htmlFor="name">Your first name</label>
                <input id="name" className="input" required maxLength={60} placeholder="So your friends know it's you" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <button className="btn btn-primary btn-lg btn-block" disabled={!!claiming || (!user && !name.trim())}>
              {claiming ? 'Claiming your spot…' : `Claim my spot · ${formatPrice(activity.priceCents, activity.currency)}`}
            </button>
          </form>
        )}

        {claimError && (
          <div className="banner banner-warn small stack" style={{ gap: 6 }}>
            <span>{claimError.message}</span>
            {claimError.key && <button className="btn" onClick={() => claim(claimError.key)}>Try again</button>}
          </div>
        )}
        {(status === 'used' || status === 'expired') && !going && (
          <Link href={`/activities/${activity.id}`} className="btn">View activity</Link>
        )}
      </div>
      <p className="tiny muted" style={{ textAlign: 'center' }}>
        Code <span className="code" style={{ fontSize: 12 }}>{invite.code}</span> · On your phone? Open it in the Velio app.
      </p>
    </div>
  );
}
