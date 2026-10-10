'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, get, getUserId, post, setUserId } from './api';
import type { User } from './types';

interface Session {
  user: User | null;
  ready: boolean;
  signIn: (user: User) => void;
  createProfile: (name: string) => Promise<User>;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

/** Simple identity for the prototype: a named profile remembered in this browser. */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getUserId()) {
      setReady(true);
      return;
    }
    get<{ user: User }>('/me')
      .then((r) => setUser(r.user))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setUserId(null);
      })
      .finally(() => setReady(true));
  }, []);

  const signIn = useCallback((u: User) => {
    setUserId(u.id);
    setUser(u);
  }, []);

  const createProfile = useCallback(
    async (name: string) => {
      const { user: u } = await post<{ user: User }>('/users', { name });
      signIn(u);
      return u;
    },
    [signIn],
  );

  const signOut = useCallback(() => {
    setUserId(null);
    setUser(null);
  }, []);

  return (
    <SessionContext.Provider value={{ user, ready, signIn, createProfile, signOut }}>{children}</SessionContext.Provider>
  );
}

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used inside SessionProvider');
  return s;
}
