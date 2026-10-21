import request from 'supertest';
import { PERMISSIONS } from '../src/config/permissions';
import { AuditLog } from '../src/models/AuditLog';
import { Item } from '../src/models/Item';
import { RawMaterial } from '../src/models/RawMaterial';
import { ServiceOffering } from '../src/models/ServiceOffering';
import { StockMovement } from '../src/models/StockMovement';
import {
  API,
  app,
  auth,
  createCustomer,
  createItem,
  createMaterial,
  createPurchase,
  createService,
  createSupplier,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';

describe('merchant catalog deletion', () => {
  it('deletes an unused item along with its stock ledger', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 12 });

    // The opening quantity went through the ledger, so there is history to clean up.
    expect(await StockMovement.countDocuments({ subjectId: item.id })).toBeGreaterThan(0);

    const response = await request(app())
      .delete(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(true);
    expect(response.body.data.stockMovementsDeleted).toBeGreaterThan(0);

    expect(await Item.findById(item.id)).toBeNull();
    // The ledger must not outlive its subject.
    expect(await StockMovement.countDocuments({ subjectId: item.id })).toBe(0);

    const after = await request(app())
      .get(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));
    expect(after.status).toBe(404);
  });

  it('deletes an unused service and raw material', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken);

    const serviceResponse = await request(app())
      .delete(`${API}/services/${service.id}`)
      .set(...auth(merchant.accessToken));
    expect(serviceResponse.status).toBe(200);
    expect(await ServiceOffering.findById(service.id)).toBeNull();

    const materialResponse = await request(app())
      .delete(`${API}/materials/${material.id}`)
      .set(...auth(merchant.accessToken));
    expect(materialResponse.status).toBe(200);
    expect(await RawMaterial.findById(material.id)).toBeNull();
  });

  it('refuses to delete an item an order refers to, and says how much history is at stake', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    const customer = await createCustomer(merchant.accessToken);

    const order = await request(app())
      .post(`${API}/orders`)
      .set(...auth(merchant.accessToken))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
      });
    expect(order.status).toBe(201);

    const response = await request(app())
      .delete(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('RECORD_IN_USE');
    expect(response.body.error.meta.orders).toBe(1);
    expect(response.body.error.message).toContain('Archive it instead');

    // Nothing was removed on the way to refusing.
    expect(await Item.findById(item.id)).not.toBeNull();
    expect(await StockMovement.countDocuments({ subjectId: item.id })).toBeGreaterThan(0);
  });

  it('refuses to delete a service an order refers to', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);
    const customer = await createCustomer(merchant.accessToken);

    const order = await request(app())
      .post(`${API}/orders`)
      .set(...auth(merchant.accessToken))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      });
    expect(order.status).toBe(201);

    const response = await request(app())
      .delete(`${API}/services/${service.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(409);
    expect(response.body.error.meta.orders).toBe(1);
    expect(await ServiceOffering.findById(service.id)).not.toBeNull();
  });

  it('refuses to delete a raw material a purchase refers to', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken);
    const supplier = await createSupplier(merchant.accessToken);

    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 4, unitCostMinor: 5000 },
      ],
    });

    const response = await request(app())
      .delete(`${API}/materials/${material.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(409);
    expect(response.body.error.meta.purchases).toBe(1);
    expect(await RawMaterial.findById(material.id)).not.toBeNull();
  });

  it('archiving stays available as the reversible alternative', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 3 });
    const customer = await createCustomer(merchant.accessToken);

    await request(app())
      .post(`${API}/orders`)
      .set(...auth(merchant.accessToken))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
      });

    const archived = await request(app())
      .post(`${API}/items/${item.id}/archive`)
      .set(...auth(merchant.accessToken));

    expect(archived.status).toBe(200);
    expect(archived.body.data.item.archived).toBe(true);
    expect(await Item.findById(item.id)).not.toBeNull();
  });

  it('will not delete another merchant’s record', async () => {
    const owner = await registerMerchant();
    const stranger = await registerMerchant();
    const item = await createItem(owner.accessToken);

    const response = await request(app())
      .delete(`${API}/items/${item.id}`)
      .set(...auth(stranger.accessToken));

    expect(response.status).toBe(404);
    expect(await Item.findById(item.id)).not.toBeNull();
  });

  it('requires authentication', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const response = await request(app()).delete(`${API}/items/${item.id}`);

    expect(response.status).toBe(401);
    expect(await Item.findById(item.id)).not.toBeNull();
  });

  it('records the deletion in the audit trail', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { name: 'Clay Cup' });

    await request(app())
      .delete(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken))
      .expect(200);

    const entry = await AuditLog.findOne({ action: 'item.deleted', targetId: item.id });
    expect(entry).not.toBeNull();
    expect(entry?.summary).toContain('Clay Cup');
    expect(entry?.actorType).toBe('merchant');
  });
});

describe('admin catalog deletion', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('lets a super admin delete a merchant’s unused item', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const admin = await signInAdmin();

    const response = await request(app())
      .delete(`${API}/admin/items/${item.id}`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(true);
    expect(response.body.data.merchantId).toBe(merchant.id);
    expect(await Item.findById(item.id)).toBeNull();
  });

  it('deletes services and materials through the admin surface too', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken);
    const admin = await signInAdmin();

    await request(app())
      .delete(`${API}/admin/services/${service.id}`)
      .set(...auth(admin.accessToken))
      .expect(200);
    await request(app())
      .delete(`${API}/admin/materials/${material.id}`)
      .set(...auth(admin.accessToken))
      .expect(200);

    expect(await ServiceOffering.findById(service.id)).toBeNull();
    expect(await RawMaterial.findById(material.id)).toBeNull();
  });

  it('refuses an admin without the delete permission, even one who may edit the catalog', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const operations = await signInAdmin('operations@sellersdash.local', PASSWORD);

    // Deliberately narrower than ITEM_MANAGE: archiving is reversible, deleting is not.
    expect(operations.admin.permissions).toContain(PERMISSIONS.ITEM_MANAGE);
    expect(operations.admin.permissions).not.toContain(PERMISSIONS.ITEM_DELETE);

    const response = await request(app())
      .delete(`${API}/admin/items/${item.id}`)
      .set(...auth(operations.accessToken));

    expect(response.status).toBe(403);
    expect(await Item.findById(item.id)).not.toBeNull();

    // The same admin can still archive it.
    await request(app())
      .post(`${API}/admin/items/${item.id}/archive`)
      .set(...auth(operations.accessToken))
      .expect(200);
  });

  it('refuses a read-only admin', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const readonly = await signInAdmin('readonly@sellersdash.local', PASSWORD);

    const response = await request(app())
      .delete(`${API}/admin/items/${item.id}`)
      .set(...auth(readonly.accessToken));

    expect(response.status).toBe(403);
    expect(await Item.findById(item.id)).not.toBeNull();
  });

  it('honours the in-use guard for admins as well', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 5 });
    const customer = await createCustomer(merchant.accessToken);

    await request(app())
      .post(`${API}/orders`)
      .set(...auth(merchant.accessToken))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
      })
      .expect(201);

    const admin = await signInAdmin();
    const response = await request(app())
      .delete(`${API}/admin/items/${item.id}`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('RECORD_IN_USE');
    expect(await Item.findById(item.id)).not.toBeNull();
  });

  it('attributes an admin deletion to the admin, not the merchant', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { name: 'Brass Tray' });
    const admin = await signInAdmin();

    await request(app())
      .delete(`${API}/admin/items/${item.id}`)
      .set(...auth(admin.accessToken))
      .expect(200);

    const entry = await AuditLog.findOne({ action: 'item.deleted', targetId: item.id });
    expect(entry?.actorType).toBe('admin');
    expect(entry?.actorLabel).toContain(admin.admin.email);
  });
});
