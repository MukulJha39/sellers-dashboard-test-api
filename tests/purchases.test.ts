import request from 'supertest';
import {
  adjustStock,
  API,
  app,
  auth,
  createItem,
  createMaterial,
  createPurchase,
  createSupplier,
  payPurchase,
  readItem,
  readMaterial,
  registerMerchant,
} from './helpers';

describe('purchases', () => {
  it('records a purchase, prices the lines and numbers it readably', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        // 12.5 kg at ₹45.00 = ₹562.50
        { subjectType: 'material', subjectId: material.id, quantity: 12.5, unitCostMinor: 4_500 },
        // 3 pieces at ₹120.00 = ₹360.00
        { subjectType: 'item', subjectId: item.id, quantity: 3, unitCostMinor: 12_000 },
      ],
      additionalCostMinor: 5_000,
      receiveStock: false,
    });

    expect(purchase.reference).toMatch(/^PUR-\d{4}$/);
    expect(purchase.lines[0]!.lineTotalMinor).toBe(56_250);
    expect(purchase.lines[1]!.lineTotalMinor).toBe(36_000);
    expect(purchase.subtotalMinor).toBe(92_250);
    expect(purchase.totalMinor).toBe(97_250);
    expect(purchase.paidMinor).toBe(0);
    expect(purchase.outstandingMinor).toBe(97_250);
    expect(purchase.paymentStatus).toBe('unpaid');
    expect(purchase.received).toBe(false);
  });

  it('numbers purchases from one per merchant', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();

    for (const merchant of [one, two]) {
      const supplier = await createSupplier(merchant.accessToken);
      const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });
      const purchase = await createPurchase(merchant.accessToken, {
        supplierId: supplier.id,
        lines: [
          { subjectType: 'material', subjectId: material.id, quantity: 1, unitCostMinor: 1_000 },
        ],
      });

      // Each merchant's first purchase is their number one, whoever else uses the app.
      expect(purchase.reference).toBe('PUR-0001');
    }
  });

  it('snapshots the line names and the supplier, so history survives a rename', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken, { name: 'Original Mills' });
    const material = await createMaterial(merchant.accessToken, {
      name: 'Original Fabric',
      unit: 'kilogram',
    });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 2, unitCostMinor: 1_000 },
      ],
    });

    await request(app())
      .patch(`${API}/materials/${material.id}`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Renamed Fabric' });
    await request(app())
      .patch(`${API}/suppliers/${supplier.id}`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Renamed Mills' });

    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken));

    // What the merchant bought last month did not change because a name did.
    expect(read.body.data.purchase.lines[0]!.name).toBe('Original Fabric');
    expect(read.body.data.purchase.supplierName).toBe('Original Mills');
  });

  it('receives the stock as part of recording the purchase', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, {
      unit: 'kilogram',
      openingQuantity: 5,
    });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 20, unitCostMinor: 4_000 },
      ],
      receiveStock: true,
    });

    expect(purchase.received).toBe(true);
    expect(purchase.receivedAt).not.toBeNull();

    const after = await readMaterial(merchant.accessToken, material.id);
    expect(after.quantity).toBe(25);
    // Received is what came in, and is deliberately separate from what is available.
    expect(after.totalReceived).toBe(25);

    const history = await request(app())
      .get(`${API}/stock/history`)
      .query({ subjectType: 'material', subjectId: material.id })
      .set(...auth(merchant.accessToken));

    const movements = history.body.data.items as Array<Record<string, unknown>>;
    expect(movements[0]!.type).toBe('receipt');
    expect(movements[0]!.delta).toBe(20);
    expect(movements[0]!.balanceAfter).toBe(25);
    // The movement points back at the purchase that caused it.
    expect(movements[0]!.note).toContain(purchase.reference);
  });

  it('receives the stock later, when the goods actually arrive', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece', openingQuantity: 0 });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 10, unitCostMinor: 2_000 }],
      receiveStock: false,
    });

    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(0);

    const received = await request(app())
      .post(`${API}/purchases/${purchase.id}/receive`)
      .set(...auth(merchant.accessToken));

    expect(received.status).toBe(200);
    expect(received.body.data.purchase.received).toBe(true);
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(10);
  });

  it('refuses to receive the same purchase twice', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 4, unitCostMinor: 1_000 }],
      receiveStock: true,
    });
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(4);

    const again = await request(app())
      .post(`${API}/purchases/${purchase.id}/receive`)
      .set(...auth(merchant.accessToken));

    expect(again.status).toBe(409);
    // Still four, not eight: receiving twice would double the stock from one delivery.
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(4);
  });

  it('cancels an unreceived purchase', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 4, unitCostMinor: 1_000 }],
      receiveStock: false,
    });

    const cancelled = await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(merchant.accessToken))
      .send({ reason: 'Ordered by mistake' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.purchase.status).toBe('cancelled');
    expect(cancelled.body.data.purchase.cancelledReason).toBe('Ordered by mistake');

    // And the supplier no longer shows it as owed.
    const supplierAfter = await request(app())
      .get(`${API}/suppliers/${supplier.id}`)
      .set(...auth(merchant.accessToken));
    expect(supplierAfter.body.data.supplier.outstandingMinor).toBe(0);
    expect(supplierAfter.body.data.supplier.purchaseCount).toBe(0);
  });

  it('puts the stock back when a received purchase is cancelled', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece', openingQuantity: 5 });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 10, unitCostMinor: 1_000 }],
      receiveStock: true,
    });
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(15);

    const cancelled = await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(merchant.accessToken))
      .send({ reason: 'Returned to supplier' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.purchase.received).toBe(false);
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(5);

    const history = await request(app())
      .get(`${API}/stock/history`)
      .query({ subjectType: 'item', subjectId: item.id })
      .set(...auth(merchant.accessToken));

    const movements = history.body.data.items as Array<Record<string, unknown>>;
    // A reversal, not a deletion: the receipt and its undoing are both on the record.
    expect(movements[0]!.type).toBe('reversal');
    expect(movements[0]!.delta).toBe(-10);
    expect(movements[1]!.type).toBe('receipt');
  });

  it('refuses to cancel when the goods have since been sold', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece', openingQuantity: 0 });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 10, unitCostMinor: 1_000 }],
      receiveStock: true,
    });

    // Eight of the ten have gone.
    await adjustStock(merchant.accessToken, 'item', item.id, {
      change: -8,
      reason: 'manual_correction',
    });

    const cancelled = await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(merchant.accessToken))
      .send({ reason: 'Wrong supplier' });

    // Refused with the shortfall named, rather than clamping to zero and leaving a
    // quantity the ledger cannot explain.
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.meta.available).toBe(2);

    // Nothing moved, and the purchase is still live.
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(2);
    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken));
    expect(read.body.data.purchase.status).toBe('recorded');
    expect(read.body.data.purchase.received).toBe(true);
  });

  it('refuses to cancel a purchase that has been paid', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 }],
    });
    await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 4_000 });

    const cancelled = await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(merchant.accessToken))
      .send({ reason: 'Changed my mind' });

    // Cancelling would strand the money with nothing to belong to.
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.meta.paid).toBe(4_000);
  });

  it('refuses a fractional quantity of a counted unit', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(merchant.accessToken))
      .send({
        supplierId: supplier.id,
        lines: [{ subjectType: 'item', subjectId: item.id, quantity: 2.5, unitCostMinor: 1_000 }],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toContain('whole number');
  });

  it('refuses a quantity of zero', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(merchant.accessToken))
      .send({
        supplierId: supplier.id,
        lines: [{ subjectType: 'item', subjectId: item.id, quantity: 0, unitCostMinor: 1_000 }],
      });

    expect(response.status).toBe(422);
  });

  it('refuses two lines for the same record', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(merchant.accessToken))
      .send({
        supplierId: supplier.id,
        lines: [
          { subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 1_000 },
          { subjectType: 'item', subjectId: item.id, quantity: 3, unitCostMinor: 1_000 },
        ],
      });

    // Two lines for one thing make the received quantity ambiguous.
    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toContain('already on the purchase');
  });

  it('requires at least one line', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(merchant.accessToken))
      .send({ supplierId: supplier.id, lines: [] });

    expect(response.status).toBe(422);
  });

  it('refuses a record belonging to another merchant', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const supplier = await createSupplier(two.accessToken);
    const item = await createItem(one.accessToken, { unit: 'piece' });

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(two.accessToken))
      .send({
        supplierId: supplier.id,
        lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: 1_000 }],
      });

    expect(response.status).toBe(404);
  });

  it('edits the dates and notes, but never the lines or totals', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 }],
    });

    const response = await request(app())
      .patch(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken))
      .send({
        notes: 'Paid at the counter',
        dueDate: '2026-12-01T00:00:00.000Z',
        // Not editable: these are ignored rather than applied.
        totalMinor: 1,
        lines: [],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.purchase.notes).toBe('Paid at the counter');
    expect(response.body.data.purchase.dueDate).toBe('2026-12-01T00:00:00.000Z');
    expect(response.body.data.purchase.totalMinor).toBe(10_000);
    expect(response.body.data.purchase.lines).toHaveLength(1);
  });

  it('filters by supplier, payment state, received state and overdue', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken, { name: 'Filterable Mills' });
    const other = await createSupplier(merchant.accessToken, { name: 'Other Mills' });
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const overdue = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: 1_000 }],
      dueDate: '2026-01-01T00:00:00.000Z',
      receiveStock: false,
    });
    await createPurchase(merchant.accessToken, {
      supplierId: other.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: 1_000 }],
      receiveStock: true,
    });

    const bySupplier = await request(app())
      .get(`${API}/purchases`)
      .query({ supplierId: supplier.id })
      .set(...auth(merchant.accessToken));
    expect(bySupplier.body.data.items).toHaveLength(1);
    expect(bySupplier.body.data.items[0].id).toBe(overdue.id);

    const awaitingStock = await request(app())
      .get(`${API}/purchases`)
      .query({ received: 'false' })
      .set(...auth(merchant.accessToken));
    expect(awaitingStock.body.data.items).toHaveLength(1);

    const overdueList = await request(app())
      .get(`${API}/purchases`)
      .query({ overdue: 'true' })
      .set(...auth(merchant.accessToken));
    expect(overdueList.body.data.items).toHaveLength(1);
    // The stored status is still "unpaid"; the displayed state folds in the due date.
    expect(overdueList.body.data.items[0].paymentStatus).toBe('unpaid');
    expect(overdueList.body.data.items[0].paymentState).toBe('overdue');
  });

  it('finds every purchase that touched one record', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const wanted = await createItem(merchant.accessToken, { unit: 'piece', name: 'Wanted' });
    const other = await createItem(merchant.accessToken, { unit: 'piece', name: 'Other' });

    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: wanted.id, quantity: 1, unitCostMinor: 1_000 }],
    });
    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: other.id, quantity: 1, unitCostMinor: 1_000 }],
    });

    const response = await request(app())
      .get(`${API}/purchases`)
      .query({ subjectId: wanted.id })
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].lines[0].name).toBe('Wanted');
  });

  it('summarises purchases for the dashboard', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 }],
      receiveStock: false,
      dueDate: '2026-01-01T00:00:00.000Z',
    });
    const paid = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: 3_000 }],
      receiveStock: true,
    });
    await payPurchase(merchant.accessToken, paid.id, { amountMinor: 3_000 });

    const response = await request(app())
      .get(`${API}/purchases/summary`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const summary = response.body.data.summary;
    expect(summary.recorded).toBe(2);
    expect(summary.awaitingStock).toBe(1);
    expect(summary.unpaid).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.outstandingMinor).toBe(10_000);
    expect(summary.spentThisMonthMinor).toBe(13_000);
  });

  it('keeps one merchant out of another merchant purchases', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const supplier = await createSupplier(one.accessToken);
    const item = await createItem(one.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(one.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: 1_000 }],
    });

    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(two.accessToken));
    expect(read.status).toBe(404);

    const cancel = await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(two.accessToken));
    expect(cancel.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/purchases`);
    expect(response.status).toBe(401);
  });
});
