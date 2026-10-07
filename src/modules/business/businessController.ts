import type { Request, Response } from 'express';
import { storeImage } from '../../services/storageService';
import { AppError, ErrorCode } from '../../utils/AppError';
import { sendData } from '../../utils/response';
import type { AuthenticatedMerchant } from '../../types/express';
import { presentBusiness } from '../catalog/catalogPresenters';
import type { StockActor } from '../catalog/stockService';
import { getOrCreateBusiness, replaceBusinessLogo, updateBusiness, type BusinessInput } from './businessService';

function merchantContext(req: Request): AuthenticatedMerchant {
  if (!req.merchant) throw AppError.unauthenticated('Sign in to continue.');
  return req.merchant;
}

function merchantActor(req: Request): StockActor {
  const merchant = merchantContext(req);
  return {
    type: 'merchant',
    id: merchant.objectId,
    label: `${merchant.firstName} ${merchant.lastName}`.trim(),
  };
}

/**
 * Accepts the flat body the clients send and also a nested shape, so a client can
 * post back the same `address` and `contact` objects it received.
 */
function readBusinessInput(body: Record<string, unknown>): BusinessInput {
  const address = (body.address ?? {}) as Record<string, unknown>;
  const contact = (body.contact ?? {}) as Record<string, unknown>;
  const invoice = (body.invoice ?? {}) as Record<string, unknown>;

  const input: BusinessInput = {};

  /**
   * Reads a field from the flat body, falling back to the nested shape.
   *
   * Presence is decided with `in`, not with `??`: a null is how a client clears a
   * saved detail, so treating it as "absent" would make a field impossible to empty
   * once it had been filled in.
   */
  const read = (flatKey: string, nested: Record<string, unknown>, nestedKey: string): unknown => {
    if (flatKey in body) return body[flatKey];
    if (nestedKey in nested) return nested[nestedKey];
    return undefined;
  };

  const assignText = (key: keyof BusinessInput, value: unknown): void => {
    if (value !== undefined) (input as Record<string, unknown>)[key] = value;
  };

  assignText('name', body.name);
  assignText('category', body.category);
  assignText('taxNumber', body.taxNumber);

  assignText('addressLine1', read('addressLine1', address, 'line1'));
  assignText('addressLine2', read('addressLine2', address, 'line2'));
  assignText('city', read('city', address, 'city'));
  assignText('state', read('state', address, 'state'));
  assignText('postalCode', read('postalCode', address, 'postalCode'));
  assignText('country', read('country', address, 'country'));

  assignText('contactEmail', read('contactEmail', contact, 'email'));
  assignText('contactCountryCode', read('contactCountryCode', contact, 'countryCode'));
  assignText('contactPhone', read('contactPhone', contact, 'phone'));
  assignText('website', read('website', contact, 'website'));

  // Currency is the one field with no empty state: there is always a currency, so a
  // null here means "leave it alone" rather than "clear it".
  if (body.currency !== undefined && body.currency !== null) {
    input.currency = String(body.currency);
  }

  const showLogo = read('invoiceShowLogo', invoice, 'showLogo');
  const showAddress = read('invoiceShowAddress', invoice, 'showAddress');
  const showTaxNumber = read('invoiceShowTaxNumber', invoice, 'showTaxNumber');
  const footerNote = read('invoiceFooterNote', invoice, 'footerNote');

  // A switch is either on or off; null is not a third state, so it is ignored.
  if (showLogo !== undefined && showLogo !== null) input.invoiceShowLogo = Boolean(showLogo);
  if (showAddress !== undefined && showAddress !== null) {
    input.invoiceShowAddress = Boolean(showAddress);
  }
  if (showTaxNumber !== undefined && showTaxNumber !== null) {
    input.invoiceShowTaxNumber = Boolean(showTaxNumber);
  }
  if (footerNote !== undefined) input.invoiceFooterNote = footerNote as string | null;

  if (body.defaultPaymentTermsDays !== undefined) {
    input.defaultPaymentTermsDays =
      body.defaultPaymentTermsDays === null ? null : Number(body.defaultPaymentTermsDays);
  }
  if (body.lowStockAlertsEnabled !== undefined && body.lowStockAlertsEnabled !== null) {
    input.lowStockAlertsEnabled = Boolean(body.lowStockAlertsEnabled);
  }

  if (Array.isArray(body.enabledPaymentMethods)) {
    input.enabledPaymentMethods = (body.enabledPaymentMethods as unknown[])
      .filter((value): value is string => typeof value === 'string');
  }

  if (typeof body.defaultOrderStatus === 'string') {
    input.defaultOrderStatus = body.defaultOrderStatus;
  }

  // Presence, not truthiness: an explicit null clears the default rate, and 0 is a rate.
  if ('defaultTaxPercent' in body) {
    const raw = body.defaultTaxPercent;
    input.defaultTaxPercent = raw === null ? null : Number(raw);
  }

  return input;
}

export async function getBusiness(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const business = await getOrCreateBusiness(merchant.objectId);
  sendData(res, { business: presentBusiness(business) });
}

export async function patchBusiness(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const input = readBusinessInput(req.body as Record<string, unknown>);

  if (Object.keys(input).length === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'business', message: 'Change at least one detail before saving.' },
    ]);
  }

  const business = await updateBusiness({
    merchantId: merchant.objectId,
    data: input,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { business: presentBusiness(business) });
}

export async function putBusinessLogo(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  if (!req.file?.buffer) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose an image to upload.');
  }

  const stored = await storeImage(req.file.buffer, 'businesses');
  const business = await replaceBusinessLogo({
    merchantId: merchant.objectId,
    logoUrl: stored.url,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { business: presentBusiness(business) });
}

export async function deleteBusinessLogo(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const business = await replaceBusinessLogo({
    merchantId: merchant.objectId,
    logoUrl: null,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { business: presentBusiness(business) });
}
