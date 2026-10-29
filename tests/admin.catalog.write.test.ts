import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import {
  API,
  app,
  auth,
  createItem,
  createMaterial,
  createService,
  pngFixture,
  readItem,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';

let adminToken: string;

beforeEach(async () => {
  await seedRbac();
  adminToken = (await signInAdmin()).accessToken;
});

function asAdmin(call: request.Test): request.Test {
  return call.set(...auth(adminToken));
}

describe('admin creates catalog records for a merchant', () => {
  it('creates a product with opening stock, which the merchant then sees as their own', async () => {
    const merchant = await registerMerchant();

    const response = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/items`)).send({
      name: 'Basmati Rice 5kg',
      unit: 'piece',
      sellingPriceMinor: 65_000,
      costPriceMinor: 52_000,
      sku: 'RICE-5',
      openingQuantity: 12,
      lowStockThreshold: 3,
    });

    expect(response.status).toBe(201);
    const item = response.body.data.item;
    expect(item).toMatchObject({ name: 'Basmati Rice 5kg', merchantId: merchant.id, quantity: 12, sku: 'RICE-5' });

    const asMerchant = await readItem(merchant.accessToken, item.id);
    expect(asMerchant.quantity).toBe(12);

    const audit = await AuditLog.findOne({ action: 'item.created' });
    expect(audit?.actorType).toBe('admin');
  });

  it('creates a service and a raw material', async () => {
    const merchant = await registerMerchant();

    const service = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/services`)).send({
      name: 'Tailoring',
      billingUnit: 'per_unit',
      rateMinor: 20_000,
    });
    const material = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/materials`)).send({
      name: 'Cotton thread',
      unit: 'kilogram',
      purchaseCostMinor: 9_000,
      openingQuantity: 2.5,
    });

    expect(service.status).toBe(201);
    expect(service.body.data.service).toMatchObject({ name: 'Tailoring', merchantId: merchant.id });
    expect(material.status).toBe(201);
    expect(material.body.data.material).toMatchObject({ name: 'Cotton thread', quantity: 2.5 });

    const list = await request(app()).get(`${API}/services`).set(...auth(merchant.accessToken));
    expect(list.body.data.items.map((row: { name: string }) => row.name)).toContain('Tailoring');
  });

  it('applies the same validation as the merchant app', async () => {
    const merchant = await registerMerchant();

    const missingName = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/items`)).send({
      unit: 'piece',
      sellingPriceMinor: 100,
    });
    const badPrice = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/items`)).send({
      name: 'Pen',
      unit: 'piece',
      sellingPriceMinor: -5,
    });

    expect(missingName.status).toBe(422);
    expect(badPrice.status).toBe(422);
  });

  it('refuses a merchant that does not exist', async () => {
    const response = await asAdmin(
      request(app()).post(`${API}/admin/merchants/6a0000000000000000000000/items`),
    ).send({ name: 'Pen', unit: 'piece', sellingPriceMinor: 100 });

    expect(response.status).toBe(404);
  });

  it('needs the manage permission for the kind of record', async () => {
    const merchant = await registerMerchant();
    const readOnly = (await signInAdmin('readonly@sellersdash.local', PASSWORD)).accessToken;

    const response = await request(app())
      .post(`${API}/admin/merchants/${merchant.id}/items`)
      .set(...auth(readOnly))
      .send({ name: 'Pen', unit: 'piece', sellingPriceMinor: 100 });

    expect(response.status).toBe(403);
  });
});

describe('admin manages a merchant categories', () => {
  it('creates, renames, archives and restores a category, and files a product under it', async () => {
    const merchant = await registerMerchant();

    const created = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/categories`)).send({
      kind: 'item',
      name: 'Groceries',
    });
    expect(created.status).toBe(201);
    const categoryId = created.body.data.category.id;

    const renamed = await asAdmin(request(app()).patch(`${API}/admin/categories/${categoryId}`)).send({ name: 'Grocery' });
    expect(renamed.body.data.category.name).toBe('Grocery');

    const item = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/items`)).send({
      name: 'Sugar 1kg',
      unit: 'piece',
      sellingPriceMinor: 5_000,
      categoryId,
    });
    expect(item.body.data.item.categoryName).toBe('Grocery');

    const archived = await asAdmin(request(app()).post(`${API}/admin/categories/${categoryId}/archive`));
    expect(archived.body.data.category.archived).toBe(true);
    const restored = await asAdmin(request(app()).post(`${API}/admin/categories/${categoryId}/restore`));
    expect(restored.body.data.category.archived).toBe(false);
  });

  it("refuses a category kind the admin's role cannot manage", async () => {
    const merchant = await registerMerchant();
    const readOnly = (await signInAdmin('readonly@sellersdash.local', PASSWORD)).accessToken;

    const response = await request(app())
      .post(`${API}/admin/merchants/${merchant.id}/categories`)
      .set(...auth(readOnly))
      .send({ kind: 'service', name: 'Repairs' });

    expect(response.status).toBe(403);
  });
});

describe('admin manages photos', () => {
  it('uploads, reorders and removes photos on a product, service and raw material', async () => {
    const merchant = await registerMerchant();
    const records = [
      { path: 'items', key: 'item', id: (await createItem(merchant.accessToken)).id },
      { path: 'services', key: 'service', id: (await createService(merchant.accessToken)).id },
      { path: 'materials', key: 'material', id: (await createMaterial(merchant.accessToken)).id },
    ];

    for (const record of records) {
      const uploaded = await asAdmin(request(app()).post(`${API}/admin/${record.path}/${record.id}/images`))
        .attach('images', pngFixture(), { filename: 'a.png', contentType: 'image/png' })
        .attach('images', pngFixture(), { filename: 'b.png', contentType: 'image/png' });
      expect(uploaded.status).toBe(201);
      const images = uploaded.body.data[record.key].images as Array<{ id: string }>;
      expect(images).toHaveLength(2);

      const reversed = images.map((image) => image.id).reverse();
      const reordered = await asAdmin(request(app()).put(`${API}/admin/${record.path}/${record.id}/images/order`)).send({
        imageIds: reversed,
      });
      expect(reordered.body.data[record.key].images.map((image: { id: string }) => image.id)).toEqual(reversed);

      const removed = await asAdmin(
        request(app()).delete(`${API}/admin/${record.path}/${record.id}/images/${reversed[0]}`),
      );
      expect(removed.body.data[record.key].images).toHaveLength(1);
    }

    // The merchant sees the admin's photos in the app.
    const item = await readItem(merchant.accessToken, records[0]!.id);
    expect(item.images).toHaveLength(1);
  });
});

describe('admin sets stock to a counted figure', () => {
  it('records a recount through the ledger', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await asAdmin(request(app()).put(`${API}/admin/stock/item/${item.id}/quantity`)).send({
      quantity: 7,
      note: 'Counted on site',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.item.quantity).toBe(7);
    expect(response.body.data.movement).toMatchObject({ reason: 'recount' });
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(7);
  });
});

describe('admin edits apply every field', () => {
  it('saves the low-stock threshold, tax rate, barcode and category on a product', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 4 });
    const category = await asAdmin(request(app()).post(`${API}/admin/merchants/${merchant.id}/categories`)).send({
      kind: 'item',
      name: 'Tea',
    });

    const response = await asAdmin(request(app()).patch(`${API}/admin/items/${item.id}`)).send({
      lowStockThreshold: 5,
      taxRatePercent: 12,
      barcode: '8901234567890',
      categoryId: category.body.data.category.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.item).toMatchObject({
      lowStockThreshold: 5,
      isLowStock: true,
      taxRatePercent: 12,
      barcode: '8901234567890',
      categoryName: 'Tea',
    });
  });

  it('saves a raw material expiry date and threshold', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken);

    const response = await asAdmin(request(app()).patch(`${API}/admin/materials/${material.id}`)).send({
      expiryDate: '2027-01-31',
      lowStockThreshold: 2.5,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.material.lowStockThreshold).toBe(2.5);
    expect(response.body.data.material.expiryDate).toMatch(/^2027-01-31/);
  });
});
