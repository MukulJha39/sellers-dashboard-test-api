import request from 'supertest';
import { DEFAULT_UNITS } from '../src/config/catalog';
import { MeasurementUnit } from '../src/models/MeasurementUnit';
import { upgradeUnitPresentation } from '../src/modules/catalog/unitService';
import {
  API,
  app,
  auth,
  createItem,
  createMaterial,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

interface UnitRow {
  id: string;
  code: string;
  name: string;
  symbol: string;
  icon: string | null;
  wholeNumbersOnly: boolean;
  appliesTo: string[];
  isActive: boolean;
  usage: { items: number; materials: number; orders: number; purchases: number };
}

describe('admin-managed units of measurement', () => {
  let superToken = '';

  beforeEach(async () => {
    await seedRbac();
    superToken = (await signInAdmin()).accessToken;
  });

  async function listUnits(): Promise<UnitRow[]> {
    const response = await request(app()).get(`${API}/admin/units`).set(...auth(superToken));
    expect(response.status).toBe(200);
    return response.body.data.units;
  }

  async function addUnit(body: Record<string, unknown>) {
    return request(app()).post(`${API}/admin/units`).set(...auth(superToken)).send(body);
  }

  it('starts with the default units', async () => {
    const units = await listUnits();
    expect(units.map((unit) => unit.code)).toEqual(DEFAULT_UNITS.map((unit) => unit.code));
    expect(units.find((unit) => unit.code === 'kilogram')).toMatchObject({ symbol: 'kg', wholeNumbersOnly: false });
  });

  it('adds a unit that merchants can then choose, and serves it in the catalog meta', async () => {
    const created = await addUnit({ code: 'Square_Metre', name: 'Square metre', symbol: 'm²', appliesTo: ['material'] });
    expect(created.status).toBe(201);
    expect(created.body.data.unit).toMatchObject({ code: 'square_metre', appliesTo: ['material'], isActive: true });

    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken, { unit: 'square_metre', openingQuantity: 2.5 });
    expect(material.unit).toBe('square_metre');

    // Limited to raw materials, so an item cannot use it.
    const item = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Tile', unit: 'square_metre' });
    expect(item.status).toBe(422);

    const meta = await request(app()).get(`${API}/catalog/meta`).set(...auth(merchant.accessToken));
    expect(meta.body.data.units).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'square_metre', name: 'Square metre', symbol: 'm²' })]),
    );
  });

  it('refuses a duplicate code and a badly formed one', async () => {
    expect((await addUnit({ code: 'piece', name: 'Piece again', symbol: 'pc' })).status).toBe(422);
    expect((await addUnit({ code: '9 bad code', name: 'Bad', symbol: 'b' })).status).toBe(422);
  });

  it('enforces whole numbers for a counted unit the admin creates', async () => {
    await addUnit({ code: 'crate', name: 'Crate', symbol: 'crt', wholeNumbersOnly: true });
    const merchant = await registerMerchant();
    const response = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Mangoes', unit: 'crate', openingQuantity: 1.5 });
    expect(response.status).toBe(422);
  });

  it('renames a unit without touching the records that use it', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { unit: 'piece' });
    const piece = (await listUnits()).find((unit) => unit.code === 'piece') as UnitRow;
    expect(piece.usage.items).toBe(1);

    const renamed = await request(app())
      .patch(`${API}/admin/units/${piece.id}`)
      .set(...auth(superToken))
      .send({ name: 'Nos', symbol: 'nos' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.unit).toMatchObject({ code: 'piece', name: 'Nos', symbol: 'nos' });

    const refused = await request(app())
      .patch(`${API}/admin/units/${piece.id}`)
      .set(...auth(superToken))
      .send({ code: 'nos' });
    expect(refused.status).toBe(422);

    const reread = await request(app()).get(`${API}/items/${item.id}`).set(...auth(merchant.accessToken));
    expect(reread.body.data.item.unit).toBe('piece');
  });

  it('hides a deactivated unit from new choices but lets existing records keep it', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken, { unit: 'dozen' });
    const dozen = (await listUnits()).find((unit) => unit.code === 'dozen') as UnitRow;

    await request(app()).patch(`${API}/admin/units/${dozen.id}`).set(...auth(superToken)).send({ isActive: false });

    const fresh = await request(app())
      .post(`${API}/items`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Eggs', unit: 'dozen' });
    expect(fresh.status).toBe(422);

    const kept = await request(app())
      .patch(`${API}/items/${item.id}`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Renamed', unit: 'dozen' });
    expect(kept.status).toBe(200);
  });

  it('refuses to make a unit whole-numbers-only while a record holds a fraction of it', async () => {
    const merchant = await registerMerchant();
    await createMaterial(merchant.accessToken, { unit: 'kilogram', openingQuantity: 2.5 });
    const kilogram = (await listUnits()).find((unit) => unit.code === 'kilogram') as UnitRow;

    const response = await request(app())
      .patch(`${API}/admin/units/${kilogram.id}`)
      .set(...auth(superToken))
      .send({ wholeNumbersOnly: true });
    expect(response.status).toBe(422);
  });

  it('deletes only a unit nothing uses', async () => {
    const merchant = await registerMerchant();
    await createItem(merchant.accessToken, { unit: 'box' });
    const units = await listUnits();
    const box = units.find((unit) => unit.code === 'box') as UnitRow;
    const roll = units.find((unit) => unit.code === 'roll') as UnitRow;

    const inUse = await request(app()).delete(`${API}/admin/units/${box.id}`).set(...auth(superToken));
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('RECORD_IN_USE');

    const unused = await request(app()).delete(`${API}/admin/units/${roll.id}`).set(...auth(superToken));
    expect(unused.status).toBe(200);
    expect(await MeasurementUnit.exists({ code: 'roll' })).toBeNull();
  });

  it('never leaves items or materials without an active unit', async () => {
    await listUnits();
    const keep = await MeasurementUnit.findOne({ code: 'piece' });
    await MeasurementUnit.updateMany({ code: { $ne: 'piece' } }, { isActive: false });

    const response = await request(app())
      .patch(`${API}/admin/units/${String(keep?._id)}`)
      .set(...auth(superToken))
      .send({ isActive: false });
    expect(response.status).toBe(409);
  });

  it('keeps unit changes to admins holding unit.manage', async () => {
    const readonlyToken = (await signInAdmin('readonly@sellersdash.local')).accessToken;
    const response = await request(app())
      .post(`${API}/admin/units`)
      .set(...auth(readonlyToken))
      .send({ code: 'tray', name: 'Tray', symbol: 'tray' });
    expect(response.status).toBe(403);

    const read = await request(app()).get(`${API}/admin/units`).set(...auth(readonlyToken));
    expect(read.status).toBe(200);
  });
  it('stores a Material icon and group, serves them in the catalog meta, and clears the icon', async () => {
    const created = await addUnit({ code: 'tray', name: 'Tray', symbol: 'trays', icon: 'egg', group: 'count' });
    expect(created.status).toBe(201);
    expect(created.body.data.unit).toMatchObject({ icon: 'egg', group: 'count' });

    const merchant = await registerMerchant();
    const meta = await request(app()).get(`${API}/catalog/meta`).set(...auth(merchant.accessToken));
    expect(meta.body.data.units).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'tray', icon: 'egg', group: 'count' })]),
    );
    expect(meta.body.data.unitGroups.map((group: { value: string }) => group.value)).toEqual([
      'weight',
      'volume',
      'count',
      'length',
      'other',
    ]);

    const cleared = await request(app())
      .patch(`${API}/admin/units/${created.body.data.unit.id}`)
      .set(...auth(superToken))
      .send({ icon: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.unit.icon).toBeNull();
  });

  it('gives the default units the icons and groups the app shows', async () => {
    const units = await listUnits();
    const byCode = (code: string) => units.find((unit) => unit.code === code) as UnitRow & { group: string };
    expect(byCode('kilogram')).toMatchObject({ icon: 'scale', group: 'weight' });
    expect(byCode('litre')).toMatchObject({ icon: 'water_drop', group: 'volume' });
    expect(byCode('box')).toMatchObject({ icon: 'all_inbox', group: 'count' });
    expect(byCode('square_foot')).toMatchObject({ icon: 'square_foot', group: 'length' });
  });

  it('refuses an icon that is not a Material icon name, and an unknown group', async () => {
    expect((await addUnit({ code: 'crate', name: 'Crate', symbol: 'crates', icon: '📦' })).status).toBe(422);
    expect((await addUnit({ code: 'crate', name: 'Crate', symbol: 'crates', group: 'mass' })).status).toBe(422);
  });

  it('upgrades older units without overriding what an admin chose', async () => {
    await listUnits();
    // Written before icons and groups existed, still carrying the old emoji, cleared by
    // an admin, and a custom unit holding an emoji.
    await MeasurementUnit.collection.updateOne({ code: 'litre' }, { $unset: { icon: '', group: '' } });
    await MeasurementUnit.collection.updateOne({ code: 'box' }, { $set: { icon: '🗃️' } });
    await MeasurementUnit.collection.updateOne({ code: 'metre' }, { $set: { icon: null } });
    await MeasurementUnit.collection.updateOne({ code: 'gram' }, { $set: { icon: 'monitor_weight' } });
    await MeasurementUnit.collection.insertOne({
      code: 'crate', name: 'Crate', symbol: 'crates', icon: '🧺', wholeNumbersOnly: true,
      appliesTo: ['item'], isActive: true, sortOrder: 999,
    });

    await upgradeUnitPresentation();

    const read = async (code: string) => MeasurementUnit.collection.findOne({ code });
    expect(await read('litre')).toMatchObject({ icon: 'water_drop', group: 'volume' });
    expect((await read('box'))?.icon).toBe('all_inbox');
    expect((await read('metre'))?.icon).toBeNull();
    expect((await read('gram'))?.icon).toBe('monitor_weight');
    expect(await read('crate')).toMatchObject({ icon: null, group: 'other' });
  });
});
