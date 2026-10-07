import request from 'supertest';
import {
  adjustStock,
  API,
  app,
  auth,
  seedRbac,
  signInAdmin,
  createCustomer,
  createItem,
  createOrder,
  createService,
  daysFromNow,
  payOrder,
  readItem,
  readOrder,
  registerMerchant,
  transitionOrder,
} from './helpers';

/**
 * The order lifecycle end to end: pricing, the status map, and what each transition does
 * to stock. The stock assertions are the point — a sale that claims to have happened next
 * to inventory that never moved is the discrepancy a merchant cannot diagnose.
 */

/** A merchant with one stocked item, one service and one customer: the usual fixture. */
async function fixture(options?: { stock?: number }) {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;

  const item = await createItem(token, {
    unit: 'piece',
    sellingPriceMinor: 4_500,
    openingQuantity: options?.stock ?? 20,
  });
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 5_000 });
  const customer = await createCustomer(token);

  return { merchant, token, item, service, customer };
}

describe('order creation', () => {
  it('prices the lines, numbers the order readably and snapshots the names', async () => {
    const { token, item, service, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [
        // 2 pieces at ₹45.00 = ₹90.00
        { lineType: 'item', subjectId: item.id, quantity: 2 },
        { lineType: 'service', subjectId: service.id, quantity: 1 },
      ],
    });

    expect(order.reference).toMatch(/^ORD-\d{4}$/);
    expect(order.lines[0]!.name).toBe(item.name);
    expect(order.lines[0]!.unit).toBe('piece');
    expect(order.lines[0]!.lineTotalMinor).toBe(9_000);
    expect(order.lines[1]!.billingUnit).toBe('one_time');
    expect(order.lines[1]!.lineTotalMinor).toBe(5_000);
    expect(order.subtotalMinor).toBe(14_000);
    expect(order.totalMinor).toBe(14_000);
    expect(order.customerName).toBe(`${customer.firstName} ${customer.lastName}`);
    expect(order.status).toBe('confirmed');
    expect(order.paymentStatus).toBe('unpaid');
  });

  it('takes the sold items out of stock and leaves services alone', async () => {
    const { token, item, service, customer } = await fixture({ stock: 20 });

    await createOrder(token, {
      customerId: customer.id,
      lines: [
        { lineType: 'item', subjectId: item.id, quantity: 3 },
        { lineType: 'service', subjectId: service.id, quantity: 5 },
      ],
    });

    const after = await readItem(token, item.id);
    expect(after.quantity).toBe(17);
  });

  it('records the sale in the ledger, so the movement explains the quantity', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 4 }],
    });

    const movements = await request(app())
      .get(`${API}/stock/history`)
      .query({ subjectType: 'item', subjectId: item.id })
      .set(...auth(token));

    expect(movements.status).toBe(200);
    const sale = movements.body.data.items.find(
      (movement: { type: string }) => movement.type === 'sale',
    );
    expect(sale).toBeDefined();
    expect(sale.delta).toBe(-4);
    expect(sale.balanceAfter).toBe(16);
    expect(sale.note).toContain(order.reference);
    // The movement points back at the order that caused it.
    expect(sale.referenceType).toBe('order');
    expect(sale.referenceId).toBe(order.id);
  });

  it('holds no stock while an order is still a draft', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 6 }],
      status: 'draft',
    });

    expect(order.status).toBe('draft');
    expect(order.stockCommitted).toBe(false);
    expect((await readItem(token, item.id)).quantity).toBe(20);
  });

  it('allows an anonymous counter sale with no customer', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    expect(order.customerId).toBeNull();
    expect(order.customerName).toBeNull();
  });

  it('refuses to sell more than there is in stock, and says how much there is', async () => {
    const { token, item, customer } = await fixture({ stock: 5 });

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 9 }],
      });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.available).toBe(5);
    // Nothing is left behind: no order, and the stock is untouched.
    expect((await readItem(token, item.id)).quantity).toBe(5);

    const list = await request(app())
      .get(`${API}/orders`)
      .set(...auth(token));
    expect(list.body.data.items).toHaveLength(0);
  });

  it('refuses the same record twice on one order', async () => {
    const { token, item, customer } = await fixture();

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [
          { lineType: 'item', subjectId: item.id, quantity: 1 },
          { lineType: 'item', subjectId: item.id, quantity: 2 },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toContain('already on the order');
  });

  it('refuses half a piece of something counted in whole units', async () => {
    const { token, item, customer } = await fixture();

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1.5 }],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('lines[0].quantity');
  });

  it('accepts a fractional quantity of something weighed', async () => {
    const merchant = await registerMerchant();
    const token = merchant.accessToken;
    const byWeight = await createItem(token, {
      name: 'Loose Tea',
      unit: 'kilogram',
      sellingPriceMinor: 60_000,
      openingQuantity: 10,
    });

    const order = await createOrder(token, {
      lines: [{ lineType: 'item', subjectId: byWeight.id, quantity: 1.25 }],
    });

    expect(order.lines[0]!.quantity).toBe(1.25);
    expect(order.totalMinor).toBe(75_000);
    expect((await readItem(token, byWeight.id)).quantity).toBe(8.75);
  });

  it('refuses an order with no lines at all', async () => {
    const { token } = await fixture();

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({ lines: [] });

    expect(response.status).toBe(422);
  });

  it('refuses an archived item', async () => {
    const { token, item, customer } = await fixture();

    await request(app())
      .post(`${API}/items/${item.id}/archive`)
      .set(...auth(token))
      .expect(200);

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('archived');
  });

  it('cannot be created as cancelled or returned', async () => {
    const { token, service } = await fixture();

    for (const status of ['cancelled', 'returned']) {
      const response = await request(app())
        .post(`${API}/orders`)
        .set(...auth(token))
        .send({
          lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
          status,
        });

      expect(response.status).toBe(422);
    }
  });

  it("never shows another merchant's order", async () => {
    const { token, service } = await fixture();
    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const other = await registerMerchant();
    const response = await request(app())
      .get(`${API}/orders/${order.id}`)
      .set(...auth(other.accessToken));

    expect(response.status).toBe(404);
  });
});

describe('order totals', () => {
  it('applies a percentage discount and then tax', async () => {
    const { token, item, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      // 10 pieces at ₹45.00 = ₹450.00
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 10 }],
      discountType: 'percent',
      discountPercent: 10,
      taxPercent: 18,
    });

    expect(order.subtotalMinor).toBe(45_000);
    expect(order.discountMinor).toBe(4_500);
    expect(order.taxMinor).toBe(7_290);
    expect(order.totalMinor).toBe(47_790);
  });

  it('refuses a discount larger than the order', async () => {
    const { token, item, customer } = await fixture();

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
        discountType: 'amount',
        discountMinor: 100_000,
      });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('discountMinor');
  });

  it('honours an overridden unit rate without changing the catalog', async () => {
    const { token, item, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2, unitRateMinor: 4_000 }],
    });

    expect(order.lines[0]!.unitRateMinor).toBe(4_000);
    expect(order.totalMinor).toBe(8_000);
    expect((await readItem(token, item.id)).sellingPriceMinor).toBe(4_500);
  });

  it('keeps the line price it was sold at when the catalog price changes later', async () => {
    const { token, item, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
    });

    await request(app())
      .patch(`${API}/items/${item.id}`)
      .set(...auth(token))
      .send({ sellingPriceMinor: 9_900 })
      .expect(200);

    const reread = await readOrder(token, order.id);
    expect(reread.lines[0]!.unitRateMinor).toBe(4_500);
    expect(reread.totalMinor).toBe(9_000);
  });
});

describe('order transitions', () => {
  it('walks the full lifecycle and records when it completed', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
      status: 'draft',
    });

    for (const status of ['confirmed', 'in_progress', 'ready', 'completed']) {
      const response = await transitionOrder(token, order.id, status);
      expect(response.status).toBe(200);
      expect(response.body.data.order.status).toBe(status);
    }

    const final = await readOrder(token, order.id);
    expect(final.completedAt).not.toBeNull();
    // Stock moved once, at confirmation, and not again at each later step.
    expect((await readItem(token, item.id)).quantity).toBe(18);
  });

  it('commits stock when a draft is confirmed', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 5 }],
      status: 'draft',
    });

    expect((await readItem(token, item.id)).quantity).toBe(20);

    const response = await transitionOrder(token, order.id, 'confirmed');
    expect(response.status).toBe(200);
    expect(response.body.data.order.stockCommitted).toBe(true);
    expect((await readItem(token, item.id)).quantity).toBe(15);
  });

  it('puts the stock back when an order is cancelled', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 4 }],
    });
    expect((await readItem(token, item.id)).quantity).toBe(16);

    const response = await transitionOrder(token, order.id, 'cancelled', 'Customer changed mind');
    expect(response.status).toBe(200);
    expect(response.body.data.order.stockCommitted).toBe(false);
    expect(response.body.data.order.cancelledReason).toBe('Customer changed mind');
    expect((await readItem(token, item.id)).quantity).toBe(20);
  });

  it('puts the stock back when a completed order is returned', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 3 }],
    });
    await transitionOrder(token, order.id, 'completed');
    expect((await readItem(token, item.id)).quantity).toBe(17);

    const response = await transitionOrder(token, order.id, 'returned', 'Faulty');
    expect(response.status).toBe(200);
    expect((await readItem(token, item.id)).quantity).toBe(20);

    const movements = await request(app())
      .get(`${API}/stock/history`)
      .query({ subjectType: 'item', subjectId: item.id })
      .set(...auth(token));
    const restored = movements.body.data.items.find(
      (movement: { type: string }) => movement.type === 'return',
    );
    expect(restored.delta).toBe(3);
  });

  it('refuses a transition that is not on the map, and says what is', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });
    await transitionOrder(token, order.id, 'cancelled');

    const response = await transitionOrder(token, order.id, 'completed');
    expect(response.status).toBe(409);
    expect(response.body.error.meta.allowed).toEqual([]);
  });

  it('refuses to move an order to the status it is already in', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const response = await transitionOrder(token, order.id, 'confirmed');
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('already confirmed');
  });

  it('refuses to cancel an order that has been paid, and says how much', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
    });
    expect((await payOrder(token, order.id, { amountMinor: 3_000 })).status).toBe(201);

    const response = await transitionOrder(token, order.id, 'cancelled');
    expect(response.status).toBe(409);
    expect(response.body.error.meta.paid).toBe(3_000);
    expect((await readOrder(token, order.id)).status).toBe('confirmed');
  });

  it('tells a client what the order may become next', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      status: 'draft',
    });

    const response = await request(app())
      .get(`${API}/orders/${order.id}`)
      .set(...auth(token));

    expect(response.body.data.allowedTransitions).toContain('confirmed');
    expect(response.body.data.allowedTransitions).not.toContain('draft');
  });
});

describe('order editing', () => {
  it('reprices a draft when its lines change', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
      status: 'draft',
    });

    const response = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ lines: [{ lineType: 'item', subjectId: item.id, quantity: 5 }] });

    expect(response.status).toBe(200);
    expect(response.body.data.order.totalMinor).toBe(22_500);
    // A draft still holds nothing, however often it is edited.
    expect((await readItem(token, item.id)).quantity).toBe(20);
  });

  it('refuses to change the lines of an order that has been confirmed', async () => {
    const { token, item, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
    });

    const response = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ lines: [{ lineType: 'item', subjectId: item.id, quantity: 9 }] });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.status).toBe('confirmed');
  });

  it('still allows notes and a due date on a confirmed order', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const response = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ notes: 'Deliver after 6pm', dueDate: daysFromNow(7) });

    expect(response.status).toBe(200);
    expect(response.body.data.order.notes).toBe('Deliver after 6pm');
    expect(response.body.data.order.dueDate).not.toBeNull();
  });
});

describe('order listing', () => {
  it('filters by status, by customer and by what was sold', async () => {
    const { token, item, service, customer } = await fixture({ stock: 30 });
    const other = await createCustomer(token, { firstName: 'Ravi', lastName: 'Kumar' });

    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
    });
    await createOrder(token, {
      customerId: other.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      status: 'draft',
    });

    const drafts = await request(app())
      .get(`${API}/orders?status=draft`)
      .set(...auth(token));
    expect(drafts.body.data.items).toHaveLength(1);

    const forCustomer = await request(app())
      .get(`${API}/orders?customerId=${customer.id}`)
      .set(...auth(token));
    expect(forCustomer.body.data.items).toHaveLength(1);
    expect(forCustomer.body.data.items[0].customerId).toBe(customer.id);

    const withItem = await request(app())
      .get(`${API}/orders?subjectId=${item.id}`)
      .set(...auth(token));
    expect(withItem.body.data.items).toHaveLength(1);
  });

  it('finds an order by its reference and by what is on it', async () => {
    const { token, item, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
    });

    const byReference = await request(app())
      .get(`${API}/orders?search=${order.reference}`)
      .set(...auth(token));
    expect(byReference.body.data.items).toHaveLength(1);

    const byLineName = await request(app())
      .get(`${API}/orders?search=${encodeURIComponent(item.name.slice(0, 5))}`)
      .set(...auth(token));
    expect(byLineName.body.data.items).toHaveLength(1);
  });

  it('lists only the orders that are still open', async () => {
    const { token, service } = await fixture();

    const open = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });
    const done = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });
    await transitionOrder(token, done.id, 'completed');

    const response = await request(app())
      .get(`${API}/orders?open=true`)
      .set(...auth(token));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].id).toBe(open.id);
  });
});

describe('stock and orders together', () => {
  it('lets an order be sold right down to zero but no further', async () => {
    const { token, item, customer } = await fixture({ stock: 5 });

    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 5 }],
    });

    const emptied = await readItem(token, item.id);
    expect(emptied.quantity).toBe(0);
    expect(emptied.isOutOfStock).toBe(true);

    const response = await request(app())
      .post(`${API}/orders`)
      .set(...auth(token))
      .send({
        customerId: customer.id,
        lines: [{ lineType: 'item', subjectId: item.id, quantity: 1 }],
      });
    expect(response.status).toBe(409);
  });

  it('leaves an untracked item alone, and still sells it', async () => {
    const merchant = await registerMerchant();
    const token = merchant.accessToken;
    const untracked = await createItem(token, { trackStock: false, sellingPriceMinor: 2_500 });

    const order = await createOrder(token, {
      lines: [{ lineType: 'item', subjectId: untracked.id, quantity: 7 }],
    });

    expect(order.totalMinor).toBe(17_500);
    // Nothing was committed, because there is no quantity to commit.
    expect(order.stockCommitted).toBe(true);
    const movements = await request(app())
      .get(`${API}/stock/history`)
      .query({ subjectType: 'item', subjectId: untracked.id })
      .set(...auth(token));
    expect(movements.body.data.items).toHaveLength(0);
  });

  it('agrees with the ledger after a sale, a cancellation and an adjustment', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const first = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 6 }],
    });
    await transitionOrder(token, first.id, 'cancelled');
    await adjustStock(token, 'item', item.id, { change: -2, reason: 'damaged' });

    const second = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 3 }],
    });
    expect(second.status).toBe('confirmed');

    // 20 sold down 6, restored 6, written off 2, sold 3 = 15.
    expect((await readItem(token, item.id)).quantity).toBe(15);
  });
});

describe('order activity', () => {
  it('tells the merchant what has happened to their order, newest first', async () => {
    const { token, item, customer } = await fixture({ stock: 20 });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: item.id, quantity: 2 }],
    });
    await transitionOrder(token, order.id, 'completed');
    await payOrder(token, order.id, { amountMinor: 9_000 });

    const response = await request(app())
      .get(`${API}/orders/${order.id}/activity`)
      .set(...auth(token));

    expect(response.status).toBe(200);
    const actions = response.body.data.activity.map((entry: { action: string }) => entry.action);

    // Newest first, and every step the order went through is there.
    expect(actions[0]).toBe('payment.recorded');
    expect(actions).toContain('order.completed');
    expect(actions).toContain('order.created');
    expect(response.body.data.activity[0].summary).toContain('Recorded');
  });

  it('names support when support did it, so nothing looks self-inflicted', async () => {
    await seedRbac();
    const { token, service } = await fixture();
    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const admin = await signInAdmin();
    await request(app())
      .post(`${API}/admin/orders/${order.id}/payments`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 5_000, method: 'cash' })
      .expect(201);

    const response = await request(app())
      .get(`${API}/orders/${order.id}/activity`)
      .set(...auth(token));

    const byAdmin = response.body.data.activity.find(
      (entry: { actorType: string }) => entry.actorType === 'admin',
    );
    expect(byAdmin).toBeDefined();
    expect(byAdmin.actorLabel).toBeTruthy();
  });

  it('leaves out the operational detail a merchant has no use for', async () => {
    const { token, service } = await fixture();
    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const response = await request(app())
      .get(`${API}/orders/${order.id}/activity`)
      .set(...auth(token));

    const entry = response.body.data.activity[0];
    expect(entry.ip).toBeUndefined();
    expect(entry.requestId).toBeUndefined();
    expect(entry.at).toEqual(expect.any(String));
  });

  it('never shows the activity of another merchant order', async () => {
    const { token, service } = await fixture();
    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const other = await registerMerchant();
    const response = await request(app())
      .get(`${API}/orders/${order.id}/activity`)
      .set(...auth(other.accessToken));

    expect(response.status).toBe(404);
  });
});

describe('correcting a payment entry', () => {
  /** An order with one payment recorded against it. */
  async function paidOrder() {
    const { token, service } = await fixture();
    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
    });
    const recorded = await payOrder(token, order.id, {
      amountMinor: 4_000,
      method: 'cheque',
      reference: 'CHQ-00011',
      notes: 'Taken at the counter',
    });
    expect(recorded.status).toBe(201);

    return { token, order, payment: recorded.body.data.payment };
  }

  it('corrects a mistyped reference, a note and the date the money moved', async () => {
    const { token, payment } = await paidOrder();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({
        reference: 'CHQ-00012',
        notes: 'Cheque number was written down wrong',
        paidAt: daysFromNow(-3),
      });

    expect(response.status).toBe(200);
    expect(response.body.data.payment.reference).toBe('CHQ-00012');
    expect(response.body.data.payment.notes).toBe('Cheque number was written down wrong');
    expect(new Date(response.body.data.payment.paidAt).getTime()).toBeLessThan(Date.now());
    // The money is untouched, which is the whole point.
    expect(response.body.data.payment.amountMinor).toBe(4_000);
    expect(response.body.data.payment.method).toBe('cheque');
  });

  it('refuses an attempt to change the amount rather than ignoring it', async () => {
    const { token, payment } = await paidOrder();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ amountMinor: 999_999 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toContain('cannot be changed');

    // Nothing moved, and the order still agrees with its entries.
    const unchanged = await request(app())
      .get(`${API}/payments`)
      .query({ payableType: 'order', payableId: payment.payableId })
      .set(...auth(token));
    expect(unchanged.body.data.items[0].amountMinor).toBe(4_000);
  });

  it('refuses an attempt to change the method', async () => {
    const { token, payment } = await paidOrder();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ method: 'cash' });

    expect(response.status).toBe(422);
  });

  it('clears a reference when an explicit null is sent', async () => {
    const { token, payment } = await paidOrder();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ reference: null, notes: null });

    expect(response.status).toBe(200);
    expect(response.body.data.payment.reference).toBeNull();
    expect(response.body.data.payment.notes).toBeNull();
  });

  it('leaves the order total exactly as it was', async () => {
    const { token, order, payment } = await paidOrder();
    const before = await readOrder(token, order.id);

    await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ notes: 'A correction' })
      .expect(200);

    const after = await readOrder(token, order.id);
    expect(after.paidMinor).toBe(before.paidMinor);
    expect(after.outstandingMinor).toBe(before.outstandingMinor);
    expect(after.paymentStatus).toBe(before.paymentStatus);
  });

  it('records the correction in the order activity, saying the amount did not change',
    async () => {
      const { token, order, payment } = await paidOrder();

      await request(app())
        .patch(`${API}/payments/${payment.id}`)
        .set(...auth(token))
        .send({ reference: 'CHQ-00099' })
        .expect(200);

      const activity = await request(app())
        .get(`${API}/orders/${order.id}/activity`)
        .set(...auth(token));

      const entry = activity.body.data.activity.find(
        (row: { action: string }) => row.action === 'payment.annotated',
      );
      expect(entry).toBeDefined();
      expect(entry.summary).toContain('The amount was not changed.');
      expect(entry.changes.some((change: { field: string }) => change.field === 'reference')).toBe(
        true,
      );
    });

  it('never corrects another merchant payment', async () => {
    const { payment } = await paidOrder();
    const other = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(other.accessToken))
      .send({ notes: 'Not mine' });

    expect(response.status).toBe(404);
  });
});
