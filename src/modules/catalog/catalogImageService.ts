import { Types, type FilterQuery, type Model } from 'mongoose';
import { CATALOG_MAX_IMAGES } from '../../config/catalog';
import type { CatalogImage } from '../../models/catalogImage';
import {
  assertImage,
  removeStoredImage,
  storeCatalogImage,
  type ImageProvider,
  type StoredImage,
} from '../../services/storageService';
import { AppError, ErrorCode } from '../../utils/AppError';

/**
 * Photo galleries for products and raw materials.
 *
 * The gallery is the `images` array; its first entry is the cover and is mirrored into
 * `imageUrl` after every change, so older clients that read a single image keep
 * working. Each change is one conditional update, which keeps the image limit and the
 * order correct when two requests arrive together.
 *
 * Files are stored before the record is updated and removed only after it has been,
 * so a failed database write never leaves a record pointing at a missing file. A
 * stored file the record never accepted is cleaned up straight away.
 */

/**
 * The id presented for a cover set before galleries existed (only `imageUrl`, no
 * `images`). It is adopted into the gallery as a real entry on the first change.
 */
export const LEGACY_IMAGE_ID = 'cover';

export interface GalleryRecord {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  imageUrl?: string | null;
  images?: CatalogImage[];
}

export interface GalleryTarget<T extends GalleryRecord> {
  model: Model<T>;
  /** Already loaded and checked to belong to the merchant. */
  record: T;
  /** Storage sub-folder, such as "items". */
  folder: string;
  /** How messages name the record, such as "product". */
  noun: string;
}

function legacyProvider(url: string): ImageProvider {
  return url.includes('/uploads/') ? 'local' : 'external';
}

function entryFor(stored: StoredImage): CatalogImage {
  return { _id: new Types.ObjectId(), ...stored, createdAt: new Date() };
}

function legacyEntry(url: string, since: Date): CatalogImage {
  return {
    _id: new Types.ObjectId(),
    url,
    publicId: null,
    provider: legacyProvider(url),
    width: null,
    height: null,
    bytes: null,
    createdAt: since,
  };
}

/** The images a record has, including a cover that predates the gallery. */
export function galleryOf(record: GalleryRecord): CatalogImage[] {
  return record.images ?? [];
}

function scope<T extends GalleryRecord>(target: GalleryTarget<T>, extra: Record<string, unknown> = {}): FilterQuery<T> {
  return { _id: target.record._id, merchantId: target.record.merchantId, ...extra } as FilterQuery<T>;
}

/** Matches when the gallery holds at most `count` images (a missing array counts as empty). */
function sizeAtMost(count: number): Record<string, unknown> {
  return { $expr: { $lte: [{ $size: { $ifNull: ['$images', []] } }, count] } };
}

async function reload<T extends GalleryRecord>(target: GalleryTarget<T>): Promise<T> {
  const fresh = await target.model.findOne(scope(target));
  if (!fresh) throw AppError.notFound(`That ${target.noun} was not found.`);
  return fresh as T;
}

/** Copies the first image's URL into `imageUrl`, or clears it when the gallery is empty. */
async function syncCover<T extends GalleryRecord>(target: GalleryTarget<T>): Promise<T> {
  await target.model.updateOne(scope(target), [
    { $set: { imageUrl: { $ifNull: [{ $arrayElemAt: ['$images.url', 0] }, null] } } },
  ]);
  return reload(target);
}

/**
 * Turns a pre-gallery cover into the gallery's first entry, so every later operation
 * only has to deal with the array. Returns the record as it now stands.
 */
async function adoptLegacyCover<T extends GalleryRecord>(target: GalleryTarget<T>): Promise<T> {
  const { record } = target;
  if (galleryOf(record).length > 0 || !record.imageUrl) return record;

  const since = (record as { updatedAt?: Date }).updatedAt ?? new Date();
  await target.model.updateOne(scope(target, { imageUrl: record.imageUrl, ...sizeAtMost(0) }), {
    $set: { images: [legacyEntry(record.imageUrl, since)] },
  });
  return reload(target);
}

async function storeAll(buffers: Buffer[], folder: string): Promise<CatalogImage[]> {
  const results = await Promise.allSettled(buffers.map((buffer) => storeCatalogImage(buffer, folder)));
  const stored = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');

  if (failure) {
    // All or nothing: a partly stored batch is removed rather than half-added.
    await Promise.all(stored.map((image) => removeStoredImage(image)));
    throw failure.reason;
  }
  return stored.map(entryFor);
}

function limitReached(noun: string, remaining: number): AppError {
  const tail =
    remaining > 0
      ? ` You can add ${remaining} more.`
      : ' Remove one before adding another.';
  return AppError.conflict(`A ${noun} can have up to ${CATALOG_MAX_IMAGES} images.${tail}`, {
    code: ErrorCode.IMAGE_LIMIT_REACHED,
    meta: { maxImages: CATALOG_MAX_IMAGES, remaining },
  });
}

/** Adds photos to the end of the gallery. The first photo ever added becomes the cover. */
export async function addCatalogImages<T extends GalleryRecord>(
  target: GalleryTarget<T>,
  buffers: Buffer[],
): Promise<T> {
  if (buffers.length === 0) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose at least one image to upload.');
  }
  // The whole batch is checked before anything is stored.
  buffers.forEach((buffer) => assertImage(buffer));

  const record = await adoptLegacyCover(target);
  const current = { ...target, record };
  const remaining = CATALOG_MAX_IMAGES - galleryOf(record).length;
  if (buffers.length > remaining) throw limitReached(target.noun, remaining);

  const entries = await storeAll(buffers, target.folder);

  const updated = await target.model.findOneAndUpdate(
    scope(current, sizeAtMost(CATALOG_MAX_IMAGES - entries.length)),
    { $push: { images: { $each: entries } } },
    { new: true },
  );
  if (!updated) {
    // Another upload filled the gallery first, or the record went away.
    await Promise.all(entries.map((entry) => removeStoredImage(entry)));
    const latest = await reload(current);
    throw limitReached(target.noun, Math.max(0, CATALOG_MAX_IMAGES - galleryOf(latest).length));
  }

  return syncCover(current);
}

/** Removes one photo. Removing the cover promotes the next photo in line. */
export async function removeCatalogImage<T extends GalleryRecord>(
  target: GalleryTarget<T>,
  imageId: string,
): Promise<T> {
  const { record } = target;
  const notFound = AppError.notFound('That image was not found.');

  if (imageId === LEGACY_IMAGE_ID && galleryOf(record).length === 0) {
    if (!record.imageUrl) throw notFound;
    const url = record.imageUrl;
    const result = await target.model.updateOne(scope(target, { imageUrl: url }), { $set: { imageUrl: null } });
    if (result.modifiedCount > 0) await removeStoredImage({ url, provider: legacyProvider(url) });
    return reload(target);
  }

  const entry = galleryOf(record).find((image) => String(image._id) === imageId);
  if (!entry) throw notFound;

  const updated = await target.model.findOneAndUpdate(
    scope(target, { 'images._id': entry._id }),
    { $pull: { images: { _id: entry._id } } },
    { new: true },
  );
  if (!updated) throw notFound;

  const synced = await syncCover(target);
  await removeStoredImage(entry);
  return synced;
}

/** Puts the gallery in the given order. Every current image must be listed exactly once. */
export async function reorderCatalogImages<T extends GalleryRecord>(
  target: GalleryTarget<T>,
  imageIds: string[],
): Promise<T> {
  const images = galleryOf(target.record);
  const byId = new Map(images.map((image) => [String(image._id), image]));
  const unique = new Set(imageIds);

  if (unique.size !== imageIds.length || imageIds.length !== images.length || !imageIds.every((id) => byId.has(id))) {
    throw AppError.validation('List every image of this record exactly once.', [
      { field: 'imageIds', message: `Send all ${images.length} image ids in the order you want them.` },
    ]);
  }

  const ordered = imageIds.map((id) => byId.get(id) as CatalogImage);
  const updated = await target.model.findOneAndUpdate(
    scope(target, {
      images: { $size: images.length },
      'images._id': { $all: ordered.map((image) => image._id) },
    }),
    { $set: { images: ordered } },
    { new: true },
  );
  if (!updated) {
    throw AppError.conflict('The images changed while you were reordering them. Refresh and try again.');
  }

  return syncCover(target);
}

/**
 * Replaces the cover photo, or adds one when there is none. This backs the original
 * single-image endpoint, so a client that only knows about one image behaves as before.
 */
export async function replaceCatalogCover<T extends GalleryRecord>(
  target: GalleryTarget<T>,
  buffer: Buffer,
): Promise<T> {
  assertImage(buffer);
  const record = await adoptLegacyCover(target);
  const current = { ...target, record };
  const cover = galleryOf(record)[0];

  if (!cover) return addCatalogImages(current, [buffer]);

  const [entry] = await storeAll([buffer], target.folder);
  if (!entry) throw AppError.internal();

  const updated = await target.model.findOneAndUpdate(
    scope(current, { 'images._id': cover._id }),
    { $set: { 'images.$': entry } },
    { new: true },
  );
  if (!updated) {
    await removeStoredImage(entry);
    throw AppError.conflict('The images changed while you were uploading. Refresh and try again.');
  }

  const synced = await syncCover(current);
  await removeStoredImage(cover);
  return synced;
}

/** Removes the cover photo, if there is one. */
export async function removeCatalogCover<T extends GalleryRecord>(target: GalleryTarget<T>): Promise<T> {
  const cover = galleryOf(target.record)[0];
  if (cover) return removeCatalogImage(target, String(cover._id));
  if (target.record.imageUrl) return removeCatalogImage(target, LEGACY_IMAGE_ID);
  return target.record;
}

/** Removes every stored photo of a record that has been deleted. Best effort. */
export async function removeAllCatalogImages(record: { imageUrl?: string | null; images?: CatalogImage[] }): Promise<void> {
  const images = record.images ?? [];
  const removals = images.map((image) => removeStoredImage(image));
  if (record.imageUrl && !images.some((image) => image.url === record.imageUrl)) {
    removals.push(removeStoredImage({ url: record.imageUrl, provider: legacyProvider(record.imageUrl) }));
  }
  await Promise.all(removals);
}
