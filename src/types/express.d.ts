import type { Types } from 'mongoose';
import type { Permission } from '../config/permissions';

export interface AuthenticatedMerchant {
  id: string;
  objectId: Types.ObjectId;
  countryCode: string;
  phone: string;
  firstName: string;
  lastName: string;
}

export interface AuthenticatedAdmin {
  id: string;
  objectId: Types.ObjectId;
  name: string;
  email: string;
  roleSlug: string;
  roleName: string;
  permissions: Permission[];
  /** True while this account still holds a password somebody else chose. */
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      merchant?: AuthenticatedMerchant;
      admin?: AuthenticatedAdmin;
      sessionId?: string;
    }
  }
}

export {};
