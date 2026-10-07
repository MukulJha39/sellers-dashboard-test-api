import { AppError, ErrorCode } from '../src/utils/AppError';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '../src/utils/otp';
import { escapeRegex } from '../src/utils/pagination';
import { maskPhone, normalizeCountryCode, normalizePhone, normalizePhoneNumber } from '../src/utils/phone';

describe('phone normalisation', () => {
  it('keeps the country code and national number separate', () => {
    const result = normalizePhone('91', '98765 43210');
    expect(result).toEqual({ countryCode: '+91', phone: '9876543210', e164: '+919876543210' });
  });

  it('accepts a country code that already has a plus and punctuation', () => {
    expect(normalizeCountryCode('+ 4 4')).toBe('+44');
    expect(normalizeCountryCode('1')).toBe('+1');
  });

  it('strips national trunk prefixes and separators', () => {
    expect(normalizePhoneNumber('0 98765-43210')).toBe('9876543210');
    expect(normalizePhoneNumber('(770) 090-0123')).toBe('7700900123');
  });

  it('rejects an invalid country code', () => {
    expect(() => normalizeCountryCode('++91')).toThrow(AppError);
    expect(() => normalizeCountryCode('abc')).toThrow(/valid country code/i);
  });

  it('rejects a phone number that is too short or not numeric', () => {
    expect(() => normalizePhoneNumber('12')).toThrow(/valid phone number/i);
    expect(() => normalizePhoneNumber('98765abcde')).toThrow(/valid phone number/i);
  });

  it('rejects a number that exceeds the E.164 digit limit', () => {
    expect(() => normalizePhone('+911', '9876543210987')).toThrow(AppError);
  });

  it('masks all but the last two digits for logs', () => {
    expect(maskPhone('+91', '9876543210')).toBe('+91********10');
  });
});

describe('one-time codes', () => {
  it('generates a numeric code of the configured length', () => {
    for (let i = 0; i < 25; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('does not produce the same code every time', () => {
    const codes = new Set(Array.from({ length: 40 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(1);
  });

  it('never stores the code itself and verifies through the hash', () => {
    const code = '123456';
    const hash = hashOtpCode(code);
    expect(hash).not.toContain(code);
    expect(hash).toHaveLength(64);
    expect(verifyOtpCode(code, hash)).toBe(true);
    expect(verifyOtpCode('654321', hash)).toBe(false);
  });

  it('returns false rather than throwing for a malformed stored hash', () => {
    expect(verifyOtpCode('123456', 'not-a-hash')).toBe(false);
  });
});

describe('error shapes', () => {
  it('maps helpers to the right status codes and codes', () => {
    expect(AppError.validation('x').statusCode).toBe(422);
    expect(AppError.unauthenticated().code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(AppError.forbidden().statusCode).toBe(403);
    expect(AppError.notFound().statusCode).toBe(404);
    expect(AppError.rateLimited().statusCode).toBe(429);
    expect(AppError.conflict('x', { code: ErrorCode.PHONE_IMMUTABLE }).code).toBe(
      ErrorCode.PHONE_IMMUTABLE,
    );
    // A conflict can also carry the detail a client needs to act on it: the stock
    // available, the amount outstanding, the record that already holds a number.
    expect(AppError.conflict('x', { meta: { outstanding: 500 } }).meta).toEqual({
      outstanding: 500,
    });
  });
});

describe('search term escaping', () => {
  it('neutralises regex metacharacters so a search cannot change the query', () => {
    expect(escapeRegex('a.*b(c)')).toBe('a\\.\\*b\\(c\\)');
  });
});
