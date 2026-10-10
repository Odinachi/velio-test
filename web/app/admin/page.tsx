'use client';

import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/bits';
import { API_URL, get } from '@/lib/api';

interface Goal {
  name: string;
  type: 'technical' | 'product';
  value: number | null;
  target: number;
  unit: string;
  status: 'met' | 'missed' | 'no_data';
}

interface Report {
  generatedAt: string;
  goals: Goal[];
  views: Record<string, Record<string, unknown>[]>;
}

const SECTIONS: { key: string; title: string; note: string }[] = [
  { key: 'funnel', title: 'Invite funnel', note: 'Viewed → booked → invited → opened → claimed (unique people / opens).' },
  { key: 'bookersWhoInvite', title: 'Bookers who invite', note: 'Per booking: did the person invite to the activity they booked? Holdout activities excluded.' },
  { key: 'inviteConversion', title: 'Invite conversion by rail', note: 'Unique (invite, device) opens that ended in a claimed spot. Inviters previewing their own link are excluded.' },
  { key: 'kFactorByRail', title: 'K-factor by rail', note: 'New users brought in ÷ existing users who could invite.' },
  { key: 'holdout', title: 'Holdout comparison', note: '10% of activities never offer invites. Differences between arms are caused by invites.' },
  { key: 'plansHappened', title: 'Plans that happened', note: 'Proxy until check-in exists: started with at least 2 people going.' },
  { key: 'bookingSuccess', title: 'Booking outcomes', note: 'Sold out and already-booked are correct answers, so they are not failures.' },
  { key: 'availabilityLatency', title: 'Live update latency', note: 'Commit → client receive, as reported by clients (clock-offset corrected).' },
];

export default function AdminPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Report>('/admin/report').then(setReport).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !report) return <div className="banner banner-warn">{error}</div>;
  if (!report) return <Skeleton h={400} />;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <h1>Tracking</h1>
          <span className="small muted">Every goal from the scope, straight from the SQL views. Refreshes every 10s.</span>
        </div>
        <a className="btn small" href={`${API_URL}/metrics`} target="_blank" rel="noreferrer">Raw /metrics</a>
      </div>

      <div className="grid">
        {report.goals.map((g) => (
          <div key={g.name} className="card stack" style={{ gap: 6 }}>
            <div className="row spread">
              <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{g.type}</span>
              <span className={`pill tiny ${g.status === 'met' ? 'pill-ok' : g.status === 'missed' ? 'pill-warn' : ''}`}>
                {g.status === 'met' ? 'on target' : g.status === 'missed' ? 'off target' : 'no data yet'}
              </span>
            </div>
            <strong>{g.name}</strong>
            <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 28, fontWeight: 800 }}>{g.value ?? '–'}</span>
              <span className="muted small">{g.unit}</span>
            </div>
            <span className="tiny muted">Target: {g.type === 'technical' && g.unit === 'ms' ? '≤' : g.unit === 'activities' ? '=' : '≥'} {g.target} {g.unit}</span>
          </div>
        ))}
      </div>

      {SECTIONS.map((s) => (
        <section key={s.key} className="card stack">
          <div className="stack" style={{ gap: 2 }}>
            <h2>{s.title}</h2>
            <span className="small muted">{s.note}</span>
          </div>
          <DataTable rows={report.views[s.key] ?? []} />
        </section>
      ))}
    </div>
  );
}

function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <p className="muted small" style={{ margin: 0 }}>No data yet.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}>{r[c] === null ? '–' : String(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
