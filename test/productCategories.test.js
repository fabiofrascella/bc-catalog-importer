import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchCategories,
  findCatchAllCategory,
  createCategories,
  withAncestorIds,
} from '../src/bigcommerce/productCategories.js';

function cat(id, name) {
  return { id, name };
}

test('matchCategories: exact (case/accent-insensitive) match', () => {
  const existing = [cat(1, 'Backpacks'), cat(2, 'Outdoor Gear')];
  const { matches, unmatched } = matchCategories(existing, ['backpacks', 'OUTDOOR GEAR']);
  assert.equal(matches.get('backpacks').method, 'exact');
  assert.equal(matches.get('backpacks').category.id, 1);
  assert.equal(matches.get('OUTDOOR GEAR').category.id, 2);
  assert.equal(unmatched.length, 0);
});

test('matchCategories: singular/plural insensitive match', () => {
  const existing = [cat(1, 'Backpacks')];
  const { matches, unmatched } = matchCategories(existing, ['Backpack']);
  assert.equal(matches.get('Backpack').method, 'plural');
  assert.equal(matches.get('Backpack').category.id, 1);
  assert.equal(unmatched.length, 0);
});

test('matchCategories: plural-insensitive match takes priority over fuzzy', () => {
  const existing = [cat(1, 'Outdoor Gear')];
  const { matches } = matchCategories(existing, ['Outdoor Gears']);
  assert.equal(matches.get('Outdoor Gears').method, 'plural');
  assert.equal(matches.get('Outdoor Gears').category.id, 1);
});

test('matchCategories: fuzzy match on a small typo, above threshold', () => {
  const existing = [cat(1, 'Outdoor Gear')];
  const { matches, unmatched } = matchCategories(existing, ['Outdor Gear']);
  assert.equal(matches.get('Outdor Gear').method, 'fuzzy');
  assert.equal(matches.get('Outdor Gear').category.id, 1);
  assert.equal(unmatched.length, 0);
});

test('matchCategories: unrelated names are not merged', () => {
  const existing = [cat(1, 'Belts'), cat(2, 'Boots')];
  const { matches, unmatched } = matchCategories(existing, ['Hats']);
  assert.equal(matches.size, 0);
  assert.deepEqual(unmatched, ['Hats']);
});

test('matchCategories: no existing categories -> everything queued for creation', () => {
  const { matches, unmatched } = matchCategories([], ['Backpacks', 'Outdoor Gear']);
  assert.equal(matches.size, 0);
  assert.deepEqual(unmatched, ['Backpacks', 'Outdoor Gear']);
});

test('matchCategories: exact match wins over a closer-looking different category', () => {
  const existing = [cat(1, 'Bag'), cat(2, 'Bags')];
  const { matches } = matchCategories(existing, ['Bags']);
  assert.equal(matches.get('Bags').method, 'exact');
  assert.equal(matches.get('Bags').category.id, 2);
});

test('findCatchAllCategory: prefers "Shop All" over "Products" when both exist', () => {
  const existing = [cat(1, 'Products'), cat(2, 'Shop All')];
  assert.equal(findCatchAllCategory(existing).id, 2);
});

test('findCatchAllCategory: falls back through the priority list', () => {
  assert.equal(findCatchAllCategory([cat(1, 'Products')]).id, 1);
  assert.equal(findCatchAllCategory([cat(1, 'All')]).id, 1);
  assert.equal(findCatchAllCategory([cat(1, 'Random Category')]), null);
  assert.equal(findCatchAllCategory([]), null);
});

test('createCategories: nests every created category under the given parentId', async () => {
  const calls = [];
  const fakeClient = {
    post: async (path, body) => {
      calls.push({ path, body });
      return body.map((b, i) => ({ id: 100 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const ids = await createCategories(fakeClient, ['Backpacks', 'Outdoor Gear'], {
    treeId: 1,
    parentId: 42,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/catalog/trees/categories');
  assert.ok(calls[0].body.every((b) => b.parent_id === 42 && b.tree_id === 1));
  assert.equal(ids.get('Backpacks'), 100);
  assert.equal(ids.get('Outdoor Gear'), 101);
});

test('createCategories: defaults to parentId 0 (tree root) when not specified', async () => {
  const calls = [];
  const fakeClient = {
    post: async (path, body) => {
      calls.push(body);
      return body.map((b, i) => ({ id: i + 1, name: b.name }));
    },
  };
  await createCategories(fakeClient, ['Shop All'], { treeId: 1 });
  assert.equal(calls[0][0].parent_id, 0);
});

test('withAncestorIds: walks up to the top-level category, stopping at root', () => {
  // Root(0) -> Backpacks(1) -> Daypacks(2) -> Ultralight Daypacks(3)
  const parentById = new Map([
    [1, 0],
    [2, 1],
    [3, 2],
  ]);
  assert.deepEqual(withAncestorIds(3, parentById), [3, 2, 1]);
  assert.deepEqual(withAncestorIds(1, parentById), [1]); // already top-level
});

test('withAncestorIds: a category with no known parent is returned alone', () => {
  assert.deepEqual(withAncestorIds(42, new Map()), [42]);
});

test('withAncestorIds: tolerates a cyclic parent map instead of looping forever', () => {
  const parentById = new Map([
    [1, 2],
    [2, 1], // bogus cycle
  ]);
  assert.deepEqual(withAncestorIds(1, parentById), [1, 2]);
});
