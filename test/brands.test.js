import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getExistingBrands, resolveBrands } from '../src/bigcommerce/brands.js';

test('getExistingBrands pages until a short page and keys by folded name', async () => {
  const pages = [
    Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `Brand ${i + 1}` })),
    [{ id: 999, name: 'Última Marca' }],
  ];
  const client = { get: async () => pages.shift() };
  const { list, byKey } = await getExistingBrands(client);
  assert.equal(list.length, 251);
  assert.equal(byKey.get('ultima marca').id, 999);
});

test('resolveBrands reuses an existing brand by folded name and creates nothing for it', async () => {
  const posts = [];
  const client = {
    get: async () => [{ id: 5, name: 'Acme' }],
    post: async (path, body) => {
      posts.push(body);
      return { id: 999 };
    },
  };
  const idByName = await resolveBrands(client, ['acme', 'ACME'], { log: () => {} });
  assert.equal(idByName.get('acme'), 5);
  assert.equal(idByName.get('ACME'), 5);
  assert.equal(posts.length, 0); // never created — reused the existing one both times
});

test('resolveBrands creates a genuinely new brand once and reuses it for a differently-cased duplicate', async () => {
  const posts = [];
  let nextId = 100;
  const client = {
    get: async () => [],
    post: async (path, body) => {
      posts.push(body);
      return { id: nextId++ };
    },
  };
  const idByName = await resolveBrands(client, ['TrailForge', 'trailforge', 'Other'], { log: () => {} });
  assert.equal(posts.length, 2); // one POST for "TrailForge", one for "Other" — not for the dup
  assert.equal(idByName.get('TrailForge'), idByName.get('trailforge'));
  assert.notEqual(idByName.get('Other'), idByName.get('TrailForge'));
});

test('resolveBrands in dry-run mode logs but never posts and resolves no ids', async () => {
  const client = {
    get: async () => [],
    post: async () => {
      throw new Error('should not be called in dry-run');
    },
  };
  const logs = [];
  const idByName = await resolveBrands(client, ['NewBrand'], { dryRun: true, log: (m) => logs.push(m) });
  assert.equal(idByName.size, 0);
  assert.ok(logs.some((l) => /would create brand "NewBrand"/.test(l)));
});

test('resolveBrands with an empty name list makes no requests', async () => {
  const client = {
    get: async () => {
      throw new Error('should not be called');
    },
  };
  const idByName = await resolveBrands(client, [], { log: () => {} });
  assert.equal(idByName.size, 0);
});
