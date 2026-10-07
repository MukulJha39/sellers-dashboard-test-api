import { env } from '../config/env';
import { logger } from '../utils/logger';
import { maskPhone } from '../utils/phone';

export interface SmsSendResult {
  providerName: string;
  providerMessageId: string | null;
  accepted: boolean;
}

/**
 * The messaging provider is an implementation detail behind this interface (PRD section 10).
 * Phase 5 adds real SMS and WhatsApp providers without touching callers.
 */
export interface SmsProvider {
  readonly name: string;
  sendOtp(params: { countryCode: string; phone: string; code: string; ttlSeconds: number }): Promise<SmsSendResult>;
}

/** Development provider: logs a masked line and never transmits anything. */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  async sendOtp(params: {
    countryCode: string;
    phone: string;
    code: string;
    ttlSeconds: number;
  }): Promise<SmsSendResult> {
    logger.info('OTP dispatched (console provider)', {
      to: maskPhone(params.countryCode, params.phone),
      ttlSeconds: params.ttlSeconds,
      // The code itself is intentionally not logged.
    });

    if (!env.isProduction && !env.isTest) {
      console.log(`[dev-sms] OTP for ${maskPhone(params.countryCode, params.phone)} is ${params.code}`);
    }

    return { providerName: this.name, providerMessageId: null, accepted: true };
  }
}

let provider: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (provider) return provider;

  switch (env.smsProvider) {
    case 'console':
    default:
      provider = new ConsoleSmsProvider();
      return provider;
  }
}

/** Test seam so suites can assert on dispatches without hitting the console provider. */
export function setSmsProvider(custom: SmsProvider | null): void {
  provider = custom;
}
