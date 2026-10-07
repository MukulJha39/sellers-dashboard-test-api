import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { AppError, ErrorCode } from '../utils/AppError';
import { logger } from '../utils/logger';

export interface StoredFile {
  fileName: string;
  relativePath: string;
  url: string;
  bytes: number;
  mimeType: string;
}

type ImageKind = { mimeType: string; extension: string };

/**
 * Uploads are identified by their actual bytes, not by the client-supplied name or
 * content type, so a renamed executable cannot be stored as an image (PRD section 28).
 */
function sniffImage(buffer: Buffer): ImageKind | null {
  if (buffer.length < 12) return null;

  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  if (isPng) return { mimeType: 'image/png', extension: '.png' };

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }

  const isWebp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (isWebp) return { mimeType: 'image/webp', extension: '.webp' };

  return null;
}

export async function ensureUploadDir(subDirectory = ''): Promise<string> {
  const target = path.join(env.upload.dir, subDirectory);
  await fs.mkdir(target, { recursive: true });
  return target;
}

export function publicUrlFor(relativePath: string): string {
  const normalised = relativePath.split(path.sep).join('/');
  return `${env.publicBaseUrl.replace(/\/$/, '')}/uploads/${normalised}`;
}

/**
 * Stores an image under a generated name. The original filename is never used, which
 * removes path traversal and extension spoofing from the equation entirely.
 */
export async function storeImage(buffer: Buffer, subDirectory: string): Promise<StoredFile> {
  if (buffer.length === 0) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'The uploaded file is empty.');
  }
  if (buffer.length > env.upload.maxBytes) {
    throw AppError.badRequest(
      ErrorCode.UPLOAD_REJECTED,
      `Images must be smaller than ${Math.floor(env.upload.maxBytes / (1024 * 1024))} MB.`,
    );
  }

  const kind = sniffImage(buffer);
  if (!kind) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Upload a PNG, JPG or WebP image.');
  }

  const directory = await ensureUploadDir(subDirectory);
  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${kind.extension}`;
  const absolutePath = path.join(directory, fileName);

  await fs.writeFile(absolutePath, buffer, { mode: 0o644 });

  const relativePath = path.join(subDirectory, fileName);
  return {
    fileName,
    relativePath,
    url: publicUrlFor(relativePath),
    bytes: buffer.length,
    mimeType: kind.mimeType,
  };
}

/** Best-effort cleanup of a previously stored upload; never fails the request. */
export async function deleteStoredFile(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const marker = '/uploads/';
  const index = url.indexOf(marker);
  if (index === -1) return;

  const relativePath = url.slice(index + marker.length);
  // Refuse anything that tries to escape the upload directory.
  if (relativePath.includes('..')) return;

  try {
    await fs.unlink(path.join(env.upload.dir, relativePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('Could not remove stored file', { reason: code ?? 'unknown' });
    }
  }
}
