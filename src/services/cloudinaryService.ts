import crypto from 'crypto';
import { env } from '../config/env';
import { AppError, ErrorCode } from '../utils/AppError';
import { logger } from '../utils/logger';

/**
 * A small client for Cloudinary's signed REST API.
 *
 * Only two calls are needed — upload and destroy — so this talks to the API directly
 * with `fetch` instead of pulling in the SDK. Every request is signed on the server;
 * the API secret never leaves this process and clients never upload to Cloudinary
 * themselves, so the same byte-sniffing checks apply to every image.
 */

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  timeoutMs: number;
}

export interface CloudinaryUpload {
  url: string;
  publicId: string;
  width: number | null;
  height: number | null;
  bytes: number;
  format: string | null;
}

type Params = Record<string, string | number>;

/**
 * Cloudinary's request signature: the parameters sorted by name, joined as
 * `key=value&key=value`, with the API secret appended, then SHA-1 hashed.
 * `file`, `api_key`, `resource_type` and `cloud_name` are never part of it.
 */
export function signParams(params: Params, apiSecret: string): string {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + apiSecret).digest('hex');
}

function endpoint(config: CloudinaryConfig, action: 'upload' | 'destroy'): string {
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/${action}`;
}

function signedForm(params: Params, config: CloudinaryConfig): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.append(key, String(value));
  form.append('api_key', config.apiKey);
  form.append('signature', signParams(params, config.apiSecret));
  return form;
}

function unavailable(): AppError {
  return new AppError(
    502,
    ErrorCode.IMAGE_STORAGE_UNAVAILABLE,
    'The image could not be saved right now. Please try again in a moment.',
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Uploads one image into `folder` and returns where it now lives. */
export async function uploadToCloudinary(
  buffer: Buffer,
  options: { folder: string; mimeType: string },
  config: CloudinaryConfig = env.cloudinary,
): Promise<CloudinaryUpload> {
  const params: Params = { folder: options.folder, timestamp: nowSeconds() };
  const form = signedForm(params, config);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: options.mimeType }), 'upload');

  let response: Response;
  try {
    response = await fetch(endpoint(config, 'upload'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    logger.error('Cloudinary upload failed to send', { reason: error instanceof Error ? error.message : 'unknown' });
    throw unavailable();
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.secure_url !== 'string' || typeof body.public_id !== 'string') {
    const reason = (body?.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    logger.error('Cloudinary rejected an upload', { status: response.status, reason });
    throw unavailable();
  }

  return {
    url: body.secure_url,
    publicId: body.public_id,
    width: typeof body.width === 'number' ? body.width : null,
    height: typeof body.height === 'number' ? body.height : null,
    bytes: typeof body.bytes === 'number' ? body.bytes : buffer.length,
    format: typeof body.format === 'string' ? body.format : null,
  };
}

/**
 * Deletes an image and purges it from the CDN. Best effort: a failed cleanup is logged
 * and never fails the request that triggered it, because the record change has
 * already happened by then.
 */
export async function destroyOnCloudinary(
  publicId: string,
  config: CloudinaryConfig = env.cloudinary,
): Promise<void> {
  const params: Params = { invalidate: 'true', public_id: publicId, timestamp: nowSeconds() };
  try {
    const response = await fetch(endpoint(config, 'destroy'), {
      method: 'POST',
      body: signedForm(params, config),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as { result?: string } | null;
    if (!response.ok || (body?.result !== 'ok' && body?.result !== 'not found')) {
      logger.warn('Cloudinary could not remove an image', { publicId, status: response.status, result: body?.result });
    }
  } catch (error) {
    logger.warn('Cloudinary delete failed to send', { publicId, reason: error instanceof Error ? error.message : 'unknown' });
  }
}

/**
 * A square, compressed, format-negotiated variant for lists and grids. Cloudinary
 * builds it on first request from the stored original; non-Cloudinary URLs are
 * returned unchanged.
 */
export function cloudinaryThumbnail(url: string, size = 240): string {
  const marker = '/image/upload/';
  const index = url.indexOf(marker);
  if (index === -1 || !url.includes('res.cloudinary.com')) return url;
  const at = index + marker.length;
  return `${url.slice(0, at)}c_fill,w_${size},h_${size},q_auto,f_auto/${url.slice(at)}`;
}
