import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateListing, buildItemPayload } from '../dist/seller/listing.js';
import { priceStats, suggestPrice, quantile } from '../dist/seller/pricing.js';
import { readiness } from '../dist/seller/ops.js';
import { callTool } from '../dist/dispatch.js';

const home = mkdtempSync(join(tmpdir(), 'vinted-home-'));
process.env.VINTED_HOME = home;

const good = {
  title: "Levi's 501 jeans W32 L32",
  description: 'Dark wash, worn a handful of times. Waist 41cm flat, inseam 81cm. No marks or fading.',
  price: 25,
  photos: ['/x/1.jpg', '/x/2.jpg', '/x/3.jpg', '/x/4.png'],
  condition: 'very_good',
  categoryId: 257,
  brandId: 10,
  sizeId: 207,
  colorIds: [1],
  packageSize: 'small',
};

test('validateListing accepts a complete listing', () => {
  assert.deepEqual(validateListing(good), { errors: [], warnings: [] });
});

test('validateListing reports hard errors', () => {
  const r = validateListing({ ...good, title: 'abc', price: 0, photos: [], condition: 'mint', categoryId: undefined });
  assert.equal(r.errors.length, 5);
  assert.match(r.errors.join('|'), /title.*5/);
  assert.match(r.errors.join('|'), /photo/);
  assert.match(r.errors.join('|'), /condition/);
});

test('validateListing rejects unsupported photo types', () => {
  const r = validateListing({ ...good, photos: ['/x/a.gif'] });
  assert.match(r.errors.join('|'), /unsupported photo type/);
});

test('buildItemPayload maps the spec to Vinted fields', () => {
  const p = buildItemPayload(good, [11, 12], 'uuid-1', 'EUR');
  assert.equal(p.status_id, 2);
  assert.equal(p.catalog_id, 257);
  assert.equal(p.package_size_id, 1);
  assert.deepEqual(p.assigned_photos, [{ id: 11, orientation: 0 }, { id: 12, orientation: 0 }]);
  assert.equal(p.temp_uuid, 'uuid-1');
  assert.equal(p.currency, 'EUR');
});

test('priceStats computes quartiles and ignores junk', () => {
  const s = priceStats([10, 20, 30, 40, 50, NaN, 0, -3], 'EUR');
  assert.deepEqual(s, { sampleSize: 5, currency: 'EUR', min: 10, p25: 20, median: 30, p75: 40, max: 50 });
  assert.equal(priceStats([], 'EUR'), null);
  assert.equal(quantile([1, 2], 0.5), 1.5);
});

test('suggestPrice sits just under round numbers', () => {
  assert.deepEqual(suggestPrice({ sampleSize: 3, currency: 'EUR', min: 1, p25: 20, median: 31.4, p75: 44.6, max: 90 }),
    { quickSale: 19, fair: 31, ambitious: 44 });
  assert.equal(suggestPrice({ sampleSize: 1, currency: 'EUR', min: 1, p25: 3.4, median: 3.4, p75: 3.4, max: 3.4 }).quickSale, 3);
});

test('readiness lists profile gaps', () => {
  const r = readiness({ id: 1, username: 'x', profileUrl: '', hasPhoto: false, about: '', phoneVerified: false, onHoliday: true });
  assert.equal(r.ready, false);
  assert.ok(r.todo.some((t) => /profile photo/.test(t)));
  assert.ok(r.todo.some((t) => /Holiday mode/.test(t)));
  const ok = readiness({ id: 1, username: 'x', profileUrl: '', hasPhoto: true, about: 'Fast shipping, bundles welcome, smoke-free home.' });
  assert.equal(ok.ready, true);
});

function mockClient() {
  return {
    async apiGet(_country, path) {
      if (path.startsWith('/api/v2/brands')) return { brands: [{ id: 10, title: "Levi's" }] };
      if (path.startsWith('/api/v2/size_groups')) {
        return { size_groups: [{ id: 1, caption: 'Men', description: '', sizes: [{ id: 207, title: 'W32' }] }] };
      }
      if (path.startsWith('/api/v2/colors')) return { colors: [{ id: 1, title: 'Black', code: 'BLACK' }] };
      throw new Error(`unmocked: ${path}`);
    },
  };
}

test('account tools are off unless the operator enables them', async () => {
  delete process.env.VINTED_ACCOUNT_TOOLS;
  await assert.rejects(callTool(mockClient(), 'prepare_listing', {}), /VINTED_ACCOUNT_TOOLS=1/);
  await assert.rejects(callTool(mockClient(), 'publish_listing', { listingId: 'x', confirm: true }), /disabled/);
});

test('prepare_listing resolves names, reads a photo folder and saves a draft', async () => {
  process.env.VINTED_ACCOUNT_TOOLS = '1';
  const folder = join(home, 'inbox', 'levis');
  mkdirSync(folder, { recursive: true });
  for (const n of ['10-label.jpg', '2-back.jpg', '1-front.jpg', 'notes.txt', '.hidden.jpg']) writeFileSync(join(folder, n), 'x');

  const r = await callTool(mockClient(), 'prepare_listing', {
    ...good, brandId: undefined, sizeId: undefined, colorIds: undefined, photos: undefined,
    brand: 'levis', size: 'W32', color: ['black'], folder,
  });
  assert.equal(r.readyToPublish, true, JSON.stringify(r.errors));
  assert.deepEqual(r.preview.photos.map((p) => p.split('/').pop()), ['1-front.jpg', '2-back.jpg', '10-label.jpg']);
  assert.equal(r.preview.sizeId, 207);
  assert.equal(r.preview.brand, "Levi's");
  assert.deepEqual(r.preview.colorIds, [1]);

  const edited = await callTool(mockClient(), 'prepare_listing', { listingId: r.listingId, price: 30 });
  assert.equal(edited.listingId, r.listingId);
  assert.match(edited.preview.price, /^30 /);
  assert.equal(edited.preview.photos.length, 3);
});

test('prepare_listing reports missing photos as errors', async () => {
  process.env.VINTED_ACCOUNT_TOOLS = '1';
  const r = await callTool(mockClient(), 'prepare_listing', { ...good, photos: [join(home, 'nope.jpg')] });
  assert.equal(r.readyToPublish, false);
  assert.match(r.errors.join('|'), /photo not found/);
});

test('publish_listing refuses without explicit confirmation', async () => {
  process.env.VINTED_ACCOUNT_TOOLS = '1';
  await assert.rejects(callTool(mockClient(), 'publish_listing', { listingId: 'abcdefgh' }), /confirm: true/);
  await assert.rejects(callTool(mockClient(), 'publish_listing', { listingId: 'abcdefgh', confirm: true }), /No prepared listing/);
  await assert.rejects(callTool(mockClient(), 'publish_listing', { listingId: '../../etc/passwd', confirm: true }), /Invalid listing id/);
});

test('US listings use vinted.com and USD', async () => {
  const { DOMAIN } = await import('../dist/client/types.js');
  const { CURRENCY } = await import('../dist/seller/listing.js');
  const { parseItemRef } = await import('../dist/ops/get-item.js');
  assert.equal(DOMAIN.us, 'www.vinted.com');
  assert.equal(CURRENCY.us, 'USD');
  assert.deepEqual(parseItemRef({ url: 'https://www.vinted.com/items/123456-levis' }), { id: 123456, country: 'us' });
});
