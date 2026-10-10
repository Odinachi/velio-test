import type { Metadata, Viewport } from 'next';
import { Header } from '@/components/Header';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Velio · Group plans',
  description: 'Book a spot, bring your friends.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Header />
          <main className="container page">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
