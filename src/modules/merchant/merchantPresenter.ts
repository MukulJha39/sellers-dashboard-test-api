import type { MerchantDocument } from '../../models/Merchant';
import { toE164 } from '../../utils/phone';

export interface MerchantView {
  id: string;
  countryCode: string;
  phone: string;
  /** Country code + number, ready to display (PRD section 4). */
  phoneE164: string;
  /** Explicit in the contract so no client ever builds an edit affordance for it. */
  phoneEditable: false;
  firstName: string;
  lastName: string;
  fullName: string;
  gender: string;
  photoUrl: string | null;
  status: string;
  locale: string;
  themeMode: string;
  phoneVerifiedAt: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function presentMerchant(merchant: MerchantDocument): MerchantView {
  return {
    id: String(merchant._id),
    countryCode: merchant.countryCode,
    phone: merchant.phone,
    phoneE164: merchant.phoneE164 || toE164(merchant.countryCode, merchant.phone),
    phoneEditable: false,
    firstName: merchant.firstName,
    lastName: merchant.lastName,
    fullName: `${merchant.firstName} ${merchant.lastName}`.trim(),
    gender: merchant.gender,
    photoUrl: merchant.photoUrl ?? null,
    status: merchant.status,
    locale: merchant.locale,
    themeMode: merchant.themeMode,
    phoneVerifiedAt: merchant.phoneVerifiedAt.toISOString(),
    lastLoginAt: merchant.lastLoginAt ? merchant.lastLoginAt.toISOString() : null,
    createdAt: merchant.createdAt.toISOString(),
    updatedAt: merchant.updatedAt.toISOString(),
  };
}
