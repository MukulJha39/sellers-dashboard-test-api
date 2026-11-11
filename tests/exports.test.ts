import ExcelJS from 'exceljs';
import request from 'supertest';
import { REPORTS, columnKey } from '../src/modules/exports/reports';
import {
  API,
  app,
  auth,
  createCustomer,
  createItem,
  createOrder,
  createService,
  payOrder,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Downloads an export and reads its first sheet back as header → value rows. */
async function download(path: string, token: string, query: Record<string, string> = {}) {
  const response = await request(app())
    .get(`${API}${path}`)
    .query(query)
    .set(...auth(token))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });

  if (response.status !== 200) return { response, rows: [], headers: [] as string[], workbook: null };

  const workbook = new ExcelJS.Workbook();
  const bytes = new Uint8Array(response.body as Buffer);
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const values = (row.values as unknown[]).slice(1);
    rows.push(Object.fromEntries(headers.map((header, column) => [header, values[column] ?? null])));
  });
  return { response, rows, headers, workbook };
}

/** A merchant with two products and a part-paid order for a named customer. */
async function merchantWithData(firstName = 'Anita') {
  const merchant = await registerMerchant({ firstName });
  const token = merchant.accessToken;
  await createItem(token, { name: 'Masala Chai', sellingPriceMinor: 4_500, openingQuantity: 10 });
  await createItem(token, { name: 'Green Tea', sellingPriceMinor: 12_050 });
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 5_000 });
  const customer = await createCustomer(token);
  const order = await createOrder(token, {
    customerId: customer.id,
    lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
    deliveryDate: '2026-11-20',
    deliveryTime: '18:30',
  });
  await payOrder(token, order.id, { amountMinor: 4_000 });
  return { merchant, token, order };
}

describe('admin Excel exports', () => {
  let adminToken: string;

  beforeEach(async () => {
    await seedRbac();
    adminToken = (await signInAdmin()).accessToken;
  });

  it('downloads products as a real .xlsx with prices in rupees and the merchant named', async () => {
    await merchantWithData('Anita');

    const { response, rows, headers } = await download('/admin/exports/items', adminToken, { sort: 'name' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain(XLSX);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="inperge-items-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(headers.slice(0, 3)).toEqual(['Merchant', 'Product', 'SKU']);
    expect(rows.map((row) => [row.Product, row['Selling price']])).toEqual([
      ['Green Tea', 120.5],
      ['Masala Chai', 45],
    ]);
    expect(rows[1]!.Merchant).toBe('Anita Desai');
    expect(rows[1]!.Available).toBe(10);
  });

  it('applies the same filters as the list', async () => {
    const first = await merchantWithData('Anita');
    await merchantWithData('Rahul');

    const all = await download('/admin/exports/orders', adminToken);
    const one = await download('/admin/exports/orders', adminToken, { merchantId: first.merchant.id });

    expect(all.rows).toHaveLength(2);
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({
      Order: first.order.reference,
      Total: 100,
      Paid: 40,
      Outstanding: 60,
      'Delivery time': '18:30',
    });
  });

  it('exports payments, instalments and receivables', async () => {
    await merchantWithData();

    const payments = await download('/admin/exports/payments', adminToken);
    const receivables = await download('/admin/exports/receivables', adminToken);
    const installments = await download('/admin/exports/installments', adminToken);

    expect(payments.rows[0]).toMatchObject({ Amount: 40, Direction: 'Received', Against: 'Order' });
    expect(receivables.rows[0]).toMatchObject({ Outstanding: 60 });
    expect(installments.response.status).toBe(200);
  });

  it('adds an About sheet describing the report', async () => {
    await merchantWithData();
    const { workbook } = await download('/admin/exports/items', adminToken, { search: 'tea' });

    const about = workbook!.getWorksheet('About')!;
    expect(about.getCell('B1').value).toBe('Products');
    expect(String(about.getCell('B4').value)).toContain('search: tea');
  });

  it('needs report.export as well as the view permission of the list', async () => {
    // Support and read-only admins can see these lists but not take them out of the panel.
    const support = (await signInAdmin('support@sellersdash.local', PASSWORD)).accessToken;
    const readOnly = (await signInAdmin('readonly@sellersdash.local', PASSWORD)).accessToken;
    // Finance holds report.export, but not the catalog views.
    const finance = (await signInAdmin('finance@sellersdash.local', PASSWORD)).accessToken;

    const supportList = await request(app()).get(`${API}/admin/payments`).set(...auth(support));
    const supportExport = await request(app()).get(`${API}/admin/exports/payments`).set(...auth(support));
    const readOnlyExport = await request(app()).get(`${API}/admin/exports/items`).set(...auth(readOnly));
    const financePayments = await download('/admin/exports/payments', finance);
    const financeItems = await request(app()).get(`${API}/admin/exports/items`).set(...auth(finance));
    const unauthenticated = await request(app()).get(`${API}/admin/exports/items`);

    expect(supportList.status).toBe(200);
    expect(supportExport.status).toBe(403);
    expect(readOnlyExport.status).toBe(403);
    expect(financePayments.response.status).toBe(200);
    expect(financeItems.status).toBe(403);
    expect(unauthenticated.status).toBe(401);
  });

  it('rejects bad filters with the list validation', async () => {
    const response = await request(app())
      .get(`${API}/admin/exports/orders`)
      .query({ merchantId: 'not-an-id' })
      .set(...auth(adminToken));

    expect(response.status).toBe(422);
  });
});

describe('merchant Excel exports, for the app', () => {
  it("exports only the merchant's own records, without a merchant column", async () => {
    const mine = await merchantWithData('Anita');
    await merchantWithData('Rahul');

    const { response, rows, headers } = await download('/exports/items', mine.token);

    expect(response.status).toBe(200);
    expect(headers).not.toContain('Merchant');
    expect(rows).toHaveLength(2);
  });

  it('exports orders and receivables by customer', async () => {
    const { token, order } = await merchantWithData();

    const orders = await download('/exports/orders', token);
    const receivables = await download('/exports/receivables', token);

    expect(orders.rows[0]).toMatchObject({ Order: order.reference, Outstanding: 60 });
    expect(receivables.rows[0]).toMatchObject({ Outstanding: 60 });
  });

  it('requires a signed-in merchant', async () => {
    const response = await request(app()).get(`${API}/exports/items`);
    expect(response.status).toBe(401);
  });
});

describe('choosing columns and masking amounts', () => {
  let adminToken: string;

  beforeEach(async () => {
    await seedRbac();
    adminToken = (await signInAdmin()).accessToken;
  });

  it('gives every column of every report a unique key', () => {
    for (const [report, spec] of Object.entries(REPORTS)) {
      for (const scope of ['admin', 'merchant'] as const) {
        const keys = spec.columns(scope).map(columnKey);
        expect({ report, scope, duplicates: keys.filter((key, index) => keys.indexOf(key) !== index) }).toEqual({
          report,
          scope,
          duplicates: [],
        });
      }
    }
  });

  it("lists a report's columns with their kinds", async () => {
    const response = await request(app()).get(`${API}/admin/exports/items/columns`).set(...auth(adminToken));

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Products');
    expect(response.body.data.columns.slice(0, 2)).toEqual([
      { key: 'merchant', header: 'Merchant', kind: 'text' },
      { key: 'product', header: 'Product', kind: 'text' },
    ]);
    expect(response.body.data.columns).toEqual(
      expect.arrayContaining([{ key: 'selling-price', header: 'Selling price', kind: 'money' }]),
    );
  });

  it('writes only the chosen columns, in the report order', async () => {
    await merchantWithData();

    const { headers, rows } = await download('/admin/exports/items', adminToken, {
      columns: 'selling-price,product',
      sort: 'name',
    });

    expect(headers).toEqual(['Product', 'Selling price']);
    expect(rows[0]).toEqual({ Product: 'Green Tea', 'Selling price': 120.5 });
  });

  it('masks every amount when asked, and says so in the About sheet', async () => {
    await merchantWithData();

    const { rows, workbook } = await download('/admin/exports/orders', adminToken, { maskAmounts: 'true' });

    expect(rows[0]).toMatchObject({ Total: '₹ XxXx', Paid: '₹ XxXx', Outstanding: '₹ XxXx', Lines: 1 });
    const about = workbook!.getWorksheet('About')!;
    let amounts: unknown;
    about.eachRow((row) => {
      if (row.getCell(1).value === 'Amounts') amounts = row.getCell(2).value;
    });
    expect(amounts).toBe('Hidden (shown as ₹ XxXx)');
  });

  it('refuses an unknown column rather than ignoring it', async () => {
    const response = await request(app())
      .get(`${API}/admin/exports/items`)
      .query({ columns: 'product,shoe-size' })
      .set(...auth(adminToken));

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].message).toContain('shoe-size');
  });

  it('works the same for the merchant app', async () => {
    const { token } = await merchantWithData();

    const columns = await request(app()).get(`${API}/exports/orders/columns`).set(...auth(token));
    const { headers, rows } = await download('/exports/orders', token, { columns: 'order,total', maskAmounts: 'true' });

    expect(columns.body.data.columns.map((column: { key: string }) => column.key)).not.toContain('merchant');
    expect(headers).toEqual(['Order', 'Total']);
    expect(rows[0]!.Total).toBe('₹ XxXx');
  });

  it('keeps the columns list behind report.export', async () => {
    const support = (await signInAdmin('support@sellersdash.local', PASSWORD)).accessToken;
    const response = await request(app()).get(`${API}/admin/exports/items/columns`).set(...auth(support));
    expect(response.status).toBe(403);
  });
});
