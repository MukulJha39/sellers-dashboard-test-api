import { AppError, ErrorCode } from './AppError';

export interface NormalizedPhone {
  countryCode: string;
  phone: string;
  e164: string;
}

const COUNTRY_CODE_PATTERN = /^\+[1-9]\d{0,3}$/;
const NATIONAL_NUMBER_PATTERN = /^[1-9]\d{3,14}$/;

/**
 * Country code and national number are stored separately (PRD section 33) so international
 * numbers stay correct, and are combined into E.164 only for display and messaging.
 */
export function normalizeCountryCode(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, '');
  const withPlus = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  if (!COUNTRY_CODE_PATTERN.test(withPlus)) {
    throw AppError.validation('Enter a valid country code.', [
      { field: 'countryCode', message: 'Use a country code such as +91.' },
    ]);
  }
  return withPlus;
}

export function normalizePhoneNumber(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, '').replace(/^0+/, '');
  if (!NATIONAL_NUMBER_PATTERN.test(cleaned)) {
    throw AppError.validation('Enter a valid phone number.', [
      { field: 'phone', message: 'Enter the phone number without the country code.' },
    ]);
  }
  return cleaned;
}

export function normalizePhone(countryCode: string, phone: string): NormalizedPhone {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  const normalizedPhone = normalizePhoneNumber(phone);
  const e164 = `${normalizedCountryCode}${normalizedPhone}`;

  // E.164 allows at most 15 digits in total, country code included.
  if (e164.replace('+', '').length > 15) {
    throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'That phone number is too long.', [
      { field: 'phone', message: 'Check the country code and phone number.' },
    ]);
  }

  return { countryCode: normalizedCountryCode, phone: normalizedPhone, e164 };
}

export function toE164(countryCode: string, phone: string): string {
  return `${countryCode}${phone}`;
}

/** Safe for logs and rate-limit keys: keeps the country code and last two digits only. */
export function maskPhone(countryCode: string, phone: string): string {
  const tail = phone.slice(-2);
  return `${countryCode}${'*'.repeat(Math.max(phone.length - 2, 0))}${tail}`;
}
