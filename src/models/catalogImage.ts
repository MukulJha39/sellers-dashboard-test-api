import { Schema, type Types } from 'mongoose';
import type { ImageProvider } from '../services/storageService';

/**
 * One photo in a product's or raw material's gallery. The array order is the display
 * order, and the first entry is the cover, mirrored into the record's `imageUrl` so
 * clients that only know about a single image keep working.
 */
export interface CatalogImage {
  _id: Types.ObjectId;
  url: string;
  /** Cloudinary's asset id, used to delete it; null for local or legacy images. */
  publicId: string | null;
  provider: ImageProvider;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: Date;
}

const catalogImageSchema = new Schema<CatalogImage>(
  {
    url: { type: String, required: true, maxlength: 500 },
    publicId: { type: String, default: null, maxlength: 300 },
    provider: { type: String, enum: ['cloudinary', 'local', 'external'], required: true },
    width: { type: Number, default: null, min: 0 },
    height: { type: Number, default: null, min: 0 },
    bytes: { type: Number, default: null, min: 0 },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: true },
);

export const imagesField = { type: [catalogImageSchema], default: [] };
