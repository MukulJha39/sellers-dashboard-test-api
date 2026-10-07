import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import type {
  presentCategory,
  presentItem,
  presentRawMaterial,
  presentService,
} from '../src/modules/catalog/catalogPresenters';
import type { presentOrder } from '../src/modules/orders/orderPresenters';
import type {
  presentCustomer,
  presentPaymentEntry,
  presentPurchase,
  presentSupplier,
} from '../src/modules/relationships/relationshipPresenters';
import { seedAdmins, seedRoles } from '../src/seed/seed';

export const API = '/api/v1';

// The helpers return exactly what the API serves, so a test reading `item.quantity`
// is checked against the real contract rather than against an untyped bag.
export type ItemView = ReturnType<typeof presentItem>;
export type ServiceView = ReturnType<typeof presentService>;
export type MaterialView = ReturnType<typeof presentRawMaterial>;
export type CategoryView = ReturnType<typeof presentCategory>;
export type CustomerView = ReturnType<typeof presentCustomer>;
export type SupplierView = ReturnType<typeof presentSupplier>;
export type PurchaseView = ReturnType<typeof presentPurchase>;
export type PaymentView = ReturnType<typeof presentPaymentEntry>;
export type OrderView = ReturnType<typeof presentOrder>;

let cachedApp: Express | null = null;

export function app(): Express {
  if (!cachedApp) cachedApp = createApp();
  return cachedApp;
}

export interface OtpRequested {
  otpId: string;
  code: string;
}

export async function requestOtp(countryCode: string, phone: string): Promise<OtpRequested> {
  const response = await request(app()).post(`${API}/auth/otp/request`).send({ countryCode, phone });
  expect(response.status).toBe(201);
  return { otpId: response.body.data.otpId, code: response.body.data.devCode };
}

export interface VerifiedNewPhone {
  registrationToken: string;
}

/** Walks a brand-new phone number through OTP verification up to the registration step. */
export async function verifyNewPhone(countryCode: string, phone: string): Promise<VerifiedNewPhone> {
  const { otpId, code } = await requestOtp(countryCode, phone);
  const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });
  expect(response.status).toBe(200);
  expect(response.body.data.status).toBe('registration_required');
  return { registrationToken: response.body.data.registrationToken };
}

export interface RegisteredMerchant {
  id: string;
  accessToken: string;
  refreshToken: string;
  merchant: Record<string, unknown>;
}

/** Completes the full onboarding journey and returns usable tokens. */
export async function registerMerchant(options?: {
  countryCode?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
}): Promise<RegisteredMerchant> {
  const countryCode = options?.countryCode ?? '+91';
  const phone = options?.phone ?? `98765${Math.floor(10000 + Math.random() * 89999)}`;

  const { registrationToken } = await verifyNewPhone(countryCode, phone);

  const response = await request(app()).post(`${API}/auth/register`).send({
    registrationToken,
    firstName: options?.firstName ?? 'Anita',
    lastName: options?.lastName ?? 'Desai',
    gender: options?.gender ?? 'female',
  });

  expect(response.status).toBe(201);

  return {
    id: response.body.data.merchant.id,
    accessToken: response.body.data.tokens.accessToken,
    refreshToken: response.body.data.tokens.refreshToken,
    merchant: response.body.data.merchant,
  };
}

export interface SignedInAdmin {
  accessToken: string;
  refreshToken: string;
  admin: { id: string; email: string; permissions: string[]; role: { slug: string } };
}

export async function seedRbac(): Promise<void> {
  await seedRoles();
  await seedAdmins();
}

export async function signInAdmin(
  email = 'admin@sellersdash.local',
  password = 'TestAdminPass#123',
): Promise<SignedInAdmin> {
  const response = await request(app()).post(`${API}/admin/auth/login`).send({ email, password });
  expect(response.status).toBe(200);
  return {
    accessToken: response.body.data.tokens.accessToken,
    refreshToken: response.body.data.tokens.refreshToken,
    admin: response.body.data.admin,
  };
}

/** Smallest byte sequence that is recognised as a real PNG by the storage service. */
export function pngFixture(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
}

/* ----------------------------- Phase 2 helpers ---------------------------- */

export function auth(token: string): [string, string] {
  return ['authorization', `Bearer ${token}`];
}

/** Creates a catalog item and returns the API's view of it. */
export async function createItem(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<ItemView> {
  const response = await request(app())
    .post(`${API}/items`)
    .set(...auth(token))
    .send({ name: 'Masala Chai', unit: 'piece', sellingPriceMinor: 4500, ...overrides });

  expect(response.status).toBe(201);
  return response.body.data.item;
}

export async function createService(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<ServiceView> {
  const response = await request(app())
    .post(`${API}/services`)
    .set(...auth(token))
    .send({ name: 'Home Delivery', billingUnit: 'one_time', rateMinor: 5000, ...overrides });

  expect(response.status).toBe(201);
  return response.body.data.service;
}

export async function createMaterial(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<MaterialView> {
  const response = await request(app())
    .post(`${API}/materials`)
    .set(...auth(token))
    .send({ name: 'Sugar', unit: 'kilogram', purchaseCostMinor: 5500, ...overrides });

  expect(response.status).toBe(201);
  return response.body.data.material;
}

export async function createCategory(
  token: string,
  kind: 'item' | 'service' | 'material',
  name: string,
): Promise<CategoryView> {
  const response = await request(app())
    .post(`${API}/categories`)
    .set(...auth(token))
    .send({ kind, name });

  expect(response.status).toBe(201);
  return response.body.data.category;
}

/** Records a signed stock adjustment and returns the response body. */
export async function adjustStock(
  token: string,
  subjectType: 'item' | 'material',
  subjectId: string,
  body: { change: number; reason: string; note?: string },
) {
  return request(app())
    .post(`${API}/stock/${subjectType}/${subjectId}/adjust`)
    .set(...auth(token))
    .send(body);
}

/* ----------------------- Phase 3: relationship helpers ---------------------- */

/** A phone number that is new on every call, so uniqueness rules are exercised. */
export function freshCustomerPhone(): string {
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

export async function createCustomer(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<CustomerView> {
  const response = await request(app())
    .post(`${API}/customers`)
    .set(...auth(token))
    .send({
      countryCode: '+91',
      phone: freshCustomerPhone(),
      firstName: 'Nisha',
      lastName: 'Rao',
      gender: 'female',
      ...overrides,
    });

  expect(response.status).toBe(201);
  return response.body.data.customer;
}

export async function createSupplier(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<SupplierView> {
  const response = await request(app())
    .post(`${API}/suppliers`)
    .set(...auth(token))
    .send({ name: `Mill Supplies ${Math.floor(Math.random() * 1e9)}`, ...overrides });

  expect(response.status).toBe(201);
  return response.body.data.supplier;
}

export interface PurchaseLineInput {
  subjectType: 'item' | 'material';
  subjectId: string;
  quantity: number;
  unitCostMinor: number;
}

export async function createPurchase(
  token: string,
  body: {
    supplierId: string;
    lines: PurchaseLineInput[];
    additionalCostMinor?: number;
    purchaseDate?: string;
    dueDate?: string | null;
    notes?: string;
    receiveStock?: boolean;
  },
): Promise<PurchaseView> {
  const response = await request(app())
    .post(`${API}/purchases`)
    .set(...auth(token))
    .send(body);

  expect(response.status).toBe(201);
  return response.body.data.purchase;
}

/** Records a payment against a purchase and returns the raw response. */
export async function payPurchase(
  token: string,
  purchaseId: string,
  body: { amountMinor: number; method?: string; reference?: string; paidAt?: string; notes?: string },
) {
  return request(app())
    .post(`${API}/purchases/${purchaseId}/payments`)
    .set(...auth(token))
    .send({ method: 'cash', ...body });
}

/** Reads one item's current stock figures. */
export async function readItem(token: string, itemId: string): Promise<ItemView> {
  const response = await request(app())
    .get(`${API}/items/${itemId}`)
    .set(...auth(token));

  expect(response.status).toBe(200);
  return response.body.data.item;
}

export async function readMaterial(token: string, materialId: string): Promise<MaterialView> {
  const response = await request(app())
    .get(`${API}/materials/${materialId}`)
    .set(...auth(token));

  expect(response.status).toBe(200);
  return response.body.data.material;
}

/* --------------------------- Phase 4: order helpers -------------------------- */

export interface OrderLineInput {
  lineType: 'item' | 'service';
  subjectId: string;
  quantity: number;
  unitRateMinor?: number;
  durationMinutes?: number | null;
}

export async function createOrder(
  token: string,
  body: {
    customerId?: string | null;
    lines: OrderLineInput[];
    discountType?: 'none' | 'amount' | 'percent';
    discountMinor?: number;
    discountPercent?: number;
    taxPercent?: number;
    status?: string;
    orderDate?: string;
    dueDate?: string | null;
    notes?: string;
  },
): Promise<OrderView> {
  const response = await request(app())
    .post(`${API}/orders`)
    .set(...auth(token))
    .send(body);

  expect(response.status).toBe(201);
  return response.body.data.order;
}

/** Moves an order to a new status and returns the raw response, so refusals can be read. */
export async function transitionOrder(
  token: string,
  orderId: string,
  status: string,
  reason?: string,
) {
  return request(app())
    .post(`${API}/orders/${orderId}/status`)
    .set(...auth(token))
    .send({ status, ...(reason ? { reason } : {}) });
}

/** Records a payment against an order and returns the raw response. */
export async function payOrder(
  token: string,
  orderId: string,
  body: {
    amountMinor: number;
    method?: string;
    reference?: string;
    paidAt?: string;
    notes?: string;
    installmentNumber?: number;
  },
) {
  return request(app())
    .post(`${API}/orders/${orderId}/payments`)
    .set(...auth(token))
    .send({ method: 'cash', ...body });
}

export async function readOrder(token: string, orderId: string): Promise<OrderView> {
  const response = await request(app())
    .get(`${API}/orders/${orderId}`)
    .set(...auth(token));

  expect(response.status).toBe(200);
  return response.body.data.order;
}

/** Sets an explicit instalment plan and returns the raw response. */
export async function setInstallmentPlan(
  token: string,
  orderId: string,
  installments: Array<{ amountMinor: number; dueDate: string; notes?: string }>,
) {
  return request(app())
    .put(`${API}/orders/${orderId}/installments`)
    .set(...auth(token))
    .send({ installments });
}

/** Asks the server to build an evenly split plan. */
export async function setEvenPlan(
  token: string,
  orderId: string,
  body: { count: number; firstDueDate: string; everyDays?: number },
) {
  return request(app())
    .post(`${API}/orders/${orderId}/installments/even`)
    .set(...auth(token))
    .send(body);
}

/** A date offset from now, for due dates that are deliberately past or future. */
export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
