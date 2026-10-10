'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, post } from '@/lib/api';
import type { Activity, Invite, Rail } from '@/lib/types';
import { CopyBox } from './bits';

/**
 * The two invite rails. A vouch names one person and says "I stand behind them"; a public link
 * is for reach. The copy makes that difference explicit because attribution records it.
 */
export function InvitePanel({ activity, highlight, onCopied }: { activity: Activity; highlight?: boolean; onCopied: () => void }) {
  const [rail, setRail] = useState<Rail>('vouch');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [latest, setLatest] = useState<Invite | null>(null);

  const load = useCallback(() => {
    get<{ invites: Invite[] }>('/me/invites')
      .then((r) => setInvites(r.invites.filter((i) => i.activityId === activity.id)))
      .catch(() => {});
  }, [activity.id]);
  useEffect(load, [load]);

  if (!activity.invitesEnabled) {
    // Holdout activities (or feature off): no invite UI at all, so the experiment stays clean.
    return null;
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = rail === 'vouch' ? { rail, contactLabel: contact.trim() } : { rail };
      const r = await post<{ invite: Invite }>(`/activities/${activity.id}/invites`, body);
      setLatest(r.invite);
      setContact('');
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const share = async (invite: Invite) => {
    const text = `Join me at ${activity.title}! Code ${invite.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: activity.title, text, url: invite.url });
        return;
      } catch {}
    }
    await navigator.clipboard?.writeText(invite.url).catch(() => {});
    onCopied();
  };

  const full = activity.spotsLeft === 0;

  return (
    <div className="card stack" style={highlight ? { borderColor: 'var(--vouch)' } : undefined}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>{highlight ? 'Who are you bringing?' : 'Bring friends'}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {full
            ? 'This one is full now, but your friends can still see it and grab a spot if one opens up.'
            : `${activity.spotsLeft} ${activity.spotsLeft === 1 ? 'spot is' : 'spots are'} left. Plans are better together.`}
        </p>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={rail === 'vouch'} className={`tab ${rail === 'vouch' ? 'active' : ''}`} onClick={() => setRail('vouch')}>
          <strong className="small">🤝 Vouch for a friend</strong>
          <div className="tiny muted">A personal, one-time invite. You&apos;re saying you stand behind them.</div>
        </button>
        <button role="tab" aria-selected={rail === 'public'} className={`tab public ${rail === 'public' ? 'active' : ''}`} onClick={() => setRail('public')}>
          <strong className="small">🔗 Share a link</strong>
          <div className="tiny muted">One link for a group chat or story. Anyone can use it.</div>
        </button>
      </div>

      <form
        className="row"
        style={{ flexWrap: 'nowrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        {rail === 'vouch' && (
          <input className="input" placeholder="Friend's name, e.g. Ben" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={60} aria-label="Friend's name" />
        )}
        <button className={`btn ${rail === 'vouch' ? 'btn-vouch' : 'btn-primary'}`} disabled={busy || (rail === 'vouch' && !contact.trim())} style={{ flexShrink: 0, marginLeft: rail === 'public' ? 0 : undefined }}>
          {busy ? 'Creating…' : rail === 'vouch' ? 'Create vouch' : 'Get share link'}
        </button>
      </form>
      {error && <div className="banner banner-warn small">{error}</div>}

      {latest && (
        <div className={`banner ${latest.rail === 'vouch' ? 'banner-vouch' : 'banner-brand'}`}>
          <div className="stack" style={{ gap: 8, width: '100%' }}>
            <span className="small">
              {latest.rail === 'vouch' ? `Send this to ${latest.contactLabel}. It works once, just for them.` : 'Post this anywhere. Anyone with it can claim a spot.'}
            </span>
            <div className="row spread">
              <span className="code">{latest.code}</span>
              <button className="btn" onClick={() => share(latest)}>Share</button>
            </div>
            <CopyBox value={latest.url} onCopied={onCopied} />
          </div>
        </div>
      )}

      {invites.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <h3 className="small muted">Your invites</h3>
          <ul className="list">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="stack" style={{ gap: 0 }}>
                  <span className="small">
                    {i.rail === 'vouch' ? `🤝 ${i.contactLabel}` : '🔗 Share link'} · <span className="code" style={{ fontSize: 13 }}>{i.code}</span>
                  </span>
                  <span className="tiny muted">
                    {i.claims && i.claims.length > 0 ? `Claimed by ${i.claims.map((c) => c.name).join(', ')}` : 'Not claimed yet'}
                  </span>
                </span>
                <button className="btn small" onClick={() => share(i)}>Share</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
