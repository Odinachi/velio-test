'use client';

import { useEffect, useRef, useState } from 'react';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { User } from '@/lib/types';
import { Avatar } from './bits';

/** Profile switcher standing in for real auth: pick an existing person or create one. */
export function ProfileMenu() {
  const { user, ready, signIn, createProfile, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    get<{ users: User[] }>('/users').then((r) => setUsers(r.users)).catch(() => {});
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!ready) return <div className="skeleton" style={{ width: 120, height: 36 }} />;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {user ? (
          <>
            <Avatar name={user.name} /> <span className="small hide-sm">{user.name}</span>
          </>
        ) : (
          'Profile'
        )}
      </button>
      {open && (
        <div className="card stack" style={{ position: 'absolute', right: 0, top: 52, width: 'min(280px, calc(100vw - 32px))', zIndex: 20, padding: 14 }}>
          <form
            className="row"
            style={{ flexWrap: 'nowrap' }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setBusy(true);
              try {
                await createProfile(name.trim());
                setName('');
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input className="input" placeholder="New profile name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              Add
            </button>
          </form>
          <div className="tiny muted">Or switch to someone (no passwords in this prototype):</div>
          <ul className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {users.map((u) => (
              <li key={u.id}>
                <button
                  className="btn btn-ghost"
                  style={{ justifyContent: 'flex-start', width: '100%', padding: '4px 0' }}
                  onClick={() => {
                    signIn(u);
                    setOpen(false);
                  }}
                >
                  <Avatar name={u.name} /> <span className="small">{u.name}</span>
                  {u.id === user?.id && <span className="pill pill-ok">you</span>}
                </button>
              </li>
            ))}
          </ul>
          {user && (
            <button className="btn btn-ghost small" onClick={() => { signOut(); setOpen(false); }}>
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
