import request from 'supertest';
import { resolvePeriod } from '../src/modules/reports/reportPeriod';
import {
  API,
  app,
  auth,
  createCustomer,
  createItem,
  createMaterial,
  createOrder,
  createPurchase,
  createService,
  createSupplier,
  payOrder,
  payPurchase,
  registerMerchant,
  transitionOrder,
} from './helpers';

function report(token: string, path: string, query: Record<string, unknown> = {}) {
  return request(app())
    .get(`${API}/reports/${path}`)
    .query(query)
    .set(...auth(token));
}

async function complete(token: string, orderId: string) {
  const response = await transitionOrder(token, orderId, 'completed');
  expect(response.status).toBe(200);
}

/**
 * A small shop: a product with a cost price (₹20 cost, ₹50 price), a product with no
 * cost price, a service, and one customer.
 */
async function shop() {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;
  const tea = await createItem(token, {
    name: 'Tea',
    sellingPriceMinor: 5_000,
    costPriceMinor: 2_000,
    openingQuantity: 100,
  });
  const biscuit = await createItem(token, {
    name: 'Biscuit',
    sellingPriceMinor: 1_000,
    openingQuantity: 50,
  });
  const idle = await createItem(token, {
    name: 'Idle Jar',
    sellingPriceMinor: 9_000,
    costPriceMinor: 4_000,
    openingQuantity: 5,
  });
  const delivery = await createService(token, { name: 'Delivery', rateMinor: 3_000 });
  const customer = await createCustomer(token);
  return { token, tea, biscuit, idle, delivery, customer };
}

describe('period resolution', () => {
  // 2026-11-11 02:00 in Kolkata is still 2026-11-10 in UTC.
  const now = new Date('2026-11-10T20:30:00.000Z');

  it('starts the day at midnight in the merchant zone', () => {
    const today = resolvePeriod({ period: 'today', tz: 'Asia/Kolkata', now });
    expect(today.from).toBe('2026-11-11');
    expect(today.start.toISOString()).toBe('2026-11-10T18:30:00.000Z');
    expect(today.end.toISOString()).toBe('2026-11-11T18:30:00.000Z');
    expect(today.previous.from).toBe('2026-11-10');
  });

  it('covers the whole of last month and compares it with the month before', () => {
    const last = resolvePeriod({ period: 'last_month', tz: 'Asia/Kolkata', now });
    expect([last.from, last.to, last.days]).toEqual(['2026-10-01', '2026-10-31', 31]);
    expect([last.previous.from, last.previous.to]).toEqual(['2026-09-01', '2026-09-30']);
    expect(last.bucket).toBe('day');
  });

  it('charts long ranges by month', () => {
    const range = resolvePeriod({ from: '2026-01-01', to: '2026-06-30', now });
    expect(range.period).toBe('custom');
    expect(range.bucket).toBe('month');
  });
});

describe('GET /reports/sales', () => {
  it('counts committed orders only, with comparison and a daily series', async () => {
    const { token, tea, delivery, customer } = await shop();
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: tea.id, quantity: 2 }],
    });
    await createOrder(token, { lines: [{ lineType: 'service', subjectId: delivery.id, quantity: 1 }] });
    // Neither of these is a sale.
    await createOrder(token, { status: 'draft', lines: [{ lineType: 'item', subjectId: tea.id, quantity: 9 }] });
    const cancelled = await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 3 }] });
    expect((await transitionOrder(token, cancelled.id, 'cancelled', 'Changed mind')).status).toBe(200);

    const response = await report(token, 'sales', { period: 'today' });
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.period.period).toBe('today');
    expect(data.summary).toMatchObject({
      totalMinor: 13_000,
      orderCount: 2,
      averageOrderMinor: 6_500,
      customerCount: 1,
      walkInOrders: 1,
      outstandingMinor: 13_000,
    });
    expect(data.series).toHaveLength(1);
    expect(data.series[0].totalMinor).toBe(13_000);
    expect(data.comparison.totalMinor).toBe(0);
  });

  it('refuses a custom range that ends before it starts', async () => {
    const { token } = await shop();
    const response = await report(token, 'sales', { from: '2026-05-10', to: '2026-05-01' });
    expect(response.status).toBe(422);
  });

  it('needs a signed-in merchant', async () => {
    expect((await request(app()).get(`${API}/reports/sales`)).status).toBe(401);
  });
});

describe('GET /reports/profit-loss', () => {
  it('uses completed orders only and flags products with no cost price', async () => {
    const { token, tea, biscuit, delivery } = await shop();
    const done = await createOrder(token, {
      lines: [
        { lineType: 'item', subjectId: tea.id, quantity: 2 },
        { lineType: 'item', subjectId: biscuit.id, quantity: 1 },
        { lineType: 'service', subjectId: delivery.id, quantity: 1 },
      ],
    });
    await complete(token, done.id);
    // Confirmed but not completed: not in profit yet.
    await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 10 }] });

    const response = await report(token, 'profit-loss', { period: 'today' });
    expect(response.status).toBe(200);
    expect(response.body.data.summary).toMatchObject({
      orderCount: 1,
      revenueMinor: 14_000,
      itemSalesMinor: 11_000,
      serviceSalesMinor: 3_000,
      costMinor: 4_000,
      profitMinor: 10_000,
      isLoss: false,
    });
    expect(response.body.data.missingCost).toMatchObject({ lineCount: 1, productCount: 1 });
    expect(response.body.data.missingCost.productIds).toEqual([biscuit.id]);
  });
});

describe('GET /reports/money-in-out', () => {
  it('sets payments received against payments made for purchases', async () => {
    const { token, tea } = await shop();
    const order = await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 2 }] });
    expect((await payOrder(token, order.id, { amountMinor: 6_000, method: 'upi' })).status).toBe(201);

    const supplier = await createSupplier(token);
    const sugar = await createMaterial(token);
    const purchase = await createPurchase(token, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: sugar.id, quantity: 3, unitCostMinor: 1_000 },
        { subjectType: 'item', subjectId: tea.id, quantity: 1, unitCostMinor: 1_000 },
      ],
    });
    expect((await payPurchase(token, purchase.id, { amountMinor: 4_000 })).status).toBe(201);

    const response = await report(token, 'money-in-out', { period: 'today' });
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.summary).toMatchObject({ inMinor: 6_000, outMinor: 4_000, netMinor: 2_000, isNegative: false });
    expect(data.in.byMethod).toEqual([{ method: 'upi', totalMinor: 6_000, count: 1 }]);
    // Three quarters of that purchase was raw material.
    expect(data.out).toMatchObject({ rawMaterialsMinor: 3_000, goodsMinor: 1_000 });
  });
});

describe('GET /reports/money-to-collect', () => {
  it('lists completed orders that are not fully paid, by customer or by order', async () => {
    const { token, tea, customer } = await shop();
    const owing = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'item', subjectId: tea.id, quantity: 2 }],
    });
    await complete(token, owing.id);
    expect((await payOrder(token, owing.id, { amountMinor: 3_000 })).status).toBe(201);

    const paid = await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 1 }] });
    expect((await payOrder(token, paid.id, { amountMinor: 5_000 })).status).toBe(201);
    await complete(token, paid.id);
    // Still open: not money to collect yet.
    await createOrder(token, { customerId: customer.id, lines: [{ lineType: 'item', subjectId: tea.id, quantity: 4 }] });

    const byCustomer = await report(token, 'money-to-collect');
    expect(byCustomer.status).toBe(200);
    expect(byCustomer.body.data.summary).toMatchObject({ outstandingMinor: 7_000, orderCount: 1, customerCount: 1 });
    expect(byCustomer.body.data.items).toHaveLength(1);
    expect(byCustomer.body.data.items[0]).toMatchObject({
      customerId: customer.id,
      outstandingMinor: 7_000,
      orderCount: 1,
      pendingDays: 0,
    });
    expect(byCustomer.body.data.meta.total).toBe(1);

    const byOrder = await report(token, 'money-to-collect', { customerId: customer.id });
    expect(byOrder.body.data.view).toBe('order');
    expect(byOrder.body.data.items[0]).toMatchObject({ orderId: owing.id, paidMinor: 3_000, outstandingMinor: 7_000 });
  });
});

describe('GET /reports/stock', () => {
  it('counts the goods on hand and what they are worth', async () => {
    const { token, tea } = await shop();
    await createItem(token, { name: 'Empty Shelf', openingQuantity: 0, costPriceMinor: 100 });

    const response = await report(token, 'stock');
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.summary).toMatchObject({ productCount: 4, outOfStock: 1, withoutCostPrice: 1 });
    // 100 tea at ₹20 and 5 jars at ₹40; biscuits have no cost price.
    expect(data.summary.stockValueMinor).toBe(220_000);
    // Out of stock comes first, so it can be restocked from here.
    expect(data.items[0]).toMatchObject({ name: 'Empty Shelf', status: 'out', subjectType: 'item' });

    const filtered = await report(token, 'stock', { status: 'in_stock', sort: '-quantity' });
    expect(filtered.body.data.items[0]).toMatchObject({ id: tea.id, quantity: 100 });
  });
});

describe('best sellers, by product and not selling', () => {
  it('ranks products by what sold, and puts what did not sell first', async () => {
    const { token, tea, biscuit, idle, delivery } = await shop();
    await createOrder(token, {
      lines: [
        { lineType: 'item', subjectId: tea.id, quantity: 2 },
        { lineType: 'item', subjectId: biscuit.id, quantity: 7 },
        { lineType: 'service', subjectId: delivery.id, quantity: 1 },
      ],
    });
    await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 1 }] });

    const best = await report(token, 'best-sellers', { period: 'today' });
    expect(best.status).toBe(200);
    expect(best.body.data.items.map((row: { name: string }) => row.name)).toEqual(['Biscuit', 'Tea']);
    expect(best.body.data.items[1]).toMatchObject({ quantity: 3, orderCount: 2, revenueMinor: 15_000, rank: 2 });

    const byProduct = await report(token, 'sales-by-product', { period: 'today' });
    expect(byProduct.body.data.items.map((row: { name: string }) => row.name)).toEqual(['Tea', 'Biscuit', 'Delivery']);
    expect(byProduct.body.data.summary.revenueMinor).toBe(25_000);
    expect(byProduct.body.data.items[0].revenueSharePercent).toBe(60);

    const supplier = await createSupplier(token);
    await createPurchase(token, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: idle.id, quantity: 1, unitCostMinor: 4_000 }],
    });

    const idleReport = await report(token, 'not-selling');
    expect(idleReport.status).toBe(200);
    expect(idleReport.body.data.period.period).toBe('last_30_days');
    const first = idleReport.body.data.items[0];
    expect(first).toMatchObject({ id: idle.id, soldQuantity: 0, neverSold: true, lastSoldAt: null });
    expect(first.lastPurchasedAt).not.toBeNull();
    expect(idleReport.body.data.summary).toMatchObject({ unsoldCount: 1, idleStockValueMinor: 24_000 });

    const unsoldOnly = await report(token, 'not-selling', { unsold: true });
    expect(unsoldOnly.body.data.items).toHaveLength(1);
  });
});

describe('GET /reports/sales-by-customer', () => {
  it('ranks customers by what they spent', async () => {
    const { token, tea, customer } = await shop();
    const other = await createCustomer(token, { firstName: 'Ravi' });
    await createOrder(token, { customerId: customer.id, lines: [{ lineType: 'item', subjectId: tea.id, quantity: 1 }] });
    await createOrder(token, { customerId: other.id, lines: [{ lineType: 'item', subjectId: tea.id, quantity: 3 }] });
    await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 9 }] });

    const response = await report(token, 'sales-by-customer', { period: 'today' });
    expect(response.status).toBe(200);
    // Walk-in sales are left out unless asked for.
    expect(response.body.data.items.map((row: { customerId: string }) => row.customerId)).toEqual([other.id, customer.id]);
    expect(response.body.data.items[0]).toMatchObject({ totalMinor: 15_000, orderCount: 1, sharePercent: 75 });

    const withWalkIn = await report(token, 'sales-by-customer', { period: 'today', walkIn: true });
    expect(withWalkIn.body.data.items[0]).toMatchObject({ customerId: null, customerName: 'Walk-in sale' });
  });
});

describe('merchant isolation', () => {
  it("never shows another merchant's figures", async () => {
    const { token, tea } = await shop();
    await createOrder(token, { lines: [{ lineType: 'item', subjectId: tea.id, quantity: 2 }] });

    const stranger = await registerMerchant();
    const sales = await report(stranger.accessToken, 'sales', { period: 'today' });
    expect(sales.body.data.summary.totalMinor).toBe(0);
    const stock = await report(stranger.accessToken, 'stock');
    expect(stock.body.data.summary.productCount).toBe(0);
  });
});
