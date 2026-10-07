import request from 'supertest';
import { Types } from 'mongoose';
import { detectTransactionSupport } from '../src/db/transaction';
import { AuditLog } from '../src/models/AuditLog';
import { Item } from '../src/models/Item';
import { StockMovement } from '../src/models/StockMovement';
import { recomputeQuantityFromLedger } from '../src/modules/catalog/stockService';
import {
  adjustStock,
  API,
  app,
  auth,
  createItem,
  createMaterial,
  createService,
  registerMerchant,
} from './helpers';

/** Sums the ledger and compares it with the quantity cached on the record. */
async function assertLedgerMatchesRecord(subjectId: string): Promise<number> {
  const fromLedger = await recomputeQuantityFromLedger('item', new Types.ObjectId(subjectId));
  const item = await Item.findById(subjectId);
  expect(item?.quantityThousandths).toBe(fromLedger);
  return fromLedger;
}

describe('the deployment supports transactions', () => {
  it('runs stock writes transactionally, as any real deployment does', async () => {
    // The stock ledger depends on writing a movement and its balance together.
    expect(await detectTransactionSupport()).toBe(true);
  });
});

describe('opening stock', () => {
  it('records the first quantity as an opening movement, not a correction', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 24 });

    expect(item.quantity).toBe(24);
    expect(item.totalReceived).toBe(24);

    const movements = await StockMovement.find({ subjectId: item.id });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe('opening');
    expect(movements[0]?.reason).toBe('opening_stock');
    expect(movements[0]?.balanceAfterThousandths).toBe(24000);
  });

  it('creates no movement when there is no opening quantity', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    expect(item.quantity).toBe(0);
    expect(await StockMovement.countDocuments({ subjectId: item.id })).toBe(0);
  });

  it('keeps a fractional opening quantity exactly', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken, {
      unit: 'kilogram',
      openingQuantity: 12.5,
    });

    expect(material.quantity).toBe(12.5);
    expect(material.totalReceived).toBe(12.5);
  });
});

describe('stock adjustments', () => {
  it('increases stock and records the reason', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: 5,
      reason: 'found',
      note: 'Found a spare box in the back',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.item.quantity).toBe(15);
    expect(response.body.data.movement).toMatchObject({
      type: 'adjustment',
      reason: 'found',
      delta: 5,
      balanceAfter: 15,
      note: 'Found a spare box in the back',
      actorType: 'merchant',
    });
  });

  it('decreases stock for a negative change', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: -4,
      reason: 'damaged',
    });

    expect(response.status).toBe(200);
    expect(response.body.data.item.quantity).toBe(6);
    expect(response.body.data.movement.delta).toBe(-4);
  });

  it('requires a reason, so no change is unexplained', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const missing = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: -1,
    } as never);
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.map((d: { field: string }) => d.field)).toContain('reason');

    const invalid = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: -1,
      reason: 'because',
    });
    expect(invalid.status).toBe(422);

    // Nothing moved.
    expect((await Item.findById(item.id))?.quantityThousandths).toBe(10000);
  });

  it('refuses a change of zero', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: 0,
      reason: 'recount',
    });

    expect(response.status).toBe(422);
  });

  it('refuses to take stock below zero, and says what is available', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 3 });

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: -5,
      reason: 'lost',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/not enough stock/i);
    expect(response.body.error.meta).toMatchObject({ available: 3, unit: 'piece' });

    // The failed attempt left no trace on the record or the ledger.
    expect((await Item.findById(item.id))?.quantityThousandths).toBe(3000);
    expect(await StockMovement.countDocuments({ subjectId: item.id })).toBe(1);
  });

  it('keeps the ledger and the cached quantity in step across many movements', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 100 });

    const changes = [-7, 3, -1, 12, -25, 0.5, -0.25, 4];
    for (const change of changes) {
      const response = await adjustStock(merchant.accessToken, 'item', item.id, {
        change,
        reason: 'manual_correction',
      });
      expect(response.status).toBe(200);
    }

    const expected = 100 + changes.reduce((total, change) => total + change, 0);
    const balance = await assertLedgerMatchesRecord(item.id);
    expect(balance).toBe(Math.round(expected * 1000));

    // Every movement's running balance is consistent with the one before it.
    const movements = await StockMovement.find({ subjectId: item.id }).sort({ createdAt: 1 });
    let running = 0;
    for (const movement of movements) {
      running += movement.deltaThousandths;
      expect(movement.balanceAfterThousandths).toBe(running);
    }
  });

  it('does not count an adjustment as stock received', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    await adjustStock(merchant.accessToken, 'item', item.id, { change: 5, reason: 'found' });

    const updated = await request(app())
      .get(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken));

    // Received is what came in through opening or a purchase, not a correction.
    expect(updated.body.data.item.quantity).toBe(15);
    expect(updated.body.data.item.totalReceived).toBe(10);
  });

  it('writes an audit entry describing the change', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    await adjustStock(merchant.accessToken, 'item', item.id, { change: -2, reason: 'expired' });

    const entry = await AuditLog.findOne({ action: 'stock.adjusted', targetId: item.id }).sort({
      createdAt: -1,
    });
    expect(entry?.summary).toMatch(/decreased by 2 piece \(expired\); now 8/);
    expect(entry?.changes).toEqual([expect.objectContaining({ field: 'quantity', from: 10, to: 8 })]);
  });
});

describe('setting an exact quantity', () => {
  it('records a recount as the difference, not as a new total', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .put(`${API}/stock/item/${item.id}/quantity`)
      .set(...auth(merchant.accessToken))
      .send({ quantity: 7, reason: 'recount', note: 'Counted the shelf' });

    expect(response.status).toBe(200);
    expect(response.body.data.item.quantity).toBe(7);
    expect(response.body.data.movement).toMatchObject({
      delta: -3,
      balanceAfter: 7,
      reason: 'recount',
    });
  });

  it('defaults the reason to a recount', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .put(`${API}/stock/item/${item.id}/quantity`)
      .set(...auth(merchant.accessToken))
      .send({ quantity: 12 });

    expect(response.status).toBe(200);
    expect(response.body.data.movement.reason).toBe('recount');
  });

  it('refuses a recount that changes nothing', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .put(`${API}/stock/item/${item.id}/quantity`)
      .set(...auth(merchant.accessToken))
      .send({ quantity: 10 });

    expect(response.status).toBe(422);
  });

  it('refuses a negative quantity', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const response = await request(app())
      .put(`${API}/stock/item/${item.id}/quantity`)
      .set(...auth(merchant.accessToken))
      .send({ quantity: -1 });

    expect(response.status).toBe(422);
  });
});

describe('stock can only move through the ledger', () => {
  it('refuses a quantity sent to the item details endpoint', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    for (const field of ['quantity', 'quantityThousandths', 'totalReceived', 'isLowStock']) {
      const response = await request(app())
        .patch(`${API}/items/${item.id}`)
        .set(...auth(merchant.accessToken))
        .send({ name: 'Renamed', [field]: 999 });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/stock adjustment/i);
    }

    // Neither the quantity nor the name changed: the request was refused outright.
    const unchanged = await Item.findById(item.id);
    expect(unchanged?.quantityThousandths).toBe(10000);
    expect(unchanged?.name).toBe('Masala Chai');
  });

  it('refuses a quantity sent to the material details endpoint', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken, { openingQuantity: 5 });

    const response = await request(app())
      .patch(`${API}/materials/${material.id}`)
      .set(...auth(merchant.accessToken))
      .send({ quantity: 50 });

    expect(response.status).toBe(409);
  });
});

describe('services never touch physical stock', () => {
  it('rejects stock fields when a service is created', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/services`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Haircut', billingUnit: 'per_session', rateMinor: 20000, quantity: 5 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toMatch(/do not carry stock/i);
  });

  it('has no stock endpoint at all', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);

    const response = await request(app())
      .post(`${API}/stock/service/${service.id}/adjust`)
      .set(...auth(merchant.accessToken))
      .send({ change: 5, reason: 'found' });

    // `service` is not a stock subject type, so the route refuses it.
    expect(response.status).toBe(422);
  });

  it('states in its contract that it cannot affect stock', async () => {
    const merchant = await registerMerchant();
    const service = await createService(merchant.accessToken);

    expect(service.affectsStock).toBe(false);
    expect(service).not.toHaveProperty('quantity');
    expect(service).not.toHaveProperty('unit');
  });

  it('creates no stock movements however many services exist', async () => {
    const merchant = await registerMerchant();
    await createService(merchant.accessToken, { name: 'Delivery' });
    await createService(merchant.accessToken, { name: 'Repair', billingUnit: 'hourly' });

    expect(await StockMovement.countDocuments({})).toBe(0);
  });
});

describe('stock history', () => {
  it('returns the newest movement first, with the running balance', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    await adjustStock(merchant.accessToken, 'item', item.id, { change: -3, reason: 'damaged' });
    await adjustStock(merchant.accessToken, 'item', item.id, { change: 5, reason: 'found' });

    const response = await request(app())
      .get(`${API}/stock/history?subjectType=item&subjectId=${item.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(3);
    expect(response.body.data.items[0]).toMatchObject({ delta: 5, balanceAfter: 12 });
    expect(response.body.data.items[2]).toMatchObject({ type: 'opening', balanceAfter: 10 });
  });

  it('filters by reason and by type', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    await adjustStock(merchant.accessToken, 'item', item.id, { change: -3, reason: 'damaged' });
    await adjustStock(merchant.accessToken, 'item', item.id, { change: -1, reason: 'lost' });

    const damaged = await request(app())
      .get(`${API}/stock/history?reason=damaged`)
      .set(...auth(merchant.accessToken));
    expect(damaged.body.data.items).toHaveLength(1);

    const openings = await request(app())
      .get(`${API}/stock/history?type=opening`)
      .set(...auth(merchant.accessToken));
    expect(openings.body.data.items).toHaveLength(1);
  });

  it('keeps history after the record is archived', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });
    await adjustStock(merchant.accessToken, 'item', item.id, { change: -2, reason: 'damaged' });

    await request(app())
      .post(`${API}/items/${item.id}/archive`)
      .set(...auth(merchant.accessToken));

    const response = await request(app())
      .get(`${API}/stock/history?subjectType=item&subjectId=${item.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items).toHaveLength(2);
    // The name is kept on the movement, so history stays readable.
    expect(response.body.data.items[0].subjectName).toBe('Masala Chai');
  });

  it('refuses to adjust stock on an archived record', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    await request(app())
      .post(`${API}/items/${item.id}/archive`)
      .set(...auth(merchant.accessToken));

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: 1,
      reason: 'found',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/restore/i);
  });
});

describe('ownership', () => {
  it('will not let one merchant adjust another merchant\'s stock', async () => {
    const owner = await registerMerchant();
    const other = await registerMerchant();
    const item = await createItem(owner.accessToken, { openingQuantity: 10 });

    const response = await adjustStock(other.accessToken, 'item', item.id, {
      change: -5,
      reason: 'lost',
    });

    expect(response.status).toBe(404);
    expect((await Item.findById(item.id))?.quantityThousandths).toBe(10000);
  });

  it('will not show another merchant\'s stock history', async () => {
    const owner = await registerMerchant();
    const other = await registerMerchant();
    const item = await createItem(owner.accessToken, { openingQuantity: 10 });

    const scoped = await request(app())
      .get(`${API}/stock/history?subjectType=item&subjectId=${item.id}`)
      .set(...auth(other.accessToken));
    expect(scoped.status).toBe(404);

    // And an unscoped history only ever contains the caller's own movements.
    const all = await request(app())
      .get(`${API}/stock/history`)
      .set(...auth(other.accessToken));
    expect(all.status).toBe(200);
    expect(all.body.data.items).toHaveLength(0);
  });
});

describe('stock tracking can be turned off', () => {
  it('refuses an adjustment for an untracked item', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { trackStock: false });

    const response = await adjustStock(merchant.accessToken, 'item', item.id, {
      change: 5,
      reason: 'found',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/not tracked/i);
  });

  it('never flags an untracked item as low on stock', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, {
      trackStock: false,
      lowStockThreshold: 10,
    });

    expect(item.isLowStock).toBe(false);
    expect(item.isOutOfStock).toBe(false);
  });
});

describe('ledger entries are immutable', () => {
  it('refuses to modify a movement once written', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { openingQuantity: 10 });

    const movement = await StockMovement.findOne({ subjectId: item.id });
    expect(movement).not.toBeNull();

    movement!.deltaThousandths = 999;
    await expect(movement!.save()).rejects.toThrow(/cannot be modified/i);
  });
});
