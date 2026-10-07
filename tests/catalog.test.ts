import request from 'supertest';
import { Item } from '../src/models/Item';
import { ServiceOffering } from '../src/models/ServiceOffering';
import {
  API,
  app,
  auth,
  createCategory,
  createItem,
  createMaterial,
  createService,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

describe('catalog vocabulary', () => {
  it('serves the units, billing units and reasons the clients must not hard-code', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .get(`${API}/catalog/meta`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const { units, billingUnits, stockAdjustmentReasons, currencies } = response.body.data;

    expect(units).toEqual(
      expect.arrayContaining([
        { value: 'piece', wholeNumbersOnly: true },
        { value: 'kilogram', wholeNumbersOnly: false },
      ]),
    );
    expect(billingUnits).toEqual(
      expect.arrayContaining([
        { value: 'one_time', supportsDuration: false },
        { value: 'hourly', supportsDuration: true },
      ]),
    );
    expect(stockAdjustmentReasons).toContain('damaged');
    expect(stockAdjustmentReasons).toContain('opening_stock');
    expect(currencies).toContain('INR');
  });
});

describe('items', () => {
  it('creates an item with prices held as whole minor units', async () => {
    const merchant = await registerMerchant();

    const item = await createItem(merchant.accessToken, {
      name: 'Masala Chai Packet',
      sellingPriceMinor: 4500,
      costPriceMinor: 3000,
      sku: 'CHAI-250',
      lowStockThreshold: 10,
    });

    expect(item).toMatchObject({
      name: 'Masala Chai Packet',
      sellingPriceMinor: 4500,
      costPriceMinor: 3000,
      sku: 'CHAI-250',
      unit: 'piece',
      trackStock: true,
      quantity: 0,
      lowStockThreshold: 10,
      archived: false,
    });
  });

  it('refuses a price that is not a whole number of minor units', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Chai', sellingPriceMinor: 45.5 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('sellingPriceMinor');
  });

  it('requires a name', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ sellingPriceMinor: 100 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('name');
  });

  it('keeps a SKU unique for one merchant but lets another merchant reuse it', async () => {
    const first = await registerMerchant();
    const second = await registerMerchant();

    await createItem(first.accessToken, { sku: 'SHARED-1' });

    const clash = await request(app())
      .post(`${API}/items`)
      .set(...auth(first.accessToken))
      .send({ name: 'Another', sku: 'SHARED-1' });
    expect(clash.status).toBe(422);
    expect(clash.body.error.details[0].field).toBe('sku');

    // A SKU is only unique within one business.
    const other = await createItem(second.accessToken, { sku: 'SHARED-1' });
    expect(other.sku).toBe('SHARED-1');
  });

  it('refuses a fractional quantity for a whole-number unit', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Chai', unit: 'piece', openingQuantity: 2.5 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toMatch(/whole number/i);
  });

  it('allows a fractional quantity for a measured unit', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { unit: 'kilogram', openingQuantity: 2.5 });

    expect(item.quantity).toBe(2.5);
  });

  it('updates details without touching stock', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .patch(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Chai Premium', sellingPriceMinor: 5500, lowStockThreshold: 4 });

    expect(response.status).toBe(200);
    expect(response.body.data.item).toMatchObject({
      name: 'Chai Premium',
      sellingPriceMinor: 5500,
      lowStockThreshold: 4,
      quantity: 10,
    });
  });

  it('flags low stock from the quantity and the threshold', async () => {
    const merchant = await registerMerchant();

    const healthy = await createItem(merchant.accessToken, {
      name: 'Healthy',
      openingQuantity: 20,
      lowStockThreshold: 5,
    });
    expect(healthy.isLowStock).toBe(false);
    expect(healthy.isOutOfStock).toBe(false);

    const low = await createItem(merchant.accessToken, {
      name: 'Low',
      openingQuantity: 3,
      lowStockThreshold: 5,
    });
    expect(low.isLowStock).toBe(true);
    expect(low.isOutOfStock).toBe(false);

    const empty = await createItem(merchant.accessToken, { name: 'Empty', lowStockThreshold: 5 });
    expect(empty.isLowStock).toBe(true);
    expect(empty.isOutOfStock).toBe(true);
  });

  it('re-evaluates low stock when the threshold changes', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 8, lowStockThreshold: 2 });
    expect(item.isLowStock).toBe(false);

    const raised = await request(app())
      .patch(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken))
      .send({ lowStockThreshold: 10 });

    expect(raised.body.data.item.isLowStock).toBe(true);
  });

  it('lists with search, filters, sorting and pagination', async () => {
    const merchant = await registerMerchant();
    // Alpha and Beta are stocked, so only Gamma is short. An item with no stock and no
    // threshold is out of stock, which counts as needing attention.
    await createItem(merchant.accessToken, {
      name: 'Alpha',
      sellingPriceMinor: 100,
      openingQuantity: 10,
    });
    await createItem(merchant.accessToken, {
      name: 'Beta',
      sellingPriceMinor: 300,
      openingQuantity: 10,
    });
    await createItem(merchant.accessToken, {
      name: 'Gamma',
      sellingPriceMinor: 200,
      openingQuantity: 2,
      lowStockThreshold: 5,
    });

    const all = await request(app()).get(`${API}/items`).set(...auth(merchant.accessToken));
    expect(all.body.data.meta.total).toBe(3);

    const searched = await request(app())
      .get(`${API}/items?search=bet`)
      .set(...auth(merchant.accessToken));
    expect(searched.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Beta']);

    const sorted = await request(app())
      .get(`${API}/items?sort=-sellingPriceMinor`)
      .set(...auth(merchant.accessToken));
    expect(sorted.body.data.items.map((i: { name: string }) => i.name)).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
    ]);

    const lowStock = await request(app())
      .get(`${API}/items?lowStock=true`)
      .set(...auth(merchant.accessToken));
    expect(lowStock.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Gamma']);

    const paged = await request(app())
      .get(`${API}/items?limit=2&page=2&sort=name`)
      .set(...auth(merchant.accessToken));
    expect(paged.body.data.items.map((i: { name: string }) => i.name)).toEqual(['Gamma']);
    expect(paged.body.data.meta).toMatchObject({ page: 2, limit: 2, total: 3, hasNextPage: false });
  });

  it('treats a search term as literal text', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken, { name: 'Alpha' });

    const response = await request(app())
      .get(`${API}/items?search=.*`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items).toHaveLength(0);
  });

  it('archives and restores, keeping the record and its stock', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 7 });

    const archived = await request(app())
      .post(`${API}/items/${item.id}/archive`)
      .set(...auth(merchant.accessToken));
    expect(archived.status).toBe(200);
    expect(archived.body.data.item.archived).toBe(true);
    // An archived record is not chased for low stock.
    expect(archived.body.data.item.isLowStock).toBe(false);

    const active = await request(app()).get(`${API}/items`).set(...auth(merchant.accessToken));
    expect(active.body.data.meta.total).toBe(0);

    const archivedList = await request(app())
      .get(`${API}/items?archived=true`)
      .set(...auth(merchant.accessToken));
    expect(archivedList.body.data.meta.total).toBe(1);

    const restored = await request(app())
      .post(`${API}/items/${item.id}/restore`)
      .set(...auth(merchant.accessToken));
    expect(restored.body.data.item.archived).toBe(false);
    expect(restored.body.data.item.quantity).toBe(7);
  });

  it('keeps one merchant out of another merchant\'s catalog', async () => {
    const owner = await registerMerchant();
    const other = await registerMerchant();
    const item = await createItem(owner.accessToken);

    const read = await request(app())
      .get(`${API}/items/${item.id}`)
      .set(...auth(other.accessToken));
    expect(read.status).toBe(404);

    const write = await request(app())
      .patch(`${API}/items/${item.id}`)
      .set(...auth(other.accessToken))
      .send({ name: 'Hijacked' });
    expect(write.status).toBe(404);

    expect((await Item.findById(item.id))?.name).toBe('Masala Chai');
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/items`);
    expect(response.status).toBe(401);
  });
});

describe('services', () => {
  it('creates a service with its billing unit and rate', async () => {
    const merchant = await registerMerchant();

    const service = await createService(merchant.accessToken, {
      name: 'Phone Repair',
      billingUnit: 'hourly',
      rateMinor: 60000,
      durationMinutes: 90,
    });

    expect(service).toMatchObject({
      name: 'Phone Repair',
      billingUnit: 'hourly',
      rateMinor: 60000,
      durationMinutes: 90,
      isActive: true,
      affectsStock: false,
    });
  });

  it('keeps a duration only where it means something', async () => {
    const merchant = await registerMerchant();

    // One-time billing has no duration, even if one is sent.
    const oneTime = await createService(merchant.accessToken, {
      name: 'Delivery',
      billingUnit: 'one_time',
      durationMinutes: 30,
    });
    expect(oneTime.durationMinutes).toBeNull();

    const session = await createService(merchant.accessToken, {
      name: 'Consultation',
      billingUnit: 'per_session',
      durationMinutes: 45,
    });
    expect(session.durationMinutes).toBe(45);
  });

  it('clears the duration when the billing unit stops supporting one', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken, {
      name: 'Massage',
      billingUnit: 'hourly',
      durationMinutes: 60,
    });

    const response = await request(app())
      .patch(`${API}/services/${service.id}`)
      .set(...auth(merchant.accessToken))
      .send({ billingUnit: 'package' });

    expect(response.body.data.service.billingUnit).toBe('package');
    expect(response.body.data.service.durationMinutes).toBeNull();
  });

  it('rejects an unknown billing unit', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/services`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Odd', billingUnit: 'per_fortnight', rateMinor: 100 });

    expect(response.status).toBe(422);
  });

  it('can be deactivated without archiving its history', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);

    const response = await request(app())
      .patch(`${API}/services/${service.id}`)
      .set(...auth(merchant.accessToken))
      .send({ isActive: false });

    expect(response.body.data.service.isActive).toBe(false);
    expect(response.body.data.service.archived).toBe(false);

    const activeOnly = await request(app())
      .get(`${API}/services?isActive=true`)
      .set(...auth(merchant.accessToken));
    expect(activeOnly.body.data.meta.total).toBe(0);
  });

  it('filters by billing unit', async () => {
    const merchant = await registerMerchant();
    await createService(merchant.accessToken, { name: 'A', billingUnit: 'hourly' });
    await createService(merchant.accessToken, { name: 'B', billingUnit: 'one_time' });

    const response = await request(app())
      .get(`${API}/services?billingUnit=hourly`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items.map((s: { name: string }) => s.name)).toEqual(['A']);
  });

  it('archives and restores', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);

    await request(app())
      .post(`${API}/services/${service.id}/archive`)
      .set(...auth(merchant.accessToken));
    expect((await ServiceOffering.findById(service.id))?.archived).toBe(true);

    const restored = await request(app())
      .post(`${API}/services/${service.id}/restore`)
      .set(...auth(merchant.accessToken));
    expect(restored.body.data.service.archived).toBe(false);
  });
});

describe('raw materials', () => {
  it('creates a material with its purchase cost and batch details', async () => {
    const merchant = await registerMerchant();

    const material = await createMaterial(merchant.accessToken, {
      name: 'Sugar',
      unit: 'kilogram',
      purchaseCostMinor: 5500,
      batchReference: 'B-2026-09',
      supplierName: 'Pune Wholesale',
      openingQuantity: 12.5,
      lowStockThreshold: 5,
    });

    expect(material).toMatchObject({
      name: 'Sugar',
      unit: 'kilogram',
      purchaseCostMinor: 5500,
      batchReference: 'B-2026-09',
      supplierName: 'Pune Wholesale',
      quantity: 12.5,
      totalReceived: 12.5,
      lowStockThreshold: 5,
      isLowStock: false,
    });
  });

  it('distinguishes what was received from what is available', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken, {
      unit: 'kilogram',
      openingQuantity: 20,
    });

    await request(app())
      .post(`${API}/stock/material/${material.id}/adjust`)
      .set(...auth(merchant.accessToken))
      .send({ change: -8, reason: 'expired' });

    const response = await request(app())
      .get(`${API}/materials/${material.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.material.quantity).toBe(12);
    expect(response.body.data.material.totalReceived).toBe(20);
  });

  it('filters materials that expire soon', async () => {
    const merchant = await registerMerchant();
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();

    await createMaterial(merchant.accessToken, { name: 'Milk', expiryDate: soon });
    await createMaterial(merchant.accessToken, { name: 'Salt', expiryDate: later });
    await createMaterial(merchant.accessToken, { name: 'Flour' });

    const response = await request(app())
      .get(`${API}/materials?expiringWithinDays=30`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items.map((m: { name: string }) => m.name)).toEqual(['Milk']);
  });

  it('rejects an invalid expiry date', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/materials`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Milk', expiryDate: 'not-a-date' });

    expect(response.status).toBe(422);
  });
});

describe('categories', () => {
  it('creates categories per kind and counts what uses them', async () => {
    const merchant = await registerMerchant();
    const beverages = await createCategory(merchant.accessToken, 'item', 'Beverages');
    await createCategory(merchant.accessToken, 'service', 'Repairs');

    await createItem(merchant.accessToken, { name: 'Chai', categoryId: beverages.id });
    await createItem(merchant.accessToken, { name: 'Coffee', categoryId: beverages.id });

    const response = await request(app())
      .get(`${API}/categories`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const names = response.body.data.categories.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Beverages', 'Repairs']));

    const beveragesRow = response.body.data.categories.find(
      (c: { name: string }) => c.name === 'Beverages',
    );
    expect(beveragesRow.usageCount).toBe(2);
  });

  it('refuses a duplicate name within the same kind, but allows it across kinds', async () => {
    const merchant = await registerMerchant();
    await createCategory(merchant.accessToken, 'item', 'Seasonal');

    const duplicate = await request(app())
      .post(`${API}/categories`)
      .set(...auth(merchant.accessToken))
      .send({ kind: 'item', name: 'Seasonal' });
    expect(duplicate.status).toBe(409);

    // The same word can group services as well as items.
    const otherKind = await createCategory(merchant.accessToken, 'service', 'Seasonal');
    expect(otherKind.name).toBe('Seasonal');
  });

  it('restores an archived category when its name is used again', async () => {
    const merchant = await registerMerchant();
    const category = await createCategory(merchant.accessToken, 'item', 'Clearance');

    await request(app())
      .post(`${API}/categories/${category.id}/archive`)
      .set(...auth(merchant.accessToken));

    const again = await request(app())
      .post(`${API}/categories`)
      .set(...auth(merchant.accessToken))
      .send({ kind: 'item', name: 'Clearance' });

    expect(again.status).toBe(201);
    expect(again.body.data.category.id).toBe(category.id);
    expect(again.body.data.category.archived).toBe(false);
  });

  it('renames a category', async () => {
    const merchant = await registerMerchant();
    const category = await createCategory(merchant.accessToken, 'item', 'Drinks');

    const response = await request(app())
      .patch(`${API}/categories/${category.id}`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Beverages' });

    expect(response.status).toBe(200);
    expect(response.body.data.category.name).toBe('Beverages');
  });

  it('leaves records filed under an archived category intact', async () => {
    const merchant = await registerMerchant();
    const category = await createCategory(merchant.accessToken, 'item', 'Beverages');
    const item = await createItem(merchant.accessToken, { categoryId: category.id });

    await request(app())
      .post(`${API}/categories/${category.id}/archive`)
      .set(...auth(merchant.accessToken));

    const response = await request(app())
      .get(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.item.categoryId).toBe(category.id);
    expect(response.body.data.item.categoryName).toBe('Beverages');
  });

  it('refuses a category belonging to another merchant or to the wrong kind', async () => {
    const owner = await registerMerchant();
    const other = await registerMerchant();
    const itemCategory = await createCategory(owner.accessToken, 'item', 'Beverages');

    const foreign = await request(app())
      .post(`${API}/items`)
      .set(...auth(other.accessToken))
      .send({ name: 'Chai', categoryId: itemCategory.id });
    expect(foreign.status).toBe(422);

    // An item category cannot be used for a service.
    const wrongKind = await request(app())
      .post(`${API}/services`)
      .set(...auth(owner.accessToken))
      .send({ name: 'Delivery', categoryId: itemCategory.id });
    expect(wrongKind.status).toBe(422);
  });
});

describe('catalog summary and low stock', () => {
  it('counts the catalog by state', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken, { name: 'Healthy', openingQuantity: 20 });
    await createItem(merchant.accessToken, { name: 'Empty', lowStockThreshold: 2 });
    await createService(merchant.accessToken, { name: 'Delivery' });
    await createMaterial(merchant.accessToken, { name: 'Sugar', openingQuantity: 1, lowStockThreshold: 5 });

    const response = await request(app())
      .get(`${API}/catalog/summary`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.items).toMatchObject({
      active: 2,
      archived: 0,
      lowStock: 1,
      outOfStock: 1,
    });
    expect(response.body.data.summary.services).toMatchObject({ active: 1, inactive: 0 });
    expect(response.body.data.summary.materials).toMatchObject({ active: 1, lowStock: 1 });
  });

  it('lists items and materials that need attention, worst first', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken, { name: 'Low item', openingQuantity: 2, lowStockThreshold: 5 });
    await createItem(merchant.accessToken, { name: 'Empty item', lowStockThreshold: 1 });
    await createMaterial(merchant.accessToken, { name: 'Low material', openingQuantity: 1, lowStockThreshold: 4 });
    await createItem(merchant.accessToken, { name: 'Fine', openingQuantity: 50 });

    const response = await request(app())
      .get(`${API}/catalog/low-stock`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const records = response.body.data.records;
    expect(records.map((r: { name: string }) => r.name)).toEqual([
      'Empty item',
      'Low material',
      'Low item',
    ]);
    expect(records[0]).toMatchObject({ type: 'item', isOutOfStock: true });
    expect(records[1]).toMatchObject({ type: 'material', isOutOfStock: false });
  });
});

describe('router mounting', () => {
  /**
   * The catalog router is mounted on the bare API prefix, so its merchant guard must be
   * scoped to the catalog's own paths. A blanket guard there would reject every admin
   * and anonymous request under the same prefix.
   */
  it('does not let the catalog guard intercept routes it does not own', async () => {
    await seedRbac();

    // Anonymous admin sign-in sits under the same prefix and must still work.
    const session = await signInAdmin();
    expect(session.accessToken).toBeTruthy();

    // An authenticated admin route is likewise unaffected.
    const merchants = await request(app())
      .get(`${API}/admin/merchants`)
      .set(...auth(session.accessToken));
    expect(merchants.status).toBe(200);

    // Health sits outside the prefix entirely.
    const health = await request(app()).get('/health');
    expect(health.status).toBe(200);
  });

  it('still reports an unknown path as not found, rather than unauthorised', async () => {
    const response = await request(app()).get(`${API}/not-a-resource`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
