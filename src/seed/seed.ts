import { env } from '../config/env';
import { ROLE_SEEDS } from '../config/permissions';
import { connectDatabase, disconnectDatabase } from '../db/connect';
import { Admin } from '../models/Admin';
import { Merchant } from '../models/Merchant';
import { RawMaterial } from '../models/RawMaterial';
import { Customer } from '../models/Customer';
import { Item } from '../models/Item';
import { Order } from '../models/Order';
import { ServiceOffering } from '../models/ServiceOffering';
import { createCategory } from '../modules/catalog/categoryService';
import { createItem } from '../modules/catalog/itemService';
import { createMaterial } from '../modules/catalog/materialService';
import { createService } from '../modules/catalog/serviceCatalogService';
import type { StockActor } from '../modules/catalog/stockService';
import { updateBusiness } from '../modules/business/businessService';
import { recordPayment } from '../modules/payments/paymentEngine';
import {
  createOrder,
  evenInstallments,
  setInstallmentPlan,
  transitionOrder,
  type OrderLineInput,
} from '../modules/orders/orderService';
import { createPurchase } from '../modules/purchases/purchaseService';
import { createCustomer } from '../modules/relationships/customerService';
import { createSupplier } from '../modules/relationships/supplierService';
import { toThousandths } from '../utils/quantity';
import { Role } from '../models/Role';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';

export interface SeedSummary {
  rolesCreated: number;
  rolesUpdated: number;
  adminsCreated: number;
  merchantsCreated: number;
  catalogRecordsCreated: number;
  relationshipRecordsCreated: number;
  orderRecordsCreated: number;
}

/** Roles are idempotent: permission sets are brought in line with the catalogue on every run. */
export async function seedRoles(): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const seed of ROLE_SEEDS) {
    const existing = await Role.findOne({ slug: seed.slug });
    if (!existing) {
      await Role.create({ ...seed, isSystem: true });
      created += 1;
      continue;
    }

    existing.name = seed.name;
    existing.description = seed.description;
    existing.permissions = [...seed.permissions];
    existing.isSystem = true;
    await existing.save();
    updated += 1;
  }

  return { created, updated };
}

/**
 * Seeds one admin per role so the permission model is demonstrable end to end
 * (PRD section 26). Existing accounts are never overwritten, and passwords are
 * only ever set at creation time.
 */
export async function seedAdmins(): Promise<number> {
  // A short value here usually means an unquoted "#" in .env truncated the password,
  // which would otherwise silently create an account with a weaker secret than intended.
  if (env.seed.superAdminPassword.length < 12) {
    logger.warn('Seed admin password is shorter than expected', {
      length: env.seed.superAdminPassword.length,
      hint: 'Quote the value in .env if it contains a # character.',
    });
  }

  const accounts: Array<{ email: string; name: string; roleSlug: string; password: string }> = [
    {
      email: env.seed.superAdminEmail,
      name: env.seed.superAdminName,
      roleSlug: 'super_admin',
      password: env.seed.superAdminPassword,
    },
  ];

  if (!env.isProduction) {
    accounts.push(
      { email: 'operations@sellersdash.local', name: 'Operations Admin', roleSlug: 'operations_admin', password: env.seed.superAdminPassword },
      { email: 'support@sellersdash.local', name: 'Support Admin', roleSlug: 'support_admin', password: env.seed.superAdminPassword },
      { email: 'finance@sellersdash.local', name: 'Finance Admin', roleSlug: 'finance_admin', password: env.seed.superAdminPassword },
      { email: 'readonly@sellersdash.local', name: 'Read-only Admin', roleSlug: 'readonly_admin', password: env.seed.superAdminPassword },
    );
  }

  let created = 0;

  for (const account of accounts) {
    const email = account.email.toLowerCase().trim();
    if (await Admin.exists({ email })) continue;

    const role = await Role.findOne({ slug: account.roleSlug });
    if (!role) {
      logger.warn('Skipping admin seed because its role is missing', { roleSlug: account.roleSlug });
      continue;
    }

    const admin = new Admin({ name: account.name, email, roleId: role._id, status: 'active' });
    await admin.setPassword(account.password);
    await admin.save();
    created += 1;
  }

  return created;
}

/** Demo merchants give the admin panel real rows to work with outside production. */
export async function seedDemoMerchants(): Promise<number> {
  if (env.isProduction) return 0;

  const demos = [
    { countryCode: '+91', phone: '9876500001', firstName: 'Anita', lastName: 'Desai', gender: 'female' as const, status: 'active' as const },
    { countryCode: '+91', phone: '9876500002', firstName: 'Rahul', lastName: 'Verma', gender: 'male' as const, status: 'active' as const },
    { countryCode: '+91', phone: '9876500003', firstName: 'Imran', lastName: 'Shaikh', gender: 'male' as const, status: 'suspended' as const },
    { countryCode: '+44', phone: '7700900123', firstName: 'Jo', lastName: 'Harper', gender: 'prefer_not_to_say' as const, status: 'active' as const },
  ];

  let created = 0;

  for (const demo of demos) {
    const { countryCode, phone, e164 } = normalizePhone(demo.countryCode, demo.phone);
    const existing = await Merchant.findOne({ phoneE164: e164 });

    const suspension =
      demo.status === 'suspended'
        ? { suspendedAt: new Date(), suspendedReason: 'Seeded example of a suspended merchant.' }
        : { suspendedAt: null, suspendedReason: null };

    // An existing demo merchant is reconciled rather than skipped. Working in the
    // admin panel changes these rows — suspending one, renaming another — and a seed
    // that left the drift in place would quietly stop providing the fixtures the
    // integration suite is written against. Only these four phone numbers are
    // touched; a merchant who registered through the app is never rewritten.
    if (existing) {
      existing.set({
        firstName: demo.firstName,
        lastName: demo.lastName,
        gender: demo.gender,
        status: demo.status,
        ...suspension,
      });
      if (existing.isModified()) await existing.save();
      continue;
    }

    await Merchant.create({
      countryCode,
      phone,
      phoneE164: e164,
      firstName: demo.firstName,
      lastName: demo.lastName,
      gender: demo.gender,
      status: demo.status,
      locale: 'en',
      themeMode: 'system',
      phoneVerifiedAt: new Date(),
      ...suspension,
    });
    created += 1;
  }

  return created;
}

/**
 * Gives the first demo merchant a business profile and a small catalog.
 *
 * Built through the real services rather than by inserting documents, so opening
 * quantities arrive with proper ledger entries and the seeded data behaves exactly
 * like data a merchant created.
 */
export async function seedDemoCatalog(): Promise<number> {
  if (env.isProduction) return 0;

  const merchant = await Merchant.findOne({ phoneE164: '+919876500001' });
  if (!merchant) return 0;

  // Idempotent: a catalog that already exists is left alone.
  if (await Item.exists({ merchantId: merchant._id })) return 0;

  const actor: StockActor = { type: 'system', label: 'Seed data' };
  const merchantId = merchant._id;
  let created = 0;

  await updateBusiness({
    merchantId,
    data: {
      name: 'Desai General Store',
      category: 'grocery',
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
      contactCountryCode: '+91',
      contactPhone: '2026550100',
      currency: 'INR',
      defaultPaymentTermsDays: 14,
    },
    actor,
  });
  created += 1;

  const beverages = await createCategory({ merchantId, kind: 'item', name: 'Beverages', actor });
  const snacks = await createCategory({ merchantId, kind: 'item', name: 'Snacks', actor });
  const repairs = await createCategory({ merchantId, kind: 'service', name: 'Repairs', actor });
  const packaging = await createCategory({ merchantId, kind: 'material', name: 'Packaging', actor });
  created += 4;

  // Deliberately spans healthy, low and out-of-stock so every state is visible.
  await createItem({
    merchantId,
    data: {
      name: 'Masala Chai Packet',
      categoryId: String(beverages._id),
      unit: 'piece',
      sellingPriceMinor: 4500,
      costPriceMinor: 3000,
      lowStockThresholdThousandths: toThousandths(10),
      sku: 'CHAI-250',
    },
    openingQuantityThousandths: toThousandths(24),
    actor,
  });

  await createItem({
    merchantId,
    data: {
      name: 'Cold Drink 500ml',
      categoryId: String(beverages._id),
      unit: 'bottle',
      sellingPriceMinor: 4000,
      costPriceMinor: 2800,
      lowStockThresholdThousandths: toThousandths(12),
    },
    openingQuantityThousandths: toThousandths(6),
    actor,
  });

  await createItem({
    merchantId,
    data: {
      name: 'Biscuit Pack',
      categoryId: String(snacks._id),
      unit: 'pack',
      sellingPriceMinor: 2000,
      lowStockThresholdThousandths: toThousandths(5),
    },
    actor,
  });
  created += 3;

  await createService({
    merchantId,
    data: { name: 'Home Delivery', billingUnit: 'one_time', rateMinor: 5000 },
    actor,
  });

  await createService({
    merchantId,
    data: {
      name: 'Phone Repair',
      categoryId: String(repairs._id),
      billingUnit: 'hourly',
      rateMinor: 60000,
      durationMinutes: 60,
    },
    actor,
  });
  created += 2;

  await createMaterial({
    merchantId,
    data: {
      name: 'Carry Bags',
      categoryId: String(packaging._id),
      unit: 'pack',
      purchaseCostMinor: 15000,
      lowStockThresholdThousandths: toThousandths(4),
    },
    openingQuantityThousandths: toThousandths(10),
    actor,
  });

  // A fractional quantity, which is why quantities are stored in thousandths.
  await createMaterial({
    merchantId,
    data: {
      name: 'Sugar',
      unit: 'kilogram',
      purchaseCostMinor: 5500,
      lowStockThresholdThousandths: toThousandths(5),
    },
    openingQuantityThousandths: toThousandths(12.5),
    actor,
  });
  created += 2;

  return created;
}

/**
 * Gives the first demo merchant customers, suppliers and a little purchase history.
 *
 * Built through the real services, like the catalog: the purchases receive stock
 * through the ledger and the payments go through the payment engine, so the seeded
 * figures are ones the product itself produced rather than numbers typed into a
 * document.
 */
export async function seedDemoRelationships(): Promise<number> {
  if (env.isProduction) return 0;

  const merchant = await Merchant.findOne({ phoneE164: '+919876500001' });
  if (!merchant) return 0;

  // Idempotent: a merchant who already has customers is left alone.
  if (await Customer.exists({ merchantId: merchant._id })) return 0;

  const actor: StockActor = { type: 'system', label: 'Seed data' };
  const merchantId = merchant._id;
  let created = 0;

  const demoCustomers = [
    {
      phone: '9820012001',
      firstName: 'Kavita',
      lastName: 'Joshi',
      gender: 'female' as const,
      city: 'Pune',
      tags: ['regular'],
      preferredChannel: 'whatsapp' as const,
    },
    {
      phone: '9820012002',
      firstName: 'Suresh',
      lastName: 'Pillai',
      gender: 'male' as const,
      companyName: 'Pillai Caterers',
      tags: ['wholesale'],
      preferredChannel: 'sms' as const,
    },
    {
      phone: '9820012003',
      firstName: 'Fatima',
      lastName: 'Sheikh',
      gender: 'female' as const,
      city: 'Pune',
      language: 'hi' as const,
    },
  ];

  for (const demo of demoCustomers) {
    await createCustomer({
      merchantId,
      data: { countryCode: '+91', ...demo },
      actor,
    });
    created += 1;
  }

  const wholesaler = await createSupplier({
    merchantId,
    data: {
      name: 'Deccan Wholesale',
      contactPerson: 'Mr Kulkarni',
      countryCode: '+91',
      phone: '2026550201',
      city: 'Pune',
    },
    actor,
  });

  const dairy = await createSupplier({
    merchantId,
    data: { name: 'Krishna Dairy', countryCode: '+91', phone: '2026550202' },
    actor,
  });
  created += 2;

  // Raw materials only, and found by what exists rather than by name.
  //
  // Deliberately not items: the catalog seed leaves one item low on stock so the
  // low-stock surfaces have something real to show, and receiving a purchase into it
  // would top it up and quietly remove that fixture.
  const materials = await RawMaterial.find({ merchantId }).sort({ name: 1 }).limit(2);
  const [flour, sugar] = materials;

  // A received, fully paid purchase: the ordinary case.
  if (flour && sugar) {
    const settled = await createPurchase({
      merchantId,
      data: {
        supplierId: String(wholesaler._id),
        lines: [
          { subjectType: 'material', subjectId: String(flour._id), quantity: 25, unitCostMinor: 4200 },
          { subjectType: 'material', subjectId: String(sugar._id), quantity: 10, unitCostMinor: 5500 },
        ],
        additionalCostMinor: 15000,
        receiveStock: true,
      },
      actor,
    });

    await recordPayment({
      merchantId,
      payableType: 'purchase',
      payableId: String(settled._id),
      amountMinor: settled.totalMinor,
      method: 'bank_transfer',
      reference: 'NEFT-SEED-001',
      actor: { type: 'system', label: 'Seed data' },
    });
    created += 1;
  }

  // A part-paid purchase that is past its due date, so the overdue state has something
  // real to show in both clients.
  if (flour) {
    const overdue = await createPurchase({
      merchantId,
      data: {
        supplierId: String(dairy._id),
        lines: [
          { subjectType: 'material', subjectId: String(flour._id), quantity: 15, unitCostMinor: 4200 },
        ],
        dueDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        notes: 'Seeded example of an overdue payable.',
        receiveStock: true,
      },
      actor,
    });

    await recordPayment({
      merchantId,
      payableType: 'purchase',
      payableId: String(overdue._id),
      amountMinor: 50000,
      method: 'cash',
      actor: { type: 'system', label: 'Seed data' },
    });
    created += 1;
  }

  // One recorded but not yet received, so "awaiting stock" is visible too.
  if (sugar) {
    await createPurchase({
      merchantId,
      data: {
        supplierId: String(wholesaler._id),
        lines: [
          { subjectType: 'material', subjectId: String(sugar._id), quantity: 20, unitCostMinor: 5400 },
        ],
        dueDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        receiveStock: false,
      },
      actor,
    });
    created += 1;
  }

  return created;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

/**
 * Gives the first demo merchant a little order history.
 *
 * Built through the real services, like everything else here: the orders commit stock
 * through the ledger, the payments go through the payment engine and the statuses move
 * through the transition map, so every seeded figure is one the product itself produced.
 *
 * Between them the orders cover the states the screens have to show: a closed and settled
 * sale, an instalment plan with one instalment paid and the next due, an overdue balance,
 * an anonymous counter sale and a draft.
 */
export async function seedDemoOrders(): Promise<number> {
  if (env.isProduction) return 0;

  const merchant = await Merchant.findOne({ phoneE164: '+919876500001' });
  if (!merchant) return 0;

  // Idempotent: a merchant who already has orders is left alone.
  if (await Order.exists({ merchantId: merchant._id })) return 0;

  const merchantId = merchant._id;
  const actor: StockActor = { type: 'system', label: 'Seed data' };
  const paymentActor = { type: 'system' as const, label: 'Seed data' };

  const customers = await Customer.find({ merchantId }).sort({ createdAt: 1 }).limit(3);
  const [first, second, third] = customers;

  const services = await ServiceOffering.find({ merchantId, isActive: true }).sort({ name: 1 });
  const [delivery, repair] = services;

  // Services are what the orders are built on, because selling one can never fail: there
  // is no quantity to run out of. Without a service and a customer there is nothing
  // meaningful to seed.
  if (!delivery || !first) return 0;

  // An item is used where one is comfortably stocked, and simply left out otherwise.
  //
  // Chosen by what the record says rather than by name, and only from items that are not
  // low: the catalog seed deliberately leaves one low and another out of stock so the
  // low-stock surfaces have something real to show. Selling those would either consume the
  // fixture or be refused outright, since the ledger will not let stock go negative. On a
  // database whose stock has since been drawn down there may be no such item, and the
  // seed produces service-only orders rather than failing.
  const stocked = await Item.find({
    merchantId,
    trackStock: true,
    isLowStock: false,
    quantityThousandths: { $gte: toThousandths(10) },
  })
    .sort({ name: 1 })
    .limit(1);
  const item = stocked[0];

  const itemLine = (quantity: number): OrderLineInput[] =>
    item ? [{ lineType: 'item', subjectId: String(item._id), quantity }] : [];

  let created = 0;

  // A sale that is finished and settled: the ordinary case, and most of what any real
  // history consists of.
  const settled = await createOrder({
    merchantId,
    data: {
      customerId: String(first._id),
      lines: [
        ...itemLine(2),
        { lineType: 'service', subjectId: String(delivery._id), quantity: 1 },
      ],
      orderDate: daysFromNow(-9).toISOString(),
      notes: 'Seeded example of a completed, settled sale.',
    },
    actor,
  });

  await transitionOrder({ merchantId, orderId: String(settled._id), to: 'completed', actor });

  await recordPayment({
    merchantId,
    payableType: 'order',
    payableId: String(settled._id),
    amountMinor: settled.totalMinor,
    method: 'upi',
    reference: 'UPI-SEED-101',
    actor: paymentActor,
  });
  created += 1;

  // An instalment plan with the first instalment paid and the next one due, which is the
  // state the plan builder and the "next due" emphasis are designed around.
  if (second) {
    const onPlan = await createOrder({
      merchantId,
      data: {
        customerId: String(second._id),
        lines: [
          { lineType: 'service', subjectId: String(repair?._id ?? delivery._id), quantity: 3 },
          ...itemLine(1),
        ],
        taxPercent: 18,
        orderDate: daysFromNow(-45).toISOString(),
        notes: 'Seeded example of an instalment plan.',
      },
      actor,
    });

    const planned = await setInstallmentPlan({
      merchantId,
      orderId: String(onPlan._id),
      installments: evenInstallments(onPlan.totalMinor, 3, daysFromNow(-35), 30),
      actor,
    });

    await recordPayment({
      merchantId,
      payableType: 'order',
      payableId: String(planned._id),
      amountMinor: planned.installments[0]!.amountMinor,
      method: 'cash',
      installmentNumber: 1,
      actor: paymentActor,
    });
    created += 1;
  }

  // A balance that is past its due date, so the overdue state has something real to show
  // on the dashboard, the receivables screen and the customer's own record.
  if (third) {
    await createOrder({
      merchantId,
      data: {
        customerId: String(third._id),
        lines: [
          ...itemLine(2),
          { lineType: 'service', subjectId: String(delivery._id), quantity: 1 },
        ],
        discountType: 'percent',
        discountPercent: 5,
        orderDate: daysFromNow(-26).toISOString(),
        dueDate: daysFromNow(-12).toISOString(),
        notes: 'Seeded example of an overdue receivable.',
      },
      actor,
    });
    created += 1;
  }

  // An anonymous counter sale: no customer, settled on the spot. The PRD allows these
  // (section 8), and a seed without one hides a path the app has to handle.
  const walkIn = await createOrder({
    merchantId,
    data: {
      lines: [{ lineType: 'service', subjectId: String(delivery._id), quantity: 1 }],
      orderDate: new Date().toISOString(),
    },
    actor,
  });

  await recordPayment({
    merchantId,
    payableType: 'order',
    payableId: String(walkIn._id),
    amountMinor: walkIn.totalMinor,
    method: 'cash',
    actor: paymentActor,
  });
  created += 1;

  // A draft, which holds no stock and owes nothing: the held order or quote.
  await createOrder({
    merchantId,
    data: {
      ...(second ? { customerId: String(second._id) } : {}),
      lines: [
        ...itemLine(1),
        { lineType: 'service', subjectId: String(delivery._id), quantity: 2 },
      ],
      status: 'draft',
      notes: 'Seeded example of a held order. Nothing is committed until it is confirmed.',
    },
    actor,
  });
  created += 1;

  return created;
}


export async function runSeed(): Promise<SeedSummary> {
  const roles = await seedRoles();
  const adminsCreated = await seedAdmins();
  const merchantsCreated = await seedDemoMerchants();
  const catalogRecordsCreated = await seedDemoCatalog();
  const relationshipRecordsCreated = await seedDemoRelationships();
  const orderRecordsCreated = await seedDemoOrders();

  return {
    rolesCreated: roles.created,
    rolesUpdated: roles.updated,
    adminsCreated,
    merchantsCreated,
    catalogRecordsCreated,
    relationshipRecordsCreated,
    orderRecordsCreated,
  };
}

async function main(): Promise<void> {
  await connectDatabase();
  const summary = await runSeed();

  console.log('Seed complete:');
  console.log(`  roles created ....... ${summary.rolesCreated}`);
  console.log(`  roles updated ....... ${summary.rolesUpdated}`);
  console.log(`  admins created ...... ${summary.adminsCreated}`);
  console.log(`  merchants created ... ${summary.merchantsCreated}`);
  console.log(`  catalog records ...... ${summary.catalogRecordsCreated}`);
  console.log(`  customers, suppliers & purchases ... ${summary.relationshipRecordsCreated}`);
  console.log(`  orders ............... ${summary.orderRecordsCreated}`);

  if (!env.isProduction) {
    console.log('');
    console.log(`Super admin sign-in: ${env.seed.superAdminEmail}`);
    console.log('Other seeded admins: operations@, support@, finance@, readonly@sellersdash.local');
    console.log('All seeded accounts share SEED_SUPER_ADMIN_PASSWORD. Change them before any shared environment.');
  }

  await disconnectDatabase();
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Seed failed', { reason: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  });
}
