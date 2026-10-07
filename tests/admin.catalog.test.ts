import request from 'supertest';
import { Item } from '../src/models/Item';
import { StockMovement } from '../src/models/StockMovement';
import {
  API,
  app,
  auth,
  createItem,
  createMaterial,
  createService,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';

describe('admin catalog access', () => {
  let superToken = '';

  beforeEach(async () => {
    await seedRbac();
    superToken = (await signInAdmin()).accessToken;
  });

  it('lists items across merchants, naming the owner of each row', async () => {
    const first = await registerMerchant({ firstName: 'Anita', lastName: 'Desai' });
    const second = await registerMerchant({ firstName: 'Rahul', lastName: 'Verma' });
    await createItem(first.accessToken, { name: 'Chai' });
    await createItem(second.accessToken, { name: 'Coffee' });

    const response = await request(app())
      .get(`${API}/admin/items`)
      .set(...auth(superToken));

    expect(response.status).toBe(200);
    expect(response.body.data.meta.total).toBe(2);
    expect(
      response.body.data.items.map((item: { name: string; merchantName: string }) => [
        item.name,
        item.merchantName,
      ]).sort(),
    ).toEqual([
      ['Chai', 'Anita Desai'],
      ['Coffee', 'Rahul Verma'],
    ]);
  });

  it('filters a catalog list down to one merchant', async () => {
    const first = await registerMerchant();
    const second = await registerMerchant();
    await createItem(first.accessToken, { name: 'Chai' });
    await createItem(second.accessToken, { name: 'Coffee' });

    const response = await request(app())
      .get(`${API}/admin/items?merchantId=${first.id}`)
      .set(...auth(superToken));

    expect(response.body.data.items.map((item: { name: string }) => item.name)).toEqual(['Chai']);
  });

  it('lists services and materials too', async () => {
    const merchant = await registerMerchant();
    await createService(merchant.accessToken, { name: 'Delivery' });
    await createMaterial(merchant.accessToken, { name: 'Sugar' });

    const services = await request(app())
      .get(`${API}/admin/services`)
      .set(...auth(superToken));
    expect(services.body.data.items.map((s: { name: string }) => s.name)).toEqual(['Delivery']);

    const materials = await request(app())
      .get(`${API}/admin/materials`)
      .set(...auth(superToken));
    expect(materials.body.data.items.map((m: { name: string }) => m.name)).toEqual(['Sugar']);
  });

  it('shows everything running low across all merchants, worst first', async () => {
    const first = await registerMerchant();
    const second = await registerMerchant();
    await createItem(first.accessToken, { name: 'Empty', lowStockThreshold: 2 });
    await createItem(second.accessToken, { name: 'Low', openingQuantity: 1, lowStockThreshold: 5 });
    await createItem(first.accessToken, { name: 'Fine', openingQuantity: 40 });

    const response = await request(app())
      .get(`${API}/admin/low-stock`)
      .set(...auth(superToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((row: { name: string }) => row.name)).toEqual([
      'Empty',
      'Low',
    ]);
    expect(response.body.data.items[0]).toMatchObject({ isOutOfStock: true, type: 'item' });
    expect(response.body.data.items[0].merchantName).toBeTruthy();
  });

  it('reads and edits a merchant business profile', async () => {
    const merchant = await registerMerchant();

    const read = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/business`)
      .set(...auth(superToken));
    expect(read.status).toBe(200);
    expect(read.body.data.business.name).toBeNull();

    const written = await request(app())
      .patch(`${API}/admin/merchants/${merchant.id}/business`)
      .set(...auth(superToken))
      .send({ name: 'Corrected Store Name', city: 'Pune' });

    expect(written.status).toBe(200);
    expect(written.body.data.business.name).toBe('Corrected Store Name');

    // The merchant sees the admin's correction.
    const asMerchant = await request(app())
      .get(`${API}/business`)
      .set(...auth(merchant.accessToken));
    expect(asMerchant.body.data.business.name).toBe('Corrected Store Name');
  });

  it('summarises a merchant catalog for the drill-down view', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken, { name: 'Chai', openingQuantity: 5 });
    await createService(merchant.accessToken, { name: 'Delivery' });

    const response = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/catalog-summary`)
      .set(...auth(superToken));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.items.active).toBe(1);
    expect(response.body.data.summary.services.active).toBe(1);
  });

  it('lists a merchant categories, archived ones included', async () => {
    const merchant = await registerMerchant();
    await request(app())
      .post(`${API}/categories`)
      .set(...auth(merchant.accessToken))
      .send({ kind: 'item', name: 'Beverages' });

    const response = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/categories`)
      .set(...auth(superToken));

    expect(response.status).toBe(200);
    expect(response.body.data.categories.map((c: { name: string }) => c.name)).toEqual(['Beverages']);
  });
});

describe('admin catalog mutations', () => {
  let superToken = '';

  beforeEach(async () => {
    await seedRbac();
    superToken = (await signInAdmin()).accessToken;
  });

  it('corrects an item and audits the admin who did it', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { name: 'Chai' });

    const response = await request(app())
      .patch(`${API}/admin/items/${item.id}`)
      .set(...auth(superToken))
      .send({ name: 'Masala Chai', sellingPriceMinor: 5000 });

    expect(response.status).toBe(200);
    expect(response.body.data.item).toMatchObject({ name: 'Masala Chai', sellingPriceMinor: 5000 });

    // The merchant sees the correction on their own record.
    const asMerchant = await request(app())
      .get(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));
    expect(asMerchant.body.data.item.name).toBe('Masala Chai');
  });

  it('refuses to set stock through an item correction', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .patch(`${API}/admin/items/${item.id}`)
      .set(...auth(superToken))
      .send({ quantity: 500 });

    expect(response.status).toBe(409);
    expect((await Item.findById(item.id))?.quantityThousandths).toBe(10000);
  });

  it('adjusts stock through the same ledger, recorded as an admin action', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .post(`${API}/admin/stock/item/${item.id}/adjust`)
      .set(...auth(superToken))
      .send({ change: -4, reason: 'damaged', note: 'Reported by the merchant over the phone' });

    expect(response.status).toBe(200);
    expect(response.body.data.item.quantity).toBe(6);
    expect(response.body.data.movement).toMatchObject({
      delta: -4,
      balanceAfter: 6,
      reason: 'damaged',
      actorType: 'admin',
    });

    // The merchant's own history shows who made the change.
    const history = await request(app())
      .get(`${API}/stock/history?subjectType=item&subjectId=${item.id}`)
      .set(...auth(merchant.accessToken));
    expect(history.body.data.items[0]).toMatchObject({ actorType: 'admin', delta: -4 });
    expect(history.body.data.items[0].actorLabel).toContain('admin@sellersdash.local');
  });

  it('archives and restores on a merchant behalf', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const archived = await request(app())
      .post(`${API}/admin/items/${item.id}/archive`)
      .set(...auth(superToken));
    expect(archived.body.data.item.archived).toBe(true);

    const restored = await request(app())
      .post(`${API}/admin/items/${item.id}/restore`)
      .set(...auth(superToken));
    expect(restored.body.data.item.archived).toBe(false);
  });

  it('lists stock movements across merchants', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .get(`${API}/admin/stock-movements?subjectId=${item.id}`)
      .set(...auth(superToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({ type: 'opening', balanceAfter: 10 });
    expect(response.body.data.items[0].merchantName).toBeTruthy();
  });

  it('404s for a record that does not exist', async () => {
    const response = await request(app())
      .patch(`${API}/admin/items/0123456789abcdef01234567`)
      .set(...auth(superToken))
      .send({ name: 'Nope' });

    expect(response.status).toBe(404);
  });
});

describe('catalog permissions are enforced by the API', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('lets a read-only admin look but not touch', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    const readOnly = (await signInAdmin('readonly@sellersdash.local', PASSWORD)).accessToken;

    const list = await request(app()).get(`${API}/admin/items`).set(...auth(readOnly));
    expect(list.status).toBe(200);

    const lowStock = await request(app()).get(`${API}/admin/low-stock`).set(...auth(readOnly));
    expect(lowStock.status).toBe(200);

    const edit = await request(app())
      .patch(`${API}/admin/items/${item.id}`)
      .set(...auth(readOnly))
      .send({ name: 'Nope' });
    expect(edit.status).toBe(403);

    const adjust = await request(app())
      .post(`${API}/admin/stock/item/${item.id}/adjust`)
      .set(...auth(readOnly))
      .send({ change: -1, reason: 'lost' });
    expect(adjust.status).toBe(403);

    // Nothing moved.
    expect((await Item.findById(item.id))?.quantityThousandths).toBe(10000);
    expect(await StockMovement.countDocuments({})).toBe(1);
  });

  it('refuses the catalog entirely to a finance admin, who has no catalog permissions', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken);
    const finance = (await signInAdmin('finance@sellersdash.local', PASSWORD)).accessToken;

    const items = await request(app()).get(`${API}/admin/items`).set(...auth(finance));
    expect(items.status).toBe(403);

    const materials = await request(app()).get(`${API}/admin/materials`).set(...auth(finance));
    expect(materials.status).toBe(403);

    // Finance does hold business.view, for the records it needs.
    const business = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/business`)
      .set(...auth(finance));
    expect(business.status).toBe(200);
  });

  it('lets an operations admin manage the catalog', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    const operations = (await signInAdmin('operations@sellersdash.local', PASSWORD)).accessToken;

    const edit = await request(app())
      .patch(`${API}/admin/items/${item.id}`)
      .set(...auth(operations))
      .send({ name: 'Corrected' });
    expect(edit.status).toBe(200);

    const adjust = await request(app())
      .post(`${API}/admin/stock/item/${item.id}/adjust`)
      .set(...auth(operations))
      .send({ change: 2, reason: 'found' });
    expect(adjust.status).toBe(200);
    expect(adjust.body.data.item.quantity).toBe(12);
  });

  it('refuses a support admin the catalog write, while allowing the read', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const support = (await signInAdmin('support@sellersdash.local', PASSWORD)).accessToken;

    const list = await request(app()).get(`${API}/admin/items`).set(...auth(support));
    expect(list.status).toBe(200);

    const edit = await request(app())
      .patch(`${API}/admin/items/${item.id}`)
      .set(...auth(support))
      .send({ name: 'Nope' });
    expect(edit.status).toBe(403);
  });

  it('requires authentication for every catalog endpoint', async () => {
    for (const path of ['/admin/items', '/admin/services', '/admin/materials', '/admin/low-stock']) {
      const response = await request(app()).get(`${API}${path}`);
      expect(response.status).toBe(401);
    }
  });
});
