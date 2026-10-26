import type { Request, Response } from 'express';
import type { UnitAppliesTo, UnitGroup } from '../../config/catalog';
import type { AuthenticatedAdmin } from '../../types/express';
import { AppError } from '../../utils/AppError';
import { sendData } from '../../utils/response';
import {
  countAllUnitUsage,
  createUnit,
  deleteUnit,
  listUnits,
  presentUnit,
  updateUnit,
  type UnitInput,
} from '../catalog/unitService';

/** Units of measurement: the list behind the admin panel's Units screen. */

function requireAdminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

function readFields(body: Record<string, unknown>): Partial<Omit<UnitInput, 'code'>> {
  const input: Partial<Omit<UnitInput, 'code'>> = {};
  if (body.name !== undefined) input.name = String(body.name);
  if (body.symbol !== undefined) input.symbol = String(body.symbol);
  // null or an empty string clears the icon.
  if (body.icon !== undefined) input.icon = body.icon === null ? null : String(body.icon);
  if (body.group !== undefined && body.group !== null) input.group = String(body.group) as UnitGroup;
  if (body.wholeNumbersOnly !== undefined && body.wholeNumbersOnly !== null) {
    input.wholeNumbersOnly = Boolean(body.wholeNumbersOnly);
  }
  if (Array.isArray(body.appliesTo)) input.appliesTo = body.appliesTo.map(String) as UnitAppliesTo[];
  if (body.isActive !== undefined && body.isActive !== null) input.isActive = Boolean(body.isActive);
  if (body.sortOrder !== undefined && body.sortOrder !== null) input.sortOrder = Number(body.sortOrder);
  return input;
}

const NO_USAGE = { items: 0, materials: 0, orders: 0, purchases: 0 };

export async function getAdminUnits(_req: Request, res: Response): Promise<void> {
  const [units, usage] = await Promise.all([listUnits({ includeInactive: true }), countAllUnitUsage()]);
  sendData(res, {
    units: units.map((unit) => ({ ...presentUnit(unit), usage: usage.get(unit.code) ?? NO_USAGE })),
  });
}

export async function postAdminUnit(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  const fields = readFields(req.body as Record<string, unknown>);
  const unit = await createUnit(
    admin,
    { ...fields, code: String(req.body.code), name: fields.name ?? '', symbol: fields.symbol ?? '' },
    req,
  );
  sendData(res, { unit: { ...presentUnit(unit), usage: NO_USAGE } }, 201);
}

export async function patchAdminUnit(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  const unit = await updateUnit(admin, String(req.params.id), readFields(req.body as Record<string, unknown>), req);
  sendData(res, { unit: presentUnit(unit) });
}

export async function deleteAdminUnit(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  await deleteUnit(admin, String(req.params.id), req);
  sendData(res, { deleted: true });
}
