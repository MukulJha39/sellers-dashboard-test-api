import type { Request } from 'express';
import type { Types } from 'mongoose';
import { Merchant, type Gender, type ThemeMode } from '../../models/Merchant';
import { diffFields, writeAudit } from '../../services/auditService';
import { deleteStoredFile, storeImage } from '../../services/storageService';
import { AppError } from '../../utils/AppError';
import { presentMerchant, type MerchantView } from './merchantPresenter';

export interface ProfileUpdateInput {
  firstName?: string;
  lastName?: string;
  gender?: Gender;
  locale?: string;
  themeMode?: ThemeMode;
}

const EDITABLE_FIELDS = ['firstName', 'lastName', 'gender', 'locale', 'themeMode'] as const;

async function loadMerchant(merchantId: Types.ObjectId) {
  const merchant = await Merchant.findById(merchantId);
  if (!merchant) throw AppError.notFound('This account is no longer available.');
  return merchant;
}

export async function getProfile(merchantId: Types.ObjectId): Promise<MerchantView> {
  return presentMerchant(await loadMerchant(merchantId));
}

/**
 * Updates the editable parts of a merchant profile.
 *
 * Country code and phone number are absent from EDITABLE_FIELDS by design: the verified
 * phone is immutable (PRD section 4), and the route rejects any attempt to send it.
 */
export async function updateProfile(
  merchantId: Types.ObjectId,
  input: ProfileUpdateInput,
  req?: Request,
): Promise<MerchantView> {
  const merchant = await loadMerchant(merchantId);

  const before = {
    firstName: merchant.firstName,
    lastName: merchant.lastName,
    gender: merchant.gender as string,
    locale: merchant.locale,
    themeMode: merchant.themeMode as string,
  };

  if (input.firstName !== undefined) merchant.firstName = input.firstName;
  if (input.lastName !== undefined) merchant.lastName = input.lastName;
  if (input.gender !== undefined) merchant.gender = input.gender;
  if (input.locale !== undefined) merchant.locale = input.locale;
  if (input.themeMode !== undefined) merchant.themeMode = input.themeMode;

  await merchant.save();

  const changes = diffFields(before, input as Record<string, unknown>, EDITABLE_FIELDS);
  if (changes.length > 0) {
    await writeAudit({
      actorType: 'merchant',
      actorId: merchant._id,
      actorLabel: `${merchant.firstName} ${merchant.lastName}`,
      action: 'merchant.profile_updated',
      targetType: 'merchant',
      targetId: merchant._id,
      summary: `Merchant updated their profile (${changes.map((change) => change.field).join(', ')}).`,
      changes,
      req,
    });
  }

  return presentMerchant(merchant);
}

export async function replaceProfilePhoto(
  merchantId: Types.ObjectId,
  buffer: Buffer,
  req?: Request,
): Promise<MerchantView> {
  const merchant = await loadMerchant(merchantId);
  const previousUrl = merchant.photoUrl;

  const stored = await storeImage(buffer, 'merchants');
  merchant.photoUrl = stored.url;
  await merchant.save();

  // Remove the superseded file only after the new one is safely referenced.
  await deleteStoredFile(previousUrl);

  await writeAudit({
    actorType: 'merchant',
    actorId: merchant._id,
    actorLabel: `${merchant.firstName} ${merchant.lastName}`,
    action: 'merchant.photo_updated',
    targetType: 'merchant',
    targetId: merchant._id,
    summary: 'Merchant updated their profile photo.',
    req,
  });

  return presentMerchant(merchant);
}

export async function removeProfilePhoto(merchantId: Types.ObjectId, req?: Request): Promise<MerchantView> {
  const merchant = await loadMerchant(merchantId);
  const previousUrl = merchant.photoUrl;

  merchant.photoUrl = null;
  await merchant.save();
  await deleteStoredFile(previousUrl);

  if (previousUrl) {
    await writeAudit({
      actorType: 'merchant',
      actorId: merchant._id,
      actorLabel: `${merchant.firstName} ${merchant.lastName}`,
      action: 'merchant.photo_removed',
      targetType: 'merchant',
      targetId: merchant._id,
      summary: 'Merchant removed their profile photo.',
      req,
    });
  }

  return presentMerchant(merchant);
}
