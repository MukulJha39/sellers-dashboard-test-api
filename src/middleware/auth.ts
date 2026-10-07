import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Permission } from '../config/permissions';
import { Admin } from '../models/Admin';
import { Merchant } from '../models/Merchant';
import { Role } from '../models/Role';
import { Session } from '../models/Session';
import { AppError, ErrorCode } from '../utils/AppError';
import { verifySessionToken } from '../utils/jwt';

function bearerToken(req: Request): string {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    throw AppError.unauthenticated('Sign in to continue.');
  }
  return token.trim();
}

async function loadActiveSession(sessionId: string, subjectId: string): Promise<void> {
  const session = await Session.findById(sessionId).lean();
  if (!session || session.revokedAt || String(session.subjectId) !== subjectId) {
    throw AppError.unauthenticated('This session has ended. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthenticated('Your session has expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
  }
}

/** Authenticates a merchant from the app. Suspended merchants are rejected here. */
export const authenticateMerchant: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const claims = verifySessionToken(bearerToken(req), 'merchant_access');
      await loadActiveSession(claims.sid, claims.sub);

      const merchant = await Merchant.findById(claims.sub);
      if (!merchant) {
        throw AppError.unauthenticated('This account is no longer available.', ErrorCode.INVALID_TOKEN);
      }
      if (merchant.status === 'suspended') {
        throw new AppError(
          403,
          ErrorCode.ACCOUNT_SUSPENDED,
          'This account is suspended. Contact support for help.',
        );
      }

      req.merchant = {
        id: String(merchant._id),
        objectId: merchant._id,
        countryCode: merchant.countryCode,
        phone: merchant.phone,
        firstName: merchant.firstName,
        lastName: merchant.lastName,
      };
      req.sessionId = claims.sid;
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/** Authenticates an internal admin and loads their role permissions. */
export const authenticateAdmin: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const claims = verifySessionToken(bearerToken(req), 'admin_access');
      await loadActiveSession(claims.sid, claims.sub);

      const admin = await Admin.findById(claims.sub);
      if (!admin || admin.status !== 'active') {
        throw AppError.unauthenticated('This admin account is not active.', ErrorCode.INVALID_TOKEN);
      }

      const role = await Role.findById(admin.roleId).lean();
      if (!role) {
        throw AppError.forbidden('Your admin role is missing. Contact a super administrator.');
      }

      req.admin = {
        id: String(admin._id),
        objectId: admin._id,
        name: admin.name,
        email: admin.email,
        roleSlug: role.slug,
        roleName: role.name,
        permissions: role.permissions as Permission[],
        mustChangePassword: admin.mustChangePassword,
      };
      req.sessionId = claims.sid;
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Blocks an admin who is still carrying a password somebody else chose.
 *
 * Without this the forced change would be a suggestion the panel makes and any other
 * client could ignore. It is mounted once, in front of every admin route except the few
 * needed to get out of the state: read your own profile, change your password, sign out.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (req.admin?.mustChangePassword) {
    next(
      new AppError(
        403,
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
        'Choose a new password before using the admin panel.',
      ),
    );
    return;
  }
  next();
};

/**
 * Server-side permission enforcement (PRD section 26). The admin panel also hides
 * what an admin cannot do, but this is the check that actually protects the data.
 */
export function requirePermission(...required: Permission[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.admin;
    if (!admin) {
      next(AppError.unauthenticated('Sign in to continue.'));
      return;
    }

    const missing = required.filter((permission) => !admin.permissions.includes(permission));
    if (missing.length > 0) {
      next(AppError.forbidden('Your role does not allow this action.'));
      return;
    }

    next();
  };
}
