import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTreeId, getExistingCategories, categoryKey } from '../src/bigcommerce/trees.js';

test('categoryKey is accent/case-insensitive and parent-scoped', () => {
  assert.equal(categoryKey(0, 'Backpacks'), categoryKey(0, 'backpacks'));
  assert.equal(categoryKey(0, 'Portátiles'), categoryKey(0, 'Portatiles'));
  assert.notEqual(categoryKey(0, 'Sale'), categoryKey(1, 'Sale')); // same name, different parent
});

test('resolveTreeId: reuses a tree already assigned to the channel', async () => {
  const client = {
    get: async () => [
      { id: 5, name: 'Other', channels: [9] },
      { id: 7, name: 'Mine', channels: [1, 2] },
    ],
  };
  const id = await resolveTreeId(client, 2);
  assert.equal(id, 7);
});

test('resolveTreeId: creates and assigns a new tree when none matches the channel', async () => {
  const calls = [];
  const client = {
    get: async () => [{ id: 5, name: 'Other', channels: [9] }],
    put: async (path, body) => {
      calls.push({ path, body });
      return [{ id: 11, name: body[0].name, channels: body[0].channels }];
    },
  };
  const id = await resolveTreeId(client, 2);
  assert.equal(id, 11);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/catalog/trees');
  assert.deepEqual(calls[0].body[0].channels, [2]);
});

test('resolveTreeId: rejects a non-integer channel id', async () => {
  await assert.rejects(() => resolveTreeId({}, 'not-a-number'), /Invalid channel id/);
});

test('getExistingCategories: flattens nested children and paginates until a short page', async () => {
  const pages = [
    Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `Cat ${i + 1}`, parent_id: 0 })),
    [{ id: 999, name: 'Last', parent_id: 0, children: [{ id: 1000, name: 'Child', parent_id: 999 }] }],
  ];
  let calls = 0;
  const client = {
    get: async (path) => {
      const page = pages[calls];
      calls += 1;
      assert.match(path, new RegExp(`page=${calls}`));
      return page;
    },
  };
  const { list, byKey } = await getExistingCategories(client, 42);
  assert.equal(calls, 2);
  assert.equal(list.length, 252); // 250 + Last + its Child
  assert.ok(byKey.has(categoryKey(999, 'Child')));
  assert.equal(byKey.get(categoryKey(0, 'Last')).id, 999);
});
