import type { Response } from 'express';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

/**
 * Every successful response uses the same envelope so both frontends can
 * unwrap results with one shared helper.
 */
export function sendData<T>(res: Response, data: T, statusCode = 200): Response {
  return res.status(statusCode).json({ success: true, data });
}

export function sendList<T>(res: Response, items: T[], meta: PageMeta, statusCode = 200): Response {
  return res.status(statusCode).json({ success: true, data: { items, meta } });
}

export function buildPageMeta(page: number, limit: number, total: number): PageMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
  };
}
