/**
 * Runs before the test framework and before any source module is imported, so the
 * configuration module reads these values rather than a developer's local .env.
 */
process.env.NODE_ENV = 'test';
process.env.API_PREFIX = '/api/v1';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_value_for_jest_suite_0001';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_value_for_jest_suite_002';
process.env.JWT_REGISTRATION_SECRET = 'test_registration_secret_for_jest_suite_003';
process.env.ACCESS_TOKEN_TTL = '900';
process.env.REFRESH_TOKEN_TTL = '2592000';
process.env.REGISTRATION_TOKEN_TTL = '900';

process.env.OTP_LENGTH = '6';
process.env.OTP_TTL_SECONDS = '300';
process.env.OTP_MAX_ATTEMPTS = '3';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '30';
process.env.OTP_MAX_PER_PHONE_PER_HOUR = '5';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';

process.env.SMS_PROVIDER = 'console';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:4000';
process.env.UPLOAD_DIR = 'uploads-test';
process.env.UPLOAD_MAX_BYTES = '5242880';

process.env.SEED_SUPER_ADMIN_EMAIL = 'admin@sellersdash.local';
process.env.SEED_SUPER_ADMIN_PASSWORD = 'TestAdminPass#123';
process.env.SEED_SUPER_ADMIN_NAME = 'Super Admin';
