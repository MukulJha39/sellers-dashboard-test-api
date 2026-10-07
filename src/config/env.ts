import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

type NodeEnv = 'development' | 'test' | 'production';

function str(key: string, fallback?: string): string {
  const raw = process.env[key];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${key} must be an integer`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'development') as NodeEnv;
const isProduction = nodeEnv === 'production';

const DEV_FALLBACK_SECRETS = {
  access: 'dev_access_secret_change_me_please_32chars_min',
  refresh: 'dev_refresh_secret_change_me_please_32chars_min',
  registration: 'dev_registration_secret_change_me_32chars_min',
};

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: int('PORT', 4000),
  apiPrefix: str('API_PREFIX', '/api/v1'),

  mongoUri: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/sellersdash'),

  jwt: {
    accessSecret: isProduction
      ? str('JWT_ACCESS_SECRET')
      : str('JWT_ACCESS_SECRET', DEV_FALLBACK_SECRETS.access),
    refreshSecret: isProduction
      ? str('JWT_REFRESH_SECRET')
      : str('JWT_REFRESH_SECRET', DEV_FALLBACK_SECRETS.refresh),
    registrationSecret: isProduction
      ? str('JWT_REGISTRATION_SECRET')
      : str('JWT_REGISTRATION_SECRET', DEV_FALLBACK_SECRETS.registration),
    accessTtl: int('ACCESS_TOKEN_TTL', 900),
    refreshTtl: int('REFRESH_TOKEN_TTL', 60 * 60 * 24 * 30),
    registrationTtl: int('REGISTRATION_TOKEN_TTL', 900),
  },

  otp: {
    length: int('OTP_LENGTH', 6),
    ttlSeconds: int('OTP_TTL_SECONDS', 300),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 30),
    maxPerPhonePerHour: int('OTP_MAX_PER_PHONE_PER_HOUR', 5),
    // Development convenience only. Hard-disabled in production by assertProductionConfig.
    exposeInResponse: !isProduction && bool('OTP_EXPOSE_IN_RESPONSE', true),
  },

  smsProvider: str('SMS_PROVIDER', 'console'),

  corsOrigins: list('CORS_ORIGINS', ['http://localhost:3100', 'http://127.0.0.1:3100']),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 4000)}`),

  upload: {
    dir: path.resolve(process.cwd(), str('UPLOAD_DIR', 'uploads')),
    maxBytes: int('UPLOAD_MAX_BYTES', 5 * 1024 * 1024),
  },

  seed: {
    superAdminEmail: str('SEED_SUPER_ADMIN_EMAIL', 'admin@sellersdash.local'),
    superAdminPassword: str('SEED_SUPER_ADMIN_PASSWORD', 'ChangeMe#12345'),
    superAdminName: str('SEED_SUPER_ADMIN_NAME', 'Super Admin'),
  },
} as const;

/** Fails fast at boot so a misconfigured production deployment never starts. */
export function assertProductionConfig(): void {
  if (!env.isProduction) return;

  const weakSecrets = Object.values(DEV_FALLBACK_SECRETS);
  const secrets = [env.jwt.accessSecret, env.jwt.refreshSecret, env.jwt.registrationSecret];

  for (const secret of secrets) {
    if (weakSecrets.includes(secret)) {
      throw new Error('Development JWT secrets must not be used in production');
    }
    if (secret.length < 32) {
      throw new Error('JWT secrets must be at least 32 characters in production');
    }
  }

  if (env.otp.exposeInResponse) {
    throw new Error('OTP_EXPOSE_IN_RESPONSE must be disabled in production');
  }
}
