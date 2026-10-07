import type { Request, Response } from 'express';
import type { Gender, ThemeMode } from '../../models/Merchant';
import { AppError, ErrorCode } from '../../utils/AppError';
import { sendData } from '../../utils/response';
import {
  getProfile,
  removeProfilePhoto,
  replaceProfilePhoto,
  updateProfile,
  type ProfileUpdateInput,
} from './merchantService';

function requireMerchantContext(req: Request) {
  if (!req.merchant) throw AppError.unauthenticated('Sign in to continue.');
  return req.merchant;
}

export async function getMe(req: Request, res: Response): Promise<void> {
  const merchant = requireMerchantContext(req);
  sendData(res, { merchant: await getProfile(merchant.objectId) });
}

export async function patchMe(req: Request, res: Response): Promise<void> {
  const merchant = requireMerchantContext(req);

  const input: ProfileUpdateInput = {};
  if (req.body.firstName !== undefined) input.firstName = String(req.body.firstName).trim();
  if (req.body.lastName !== undefined) input.lastName = String(req.body.lastName).trim();
  if (req.body.gender !== undefined) input.gender = String(req.body.gender) as Gender;
  if (req.body.locale !== undefined) input.locale = String(req.body.locale).trim();
  if (req.body.themeMode !== undefined) input.themeMode = String(req.body.themeMode) as ThemeMode;

  sendData(res, { merchant: await updateProfile(merchant.objectId, input, req) });
}

export async function putMyPhoto(req: Request, res: Response): Promise<void> {
  const merchant = requireMerchantContext(req);
  if (!req.file?.buffer) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose an image to upload.');
  }
  sendData(res, { merchant: await replaceProfilePhoto(merchant.objectId, req.file.buffer, req) });
}

export async function deleteMyPhoto(req: Request, res: Response): Promise<void> {
  const merchant = requireMerchantContext(req);
  sendData(res, { merchant: await removeProfilePhoto(merchant.objectId, req) });
}
