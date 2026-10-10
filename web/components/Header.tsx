'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ProfileMenu } from './ProfileMenu';

const links = [
  { href: '/', label: 'Book', match: (p: string) => p === '/' || p.startsWith('/activities') || p.startsWith('/i/') },
  { href: '/host', label: 'Host', match: (p: string) => p.startsWith('/host') },
  { href: '/admin', label: 'Tracking', match: (p: string) => p.startsWith('/admin') },
];

export function Header() {
  const pathname = usePathname();
  return (
    <header className="header">
      <div className="container header-inner">
        <Link href="/" className="logo">
          velio<span>.</span>
        </Link>
        <nav className="nav" aria-label="Role">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={l.match(pathname) ? 'active' : ''}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <ProfileMenu />
      </div>
    </header>
  );
}
