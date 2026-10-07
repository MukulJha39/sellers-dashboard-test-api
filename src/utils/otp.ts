import crypto from 'crypto';
import { env } from '../config/env';

/**
 * OTP codes are never stored in plain text. They are keyed-hashed, and compared in
 * constant time so a verification attempt cannot leak the code through timing.
 */
const OTP_HASH_KEY = crypto
  .createHash('sha256')
  .update(`${env.jwt.accessSecret}:otp-hash-key:v1`)
  .digest();

export function generateOtpCode(length = env.otp.length): string {
  const digits: string[] = [];
  while (digits.length < length) {
    // Rejection sampling keeps every digit uniformly distributed.
    const byte = crypto.randomBytes(1)[0] as number;
    if (byte < 250) digits.push(String(byte % 10));
  }
  return digits.join('');
}

export function hashOtpCode(code: string): string {
  return crypto.createHmac('sha256', OTP_HASH_KEY).update(code).digest('hex');
}

export function verifyOtpCode(code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtpCode(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
