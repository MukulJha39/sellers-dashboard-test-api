import type { Request, Response } from 'express';
import type { Gender } from '../../models/Merchant';
import { refreshSession, revokeSession } from '../../services/sessionService';
import { storeImage } from '../../services/storageService';
import { sendData } from '../../utils/response';
import { registerMerchant, requestOtp, verifyOtp } from './authService';

export async function postOtpRequest(req: Request, res: Response): Promise<void> {
  const result = await requestOtp({
    countryCode: String(req.body.countryCode),
    phone: String(req.body.phone),
    req,
  });
  sendData(res, result, 201);
}

export async function postOtpVerify(req: Request, res: Response): Promise<void> {
  const result = await verifyOtp({
    otpId: String(req.body.otpId),
    code: String(req.body.code),
    req,
  });
  sendData(res, result);
}

/**
 * Registration accepts JSON or multipart. When a photo is attached it is stored first,
 * so the merchant record is created with its final photo URL in one step.
 */
export async function postRegister(req: Request, res: Response): Promise<void> {
  let photoUrl: string | null = null;
  if (req.file?.buffer) {
    const stored = await storeImage(req.file.buffer, 'merchants');
    photoUrl = stored.url;
  }

  const result = await registerMerchant({
    registrationToken: String(req.body.registrationToken),
    firstName: String(req.body.firstName).trim(),
    lastName: String(req.body.lastName).trim(),
    gender: String(req.body.gender) as Gender,
    photoUrl,
    ...(req.body.locale ? { locale: String(req.body.locale).trim() } : {}),
    req,
  });

  sendData(res, result, 201);
}

export async function postRefresh(req: Request, res: Response): Promise<void> {
  const result = await refreshSession(String(req.body.refreshToken), 'merchant');
  sendData(res, { tokens: result.tokens });
}

export async function postLogout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) await revokeSession(req.sessionId, 'logout');
  sendData(res, { loggedOut: true });
}
