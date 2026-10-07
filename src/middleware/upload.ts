import multer from 'multer';
import { env } from '../config/env';
import { AppError, ErrorCode } from '../utils/AppError';

const ACCEPTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

/**
 * Uploads are buffered in memory, checked, then written by the storage service under a
 * generated name. Nothing the client sends is used as a path, and the declared content
 * type is only a first filter — the stored bytes are sniffed before anything is written.
 */
export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.upload.maxBytes, files: 1, fields: 10 },
  fileFilter: (_req, file, callback) => {
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      callback(AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Upload a PNG, JPG or WebP image.'));
      return;
    }
    callback(null, true);
  },
});
