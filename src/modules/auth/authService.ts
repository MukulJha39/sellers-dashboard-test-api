import type { Request } from 'express';
import { env } from '../../config/env';
import { Merchant, type Gender } from '../../models/Merchant';
import { OtpVerification } from '../../models/OtpVerification';
import { writeAudit } from '../../services/auditService';
import { createSession } from '../../services/sessionService';
import { getSmsProvider } from '../../services/smsProvider';
import { AppError, ErrorCode } from '../../utils/AppError';
import { signRegistrationToken, verifyRegistrationToken, type IssuedTokens } from '../../utils/jwt';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '../../utils/otp';
import { maskPhone, normalizePhone } from '../../utils/phone';
import { presentMerchant, type MerchantView } from '../merchant/merchantPresenter';

export interface OtpRequestResult {
  otpId: string;
  maskedPhone: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  maxAttempts: number;
  /** Development only, so the flow is testable without an SMS provider. */
  devCode?: string;
}

export type OtpVerifyResult =
  | { status: 'authenticated'; merchant: MerchantView; tokens: IssuedTokens }
  | {
      status: 'registration_required';
      registrationToken: string;
      registrationTokenExpiresIn: number;
      countryCode: string;
      phone: string;
    };

export interface RegisterInput {
  registrationToken: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  photoUrl?: string | null;
  locale?: string;
}

/**
 * Step 1 of onboarding (PRD section 4): a merchant enters their country code and phone
 * number, and we send a one-time code.
 *
 * Abuse protection lives here so it is enforced per phone number rather than per IP:
 * an hourly request quota, a resend cooldown, and superseding of any earlier code.
 */
export async function requestOtp(input: {
  countryCode: string;
  phone: string;
  req?: Request;
}): Promise<OtpRequestResult> {
  const { countryCode, phone, e164 } = normalizePhone(input.countryCode, input.phone);
  const now = new Date();

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentRequests = await OtpVerification.countDocuments({
    phoneE164: e164,
    createdAt: { $gte: oneHourAgo },
  });
  if (recentRequests >= env.otp.maxPerPhonePerHour) {
    throw AppError.rateLimited('Too many codes requested for this number. Please try again later.', {
      retryAfterSeconds: 60 * 60,
    });
  }

  const latest = await OtpVerification.findOne({ phoneE164: e164, consumedAt: null }).sort({ createdAt: -1 });
  if (latest) {
    const elapsedSeconds = Math.floor((now.getTime() - latest.lastSentAt.getTime()) / 1000);
    const waitSeconds = env.otp.resendCooldownSeconds - elapsedSeconds;
    if (waitSeconds > 0) {
      throw new AppError(429, ErrorCode.OTP_RESEND_TOO_SOON, 'Please wait before requesting another code.', {
        meta: { retryAfterSeconds: waitSeconds },
      });
    }
  }

  // Only the newest code may be used.
  await OtpVerification.updateMany(
    { phoneE164: e164, consumedAt: null },
    { $set: { consumedAt: now } },
  );

  const code = generateOtpCode();
  const verification = await OtpVerification.create({
    countryCode,
    phone,
    phoneE164: e164,
    purpose: 'phone_verification',
    codeHash: hashOtpCode(code),
    attempts: 0,
    maxAttempts: env.otp.maxAttempts,
    expiresAt: new Date(now.getTime() + env.otp.ttlSeconds * 1000),
    lastSentAt: now,
    resendCount: latest ? latest.resendCount + 1 : 0,
    requestIp: input.req?.ip ?? null,
  });

  await getSmsProvider().sendOtp({ countryCode, phone, code, ttlSeconds: env.otp.ttlSeconds });

  return {
    otpId: String(verification._id),
    maskedPhone: maskPhone(countryCode, phone),
    expiresInSeconds: env.otp.ttlSeconds,
    resendAfterSeconds: env.otp.resendCooldownSeconds,
    maxAttempts: env.otp.maxAttempts,
    ...(env.otp.exposeInResponse ? { devCode: code } : {}),
  };
}

/**
 * Step 2 and 3 of onboarding: verify the code, then branch.
 * A known phone number signs straight in; a new one continues to registration.
 */
export async function verifyOtp(input: { otpId: string; code: string; req?: Request }): Promise<OtpVerifyResult> {
  const now = new Date();
  const existing = await OtpVerification.findById(input.otpId);

  if (!existing) {
    throw AppError.badRequest(ErrorCode.OTP_INVALID, 'That code is not valid. Request a new code.');
  }
  if (existing.consumedAt) {
    throw AppError.badRequest(ErrorCode.OTP_ALREADY_USED, 'That code has already been used. Request a new code.');
  }
  if (existing.expiresAt.getTime() <= now.getTime()) {
    throw AppError.badRequest(ErrorCode.OTP_EXPIRED, 'That code has expired. Request a new code.');
  }
  if (existing.attempts >= existing.maxAttempts) {
    throw AppError.badRequest(
      ErrorCode.OTP_ATTEMPTS_EXCEEDED,
      'Too many incorrect attempts. Request a new code.',
    );
  }

  // Count the attempt atomically so concurrent submissions cannot exceed the ceiling.
  const verification = await OtpVerification.findOneAndUpdate(
    {
      _id: existing._id,
      consumedAt: null,
      expiresAt: { $gt: now },
      attempts: { $lt: existing.maxAttempts },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  );

  if (!verification) {
    throw AppError.badRequest(ErrorCode.OTP_INVALID, 'That code is not valid. Request a new code.');
  }

  if (!verifyOtpCode(input.code, verification.codeHash)) {
    const attemptsRemaining = Math.max(verification.maxAttempts - verification.attempts, 0);
    throw new AppError(400, ErrorCode.OTP_INVALID, 'That code is incorrect.', {
      meta: { attemptsRemaining },
    });
  }

  verification.consumedAt = new Date();
  await verification.save();

  const merchant = await Merchant.findOne({ phoneE164: verification.phoneE164 });

  if (!merchant) {
    const registration = signRegistrationToken(verification.countryCode, verification.phone);
    return {
      status: 'registration_required',
      registrationToken: registration.token,
      registrationTokenExpiresIn: registration.expiresIn,
      countryCode: verification.countryCode,
      phone: verification.phone,
    };
  }

  if (merchant.status === 'suspended') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account is suspended. Contact support for help.');
  }

  merchant.lastLoginAt = new Date();
  await merchant.save();

  const { tokens } = await createSession('merchant', merchant._id, input.req);

  await writeAudit({
    actorType: 'merchant',
    actorId: merchant._id,
    actorLabel: `${merchant.firstName} ${merchant.lastName}`,
    action: 'merchant.signed_in',
    targetType: 'merchant',
    targetId: merchant._id,
    summary: 'Merchant signed in after phone verification.',
    req: input.req,
  });

  return { status: 'authenticated', merchant: presentMerchant(merchant), tokens };
}

/**
 * Step 4: registration for a newly verified phone number.
 *
 * First name, last name and gender are required. The phone number comes from the
 * verification token, never from the request body, so it cannot be tampered with.
 */
export async function registerMerchant(
  input: RegisterInput & { req?: Request },
): Promise<{ merchant: MerchantView; tokens: IssuedTokens }> {
  const claims = verifyRegistrationToken(input.registrationToken);
  const { countryCode, phone, e164 } = normalizePhone(claims.countryCode, claims.phone);

  const existing = await Merchant.findOne({ phoneE164: e164 });
  if (existing) {
    throw AppError.conflict('This phone number is already registered. Please sign in instead.', {
      code: ErrorCode.ALREADY_REGISTERED,
    });
  }

  const merchant = await Merchant.create({
    countryCode,
    phone,
    phoneE164: e164,
    firstName: input.firstName,
    lastName: input.lastName,
    gender: input.gender,
    photoUrl: input.photoUrl ?? null,
    status: 'active',
    locale: input.locale ?? 'en',
    themeMode: 'system',
    phoneVerifiedAt: new Date(),
    lastLoginAt: new Date(),
  });

  const { tokens } = await createSession('merchant', merchant._id, input.req);

  await writeAudit({
    actorType: 'merchant',
    actorId: merchant._id,
    actorLabel: `${merchant.firstName} ${merchant.lastName}`,
    action: 'merchant.registered',
    targetType: 'merchant',
    targetId: merchant._id,
    summary: `Merchant registered with phone ${maskPhone(countryCode, phone)}.`,
    req: input.req,
  });

  return { merchant: presentMerchant(merchant), tokens };
}
