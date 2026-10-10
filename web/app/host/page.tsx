'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ActivityMeta, AvailabilityBar, LiveBadge, Skeleton } from '@/components/bits';
import { ApiError, get, post } from '@/lib/api';
import { applyUpdate, useLiveAvailability } from '@/lib/live';
import { useSession } from '@/lib/session';
import type { Activity } from '@/lib/types';

function defaultStart() {
  const d = new Date(Date.now() + 3 * 86400_000);
  d.setHours(18, 0, 0, 0);
  // datetime-local wants local time without a zone.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function HostPage() {
  const { user, ready } = useSession();
  const [activities, setActivities] = useState<Activity[] | null>(null);

  const load = useCallback(() => {
    if (!user) return;
    get<{ activities: Activity[] }>(`/activities?hostId=${user.id}`).then((r) => setActivities(r.activities)).catch(() => setActivities([]));
  }, [user]);
  useEffect(load, [load]);

  useLiveAvailability(
    activities?.map((a) => a.id) ?? null,
    (u) => setActivities((list) => list?.map((a) => applyUpdate(a, u)) ?? list),
    load,
  );

  if (!ready) return <Skeleton h={300} />;
  if (!user) {
    return (
      <div className="card empty">
        <h2>Host an activity</h2>
        <p className="muted">Pick or create a profile (top right) to start hosting.</p>
      </div>
    );
  }

  return (
    <div className="two-col">
      <section className="stack" style={{ gap: 16 }}>
        <div className="row spread">
          <h1>Your activities</h1>
          <LiveBadge />
        </div>
        {!activities && <Skeleton h={160} />}
        {activities?.length === 0 && (
          <div className="card empty">
            <p className="muted" style={{ margin: 0 }}>You haven&apos;t created anything yet. Start with the form.</p>
          </div>
        )}
        {activities?.map((a) => (
          <Link key={a.id} href={`/host/${a.id}`} className="card activity-card">
            <div className="row spread">
              <h3>{a.title}</h3>
              {!a.invitesEnabled && <span className="pill tiny" title="This activity is in the invite holdout group">holdout</span>}
            </div>
            <ActivityMeta activity={a} />
            <AvailabilityBar activity={a} />
          </Link>
        ))}
      </section>
      <CreateActivity onCreated={(a) => setActivities((list) => [a, ...(list ?? [])])} />
    </div>
  );
}

function CreateActivity({ onCreated }: { onCreated: (a: Activity) => void }) {
  const [form, setForm] = useState({ title: '', description: '', location: '', startsAt: defaultStart(), price: '25', capacity: '10' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { activity } = await post<{ activity: Activity }>('/activities', {
        title: form.title,
        description: form.description,
        location: form.location,
        startsAt: new Date(form.startsAt).toISOString(),
        priceCents: Math.round(Number(form.price || 0) * 100),
        capacity: Number(form.capacity),
      });
      onCreated(activity);
      setForm({ ...form, title: '', description: '', location: '' });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>New activity</h2>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" className="input" required maxLength={120} placeholder="Sunset Kayaking" value={form.title} onChange={set('title')} />
      </div>
      <div className="field">
        <label htmlFor="desc">Description</label>
        <textarea id="desc" className="input" rows={3} maxLength={2000} placeholder="What should people expect?" value={form.description} onChange={set('description')} />
      </div>
      <div className="field">
        <label htmlFor="loc">Location</label>
        <input id="loc" className="input" maxLength={200} placeholder="Lekki Lagoon" value={form.location} onChange={set('location')} />
      </div>
      <div className="field">
        <label htmlFor="when">Date and time</label>
        <input id="when" type="datetime-local" className="input" required value={form.startsAt} onChange={set('startsAt')} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="price">Price (USD)</label>
          <input id="price" type="number" min="0" step="0.01" className="input" value={form.price} onChange={set('price')} />
        </div>
        <div className="field">
          <label htmlFor="cap">Spots</label>
          <input id="cap" type="number" min="1" max="10000" required className="input" value={form.capacity} onChange={set('capacity')} />
        </div>
      </div>
      {error && <div className="banner banner-warn small">{error}</div>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create activity'}</button>
      <p className="tiny muted" style={{ margin: 0 }}>Prices are shown to bookers but not charged in this prototype.</p>
    </form>
  );
}
