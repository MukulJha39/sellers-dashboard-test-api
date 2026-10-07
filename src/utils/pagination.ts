import type { Request } from 'express';

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePagination(req: Request): Pagination {
  const rawPage = Number.parseInt(String(req.query.page ?? '1'), 10);
  const rawLimit = Number.parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Sorting is restricted to an allowlist so a query string can never reach into
 * arbitrary document fields.
 */
export function parseSort(
  req: Request,
  allowedFields: readonly string[],
  fallback: Record<string, 1 | -1>,
): Record<string, 1 | -1> {
  const raw = typeof req.query.sort === 'string' ? req.query.sort.trim() : '';
  if (!raw) return fallback;

  const descending = raw.startsWith('-');
  const field = descending ? raw.slice(1) : raw;
  if (!allowedFields.includes(field)) return fallback;

  return { [field]: descending ? -1 : 1 };
}

/** Escapes a search term so it is treated as literal text inside a regex query. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
