import request from 'supertest';
import { CATALOG_MAX_IMAGES } from '../src/config/catalog';
import { env } from '../src/config/env';
import { Item } from '../src/models/Item';
import { cloudinaryThumbnail, signParams } from '../src/services/cloudinaryService';
import {
  API,
  app,
  auth,
  createItem,
  createMaterial,
  pngFixture,
  registerMerchant,
  seedRbac,
  signInAdmin,
  type ItemView,
  type MaterialView,
} from './helpers';

function jpegFixture(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);
}

async function upload(token: string, path: string, count: number) {
  let call = request(app()).post(`${API}${path}`).set(...auth(token));
  for (let index = 0; index < count; index += 1) {
    call = call.attach('images', index % 2 ? jpegFixture() : pngFixture(), {
      filename: `photo-${index}.${index % 2 ? 'jpg' : 'png'}`,
      contentType: index % 2 ? 'image/jpeg' : 'image/png',
    });
  }
  return call;
}

describe('product image gallery', () => {
  it('adds several images at once, in order, with the first as the cover', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    expect(item.images).toEqual([]);

    const response = await upload(merchant.accessToken, `/items/${item.id}/images`, 3);

    expect(response.status).toBe(201);
    const updated: ItemView = response.body.data.item;
    expect(updated.images).toHaveLength(3);
    expect(updated.images[0]?.isCover).toBe(true);
    expect(updated.images.slice(1).every((image) => !image.isCover)).toBe(true);
    expect(updated.imageUrl).toBe(updated.images[0]?.url);
    expect(updated.images[0]?.url).toMatch(/\/uploads\/items\//);
    // Without Cloudinary the thumbnail is the original.
    expect(updated.images[0]?.thumbnailUrl).toBe(updated.images[0]?.url);
  });

  it('appends to an existing gallery and returns images on reads', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    await upload(merchant.accessToken, `/items/${item.id}/images`, 1);
    await upload(merchant.accessToken, `/items/${item.id}/images`, 2);

    const read = await request(app()).get(`${API}/items/${item.id}`).set(...auth(merchant.accessToken));
    expect(read.status).toBe(200);
    expect(read.body.data.item.images).toHaveLength(3);
  });

  it(`refuses to go past ${CATALOG_MAX_IMAGES} images and says how many fit`, async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    await upload(merchant.accessToken, `/items/${item.id}/images`, CATALOG_MAX_IMAGES - 1);

    const response = await upload(merchant.accessToken, `/items/${item.id}/images`, 2);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IMAGE_LIMIT_REACHED');
    expect(response.body.error.message).toMatch(/add 1 more/);
    const stored = await Item.findById(item.id);
    expect(stored?.images).toHaveLength(CATALOG_MAX_IMAGES - 1);
  });

  it('rejects the whole batch when one file is not an image', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const response = await request(app())
      .post(`${API}/items/${item.id}/images`)
      .set(...auth(merchant.accessToken))
      .attach('images', pngFixture(), { filename: 'ok.png', contentType: 'image/png' })
      .attach('images', Buffer.from('MZ not an image at all'), { filename: 'bad.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UPLOAD_REJECTED');
    expect((await Item.findById(item.id))?.images).toHaveLength(0);
  });

  it('requires at least one file', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const response = await request(app())
      .post(`${API}/items/${item.id}/images`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UPLOAD_REJECTED');
  });

  it('removes an image and promotes the next one to cover', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 2)).body.data.item;
    const [cover, second] = added.images;

    const response = await request(app())
      .delete(`${API}/items/${item.id}/images/${cover?.id}`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const updated: ItemView = response.body.data.item;
    expect(updated.images.map((image) => image.id)).toEqual([second?.id]);
    expect(updated.imageUrl).toBe(second?.url);

    const last = await request(app())
      .delete(`${API}/items/${item.id}/images/${second?.id}`)
      .set(...auth(merchant.accessToken));
    expect(last.body.data.item.images).toEqual([]);
    expect(last.body.data.item.imageUrl).toBeNull();
  });

  it('reorders the gallery, which changes the cover', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 3)).body.data.item;
    const reversed = added.images.map((image) => image.id).reverse();

    const response = await request(app())
      .put(`${API}/items/${item.id}/images/order`)
      .set(...auth(merchant.accessToken))
      .send({ imageIds: reversed });

    expect(response.status).toBe(200);
    const updated: ItemView = response.body.data.item;
    expect(updated.images.map((image) => image.id)).toEqual(reversed);
    expect(updated.imageUrl).toBe(updated.images[0]?.url);
  });

  it('refuses an order that leaves out or repeats an image', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 2)).body.data.item;
    const [first] = added.images;

    for (const imageIds of [[first?.id], [first?.id, first?.id]]) {
      const response = await request(app())
        .put(`${API}/items/${item.id}/images/order`)
        .set(...auth(merchant.accessToken))
        .send({ imageIds });
      expect(response.status).toBe(422);
    }
  });

  it("never touches another merchant's images", async () => {
    const owner = await registerMerchant();
    const stranger = await registerMerchant();
    const item = await createItem(owner.accessToken);
    const added: ItemView = (await upload(owner.accessToken, `/items/${item.id}/images`, 1)).body.data.item;

    const post = await upload(stranger.accessToken, `/items/${item.id}/images`, 1);
    const remove = await request(app())
      .delete(`${API}/items/${item.id}/images/${added.images[0]?.id}`)
      .set(...auth(stranger.accessToken));

    expect(post.status).toBe(404);
    expect(remove.status).toBe(404);
    expect((await Item.findById(item.id))?.images).toHaveLength(1);
  });

  it('keeps the single-image endpoint working as "replace the cover"', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 2)).body.data.item;

    const replaced = await request(app())
      .put(`${API}/items/${item.id}/image`)
      .set(...auth(merchant.accessToken))
      .attach('image', jpegFixture(), { filename: 'new.jpg', contentType: 'image/jpeg' });

    expect(replaced.status).toBe(200);
    const updated: ItemView = replaced.body.data.item;
    expect(updated.images).toHaveLength(2);
    expect(updated.images[0]?.id).not.toBe(added.images[0]?.id);
    expect(updated.images[1]?.id).toBe(added.images[1]?.id);
    expect(updated.imageUrl).toBe(updated.images[0]?.url);

    const cleared = await request(app())
      .delete(`${API}/items/${item.id}/image`)
      .set(...auth(merchant.accessToken));
    expect(cleared.body.data.item.images.map((image: { id: string }) => image.id)).toEqual([added.images[1]?.id]);
  });

  it('adopts a cover set before galleries existed', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    await Item.collection.updateOne(
      { _id: (await Item.findById(item.id))?._id },
      { $set: { imageUrl: 'http://127.0.0.1:4000/uploads/items/old.png' }, $unset: { images: '' } },
    );

    const read: ItemView = (
      await request(app()).get(`${API}/items/${item.id}`).set(...auth(merchant.accessToken))
    ).body.data.item;
    expect(read.images).toEqual([expect.objectContaining({ id: 'cover', isCover: true })]);

    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 1)).body.data.item;
    expect(added.images).toHaveLength(2);
    expect(added.images[0]?.url).toBe('http://127.0.0.1:4000/uploads/items/old.png');
    expect(added.images[0]?.id).not.toBe('cover');
  });

  it('removes a legacy cover by the "cover" id', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    await Item.updateOne({ _id: item.id }, { $set: { imageUrl: 'http://127.0.0.1:4000/uploads/items/old.png' } });

    const response = await request(app())
      .delete(`${API}/items/${item.id}/images/cover`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.item.imageUrl).toBeNull();
    expect(response.body.data.item.images).toEqual([]);
  });
});

describe('raw material image gallery', () => {
  it('supports the same upload, reorder and delete flow', async () => {
    const merchant = await registerMerchant();
    const material = await createMaterial(merchant.accessToken);

    const added = await upload(merchant.accessToken, `/materials/${material.id}/images`, 2);
    expect(added.status).toBe(201);
    const withImages: MaterialView = added.body.data.material;
    expect(withImages.images).toHaveLength(2);
    expect(withImages.images[0]?.url).toMatch(/\/uploads\/materials\//);

    const reversed = withImages.images.map((image) => image.id).reverse();
    const reordered = await request(app())
      .put(`${API}/materials/${material.id}/images/order`)
      .set(...auth(merchant.accessToken))
      .send({ imageIds: reversed });
    expect(reordered.body.data.material.images.map((image: { id: string }) => image.id)).toEqual(reversed);

    const removed = await request(app())
      .delete(`${API}/materials/${material.id}/images/${reversed[0]}`)
      .set(...auth(merchant.accessToken));
    expect(removed.body.data.material.images).toHaveLength(1);
  });
});

describe('admin catalog lists', () => {
  it('include every image a merchant added', async () => {
    await seedRbac();
    const admin = await signInAdmin();
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken);
    await upload(merchant.accessToken, `/items/${item.id}/images`, 2);
    await upload(merchant.accessToken, `/materials/${material.id}/images`, 1);

    const items = await request(app()).get(`${API}/admin/items`).set(...auth(admin.accessToken));
    const materials = await request(app()).get(`${API}/admin/materials`).set(...auth(admin.accessToken));

    expect(items.body.data.items[0].images).toHaveLength(2);
    expect(materials.body.data.items[0].images).toHaveLength(1);
  });
});

describe('Cloudinary storage', () => {
  const original = { ...env.cloudinary };
  const config = env.cloudinary as { -readonly [K in keyof typeof env.cloudinary]: (typeof env.cloudinary)[K] };
  let fetchMock: jest.SpyInstance;
  let uploaded = 0;

  beforeEach(() => {
    Object.assign(config, { enabled: true, cloudName: 'demo-cloud', apiKey: 'key-123', apiSecret: 'secret-xyz' });
    uploaded = 0;
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/image/upload')) {
        uploaded += 1;
        return new Response(
          JSON.stringify({
            secure_url: `https://res.cloudinary.com/demo-cloud/image/upload/v1/inperge/items/p${uploaded}.png`,
            public_id: `inperge/items/p${uploaded}`,
            width: 800,
            height: 600,
            bytes: 4096,
            format: 'png',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/image/destroy')) return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      throw new Error(`Unexpected fetch to ${url}`);
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
    Object.assign(config, original);
  });

  it('uploads signed requests and stores the Cloudinary asset', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const response = await upload(merchant.accessToken, `/items/${item.id}/images`, 2);

    expect(response.status).toBe(201);
    const updated: ItemView = response.body.data.item;
    expect(updated.images[0]?.url).toBe('https://res.cloudinary.com/demo-cloud/image/upload/v1/inperge/items/p1.png');
    expect(updated.images[0]?.thumbnailUrl).toBe(
      'https://res.cloudinary.com/demo-cloud/image/upload/c_fill,w_240,h_240,q_auto,f_auto/v1/inperge/items/p1.png',
    );
    expect(updated.images[0]).toMatchObject({ width: 800, height: 600, bytes: 4096 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    const form = init.body as FormData;
    expect(form.get('api_key')).toBe('key-123');
    expect(form.get('folder')).toBe('inperge/items');
    expect(form.get('signature')).toBe(
      signParams({ folder: 'inperge/items', timestamp: String(form.get('timestamp')) }, 'secret-xyz'),
    );

    const stored = await Item.findById(item.id);
    expect(stored?.images[0]).toMatchObject({ provider: 'cloudinary', publicId: 'inperge/items/p1' });
  });

  it('destroys the asset on Cloudinary when an image is removed', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    const added: ItemView = (await upload(merchant.accessToken, `/items/${item.id}/images`, 1)).body.data.item;

    await request(app())
      .delete(`${API}/items/${item.id}/images/${added.images[0]?.id}`)
      .set(...auth(merchant.accessToken));

    const destroy = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/image/destroy')) as [string, RequestInit];
    expect(destroy).toBeDefined();
    expect((destroy[1].body as FormData).get('public_id')).toBe('inperge/items/p1');
  });

  it('destroys every asset when the product is deleted', async () => {
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);
    await upload(merchant.accessToken, `/items/${item.id}/images`, 2);

    const response = await request(app()).delete(`${API}/items/${item.id}`).set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const destroyed = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/image/destroy'))
      .map(([, init]) => ((init as RequestInit).body as FormData).get('public_id'));
    expect(destroyed.sort()).toEqual(['inperge/items/p1', 'inperge/items/p2']);
  });

  it('reports a Cloudinary outage without saving a half-added gallery', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 }));
    const merchant = await registerMerchant();
    const item = await createItem(merchant.accessToken);

    const response = await upload(merchant.accessToken, `/items/${item.id}/images`, 1);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('IMAGE_STORAGE_UNAVAILABLE');
    expect((await Item.findById(item.id))?.images).toHaveLength(0);
  });
});

describe('Cloudinary helpers', () => {
  it('signs parameters the way Cloudinary documents', () => {
    // The worked example from Cloudinary's "generating authentication signatures" guide.
    expect(
      signParams(
        { timestamp: 1315060510, public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' },
        'abcd',
      ),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('only rewrites Cloudinary URLs into thumbnails', () => {
    expect(cloudinaryThumbnail('http://localhost:4100/uploads/items/a.png')).toBe('http://localhost:4100/uploads/items/a.png');
    expect(cloudinaryThumbnail('https://res.cloudinary.com/x/image/upload/v2/a.jpg', 100)).toBe(
      'https://res.cloudinary.com/x/image/upload/c_fill,w_100,h_100,q_auto,f_auto/v2/a.jpg',
    );
  });
});
