import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

/**
 * IP-based limits protecting authentication-sensitive routes (PRD section 28).
 *
 * The business-rule limits that matter most — per-phone OTP quota, resend cooldown and
 * attempt ceiling — live in the OTP service so they are enforced per phone number and
 * can be tested directly. These limiters add the coarse network-level ceiling.
 */
function limiter(options: { windowMs: number; limit: number; message: string }) {
  const config: Partial<Options> = {
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Integration suites share one loopback address; per-phone rules still apply.
    skip: () => env.isTest,
    handler: (_req, _res, next) => {
      next(AppError.rateLimited(options.message));
    },
  };
  return rateLimit(config);
}

export const otpRequestLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many verification codes requested. Please wait a few minutes.',
});

export const otpVerifyLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many verification attempts. Please wait a few minutes.',
});

/**
 * Admin sign-in is IP limited rather than tightly throttled: a whole office can share
 * one address, so a very low ceiling would lock colleagues out of each other's
 * sessions. Brute force is already impractical here because passwords are bcrypt
 * hashed at cost 12, making each attempt expensive. Per-account failure throttling is
 * part of the Phase 5 hardening pass.
 */
export const adminLoginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many sign-in attempts. Please wait a few minutes.',
});

export const refreshLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: 'Too many session refresh attempts. Please wait a few minutes.',
});

export const globalLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: 'Too many requests. Please slow down and try again.',
});
