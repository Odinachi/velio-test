import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db/pool.js';
import { ApiError } from './lib/errors.js';
import { isUuid } from './lib/ids.js';
import type { Metrics } from './metrics.js';
import type { AvailabilityBus } from './realtime.js';

export interface Ctx {
  db: Db;
  bus: AvailabilityBus;
  metrics: Metrics;
}

export interface UserRow {
  id: string;
  name: string;
  generation: number;
  created_at: Date;
}

export const userDto = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  generation: u.generation,
  createdAt: u.created_at.toISOString(),
});

/** Simple identity for the prototype: the client sends the user id it was given at signup. */
export async function currentUser(ctx: Ctx, req: FastifyRequest): Promise<UserRow | null> {
  const id = req.headers['x-user-id'];
  if (!isUuid(id)) return null;
  const { rows } = await ctx.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function requireUser(ctx: Ctx, req: FastifyRequest): Promise<UserRow> {
  const user = await currentUser(ctx, req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Pick a profile first.');
  return user;
}

export function deviceId(req: FastifyRequest): string | null {
  const d = req.headers['x-device-id'];
  return typeof d === 'string' && d.length > 0 && d.length <= 100 ? d : null;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new ApiError(400, 'VALIDATION', field ? `${field}: ${issue.message}` : issue.message, {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.uuid() });
