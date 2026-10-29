import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import {
  API,
  app,
  auth,
  createOrder,
  createService,
  readOrder,
  registerMerchant,
  seedRbac,
  signInAdmin,
  transitionOrder,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';

async function fixture() {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 5_000 });
  const lines = [{ lineType: 'service' as const, subjectId: service.id, quantity: 1 }];
  return { token, lines };
}

describe('order delivery details', () => {
  it('starts empty, as three separate fields', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines });

    expect(order).toMatchObject({ deliveryDate: null, deliveryTime: null, deliveryLocation: null });
  });

  it('records the delivery date, time and location on create', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, {
      lines,
      deliveryDate: '2026-11-05',
      deliveryTime: '14:30',
      deliveryLocation: '  12 MG Road, Indiranagar, Bengaluru 560038  ',
    });

    expect(order.deliveryDate).toBe('2026-11-05');
    expect(order.deliveryTime).toBe('14:30');
    expect(order.deliveryLocation).toBe('12 MG Road, Indiranagar, Bengaluru 560038');
  });

  it('keeps only the calendar day of a full timestamp, whatever its time zone', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines, deliveryDate: '2026-11-05T23:30:00+05:30' });

    expect(order.deliveryDate).toBe('2026-11-05');
  });

  it('changes and clears each field on its own, even after the order is completed', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, {
      lines,
      deliveryDate: '2026-11-05',
      deliveryTime: '09:00',
      deliveryLocation: 'Shop counter',
    });
    await transitionOrder(token, order.id, 'completed');

    const moved = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ deliveryTime: '18:45' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.order).toMatchObject({
      deliveryDate: '2026-11-05',
      deliveryTime: '18:45',
      deliveryLocation: 'Shop counter',
    });

    const cleared = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ deliveryLocation: null, deliveryDate: null });
    expect(cleared.body.data.order).toMatchObject({
      deliveryDate: null,
      deliveryTime: '18:45',
      deliveryLocation: null,
    });
  });

  it('refuses a malformed date, a 12-hour time and an overlong location', async () => {
    const { token, lines } = await fixture();

    for (const bad of [
      { deliveryDate: '05/11/2026' },
      { deliveryDate: '2026-13-45' },
      { deliveryTime: '2:30 PM' },
      { deliveryTime: '24:00' },
      { deliveryLocation: 'x'.repeat(501) },
    ]) {
      const response = await request(app())
        .post(`${API}/orders`)
        .set(...auth(token))
        .send({ lines, ...bad });
      expect(response.status).toBe(422);
    }
  });

  it('audits a delivery change with the old and new values', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines, deliveryTime: '10:00' });

    await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ deliveryTime: '11:30' })
      .expect(200);

    const audit = await AuditLog.findOne({ action: 'order.updated' });
    expect(audit?.summary).toBe(`Updated the delivery details of order ${order.reference}.`);
    expect(audit?.changes).toEqual([expect.objectContaining({ field: 'deliveryTime', from: '10:00', to: '11:30' })]);
  });

  it('sorts by delivery date', async () => {
    const { token, lines } = await fixture();
    await createOrder(token, { lines, deliveryDate: '2026-12-01' });
    await createOrder(token, { lines, deliveryDate: '2026-11-01' });

    const response = await request(app()).get(`${API}/orders`).query({ sort: 'deliveryDate' }).set(...auth(token));
    expect(response.body.data.items.map((order: { deliveryDate: string }) => order.deliveryDate)).toEqual([
      '2026-11-01',
      '2026-12-01',
    ]);
  });
});

describe('admin order delivery details', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('lets support change the delivery details, audited as admin', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines });
    const admin = await signInAdmin();

    const response = await request(app())
      .patch(`${API}/admin/orders/${order.id}/delivery`)
      .set(...auth(admin.accessToken))
      .send({ deliveryDate: '2026-11-20', deliveryTime: '16:00', deliveryLocation: 'Warehouse gate 2' });

    expect(response.status).toBe(200);
    expect(response.body.data.order).toMatchObject({
      deliveryDate: '2026-11-20',
      deliveryTime: '16:00',
      deliveryLocation: 'Warehouse gate 2',
    });
    expect(await readOrder(token, order.id)).toMatchObject({ deliveryLocation: 'Warehouse gate 2' });

    const audit = await AuditLog.findOne({ action: 'order.updated' });
    expect(audit?.actorType).toBe('admin');
  });

  it('ignores anything but the delivery fields, and needs at least one of them', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines, notes: 'Keep me' });
    const admin = await signInAdmin();

    const sneaky = await request(app())
      .patch(`${API}/admin/orders/${order.id}/delivery`)
      .set(...auth(admin.accessToken))
      .send({ deliveryTime: '08:15', notes: 'Changed', discountMinor: 100 });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body.data.order).toMatchObject({ deliveryTime: '08:15', notes: 'Keep me', totalMinor: 5_000 });

    const empty = await request(app())
      .patch(`${API}/admin/orders/${order.id}/delivery`)
      .set(...auth(admin.accessToken))
      .send({});
    expect(empty.status).toBe(422);
  });

  it('requires the order.edit permission', async () => {
    const { token, lines } = await fixture();
    const order = await createOrder(token, { lines });
    const readOnly = await signInAdmin('readonly@sellersdash.local', PASSWORD);

    const response = await request(app())
      .patch(`${API}/admin/orders/${order.id}/delivery`)
      .set(...auth(readOnly.accessToken))
      .send({ deliveryTime: '10:00' });

    expect(response.status).toBe(403);
  });
});
