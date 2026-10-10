// Shapes returned by the backend API.

export interface User {
  id: string;
  name: string;
  generation: number;
  createdAt: string;
}

export interface Activity {
  id: string;
  planId: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  priceCents: number;
  currency: string;
  capacity: number;
  spotsTaken: number;
  spotsLeft: number;
  version: number;
  host: { id: string; name: string };
  invitesEnabled: boolean;
  hasStarted: boolean;
}

export interface Booking {
  id: string;
  activityId: string;
  planId: string;
  userId: string;
  status: 'confirmed' | 'cancelled';
  inviteId: string | null;
  createdAt: string;
}

export type Rail = 'vouch' | 'public';

export interface Invite {
  id: string;
  code: string;
  activityId: string;
  rail: Rail;
  contactLabel: string | null;
  uses: number;
  maxUses: number | null;
  expiresAt: string;
  url: string;
  deepLink: string;
  claims?: { name: string; claimedAt: string }[];
}

export interface Attendee {
  userId: string;
  name: string;
  bookedAt: string;
  via: 'direct' | Rail;
  invitedBy: string | null;
  generation: number;
}

export interface AvailabilityUpdate {
  activityId: string;
  spotsTaken: number;
  capacity: number;
  spotsLeft: number;
  version: number;
  committedAt: number;
}

export type InviteStatus = 'valid' | 'expired' | 'used' | 'full';

export interface ResolvedInvite {
  invite: {
    code: string;
    rail: Rail;
    status: InviteStatus;
    contactLabel: string | null;
    inviter: { id: string; name: string };
    expiresAt: string;
  };
  activity: Activity;
  myBooking: Booking | null;
  isInviter: boolean;
}
