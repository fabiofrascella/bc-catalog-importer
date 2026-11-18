import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName,
  isUtilityLabel,
  resolveUrl,
  normalizeTree,
  dedupeSiblings,
  countNodes,
  maxDepth,
} from '../src/tree/model.js';

test('cleanName collapses whitespace', () => {
  assert.equal(cleanName('  Men\n  Shoes '), 'Men Shoes');
  assert.equal(cleanName(undefined), '');
});

test('isUtilityLabel flags non-category links', () => {
  assert.ok(isUtilityLabel('Login'));
  assert.ok(isUtilityLabel('  CART '));
  assert.ok(!isUtilityLabel('Shoes'));
});

test('resolveUrl resolves relative and rejects junk', () => {
  assert.equal(resolveUrl('/shoes', 'https://m.com'), 'https://m.com/shoes');
  assert.equal(resolveUrl('#', 'https://m.com'), undefined);
  assert.equal(resolveUrl('javascript:void(0)', 'https://m.com'), undefined);
  assert.equal(resolveUrl('', 'https://m.com'), undefined);
});

test('normalizeTree strips utility links, resolves urls, trims depth', () => {
  const raw = [
    {
      name: 'Men',
      href: '/men',
      children: [
        { name: 'Shoes', href: '/men/shoes', children: [{ name: 'Sneakers', href: '/men/shoes/sneakers' }] },
      ],
    },
    { name: 'Login', href: '/login' }, // utility → dropped
  ];

  const tree = normalizeTree(raw, { origin: 'https://m.com', depth: 2 });

  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'Men');
  assert.equal(tree[0].url, 'https://m.com/men');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].name, 'Shoes');
  // depth 2 → Sneakers (level 3) trimmed off
  assert.equal(tree[0].children[0].children.length, 0);
});

test('dedupeSiblings merges same-named nodes and their children', () => {
  const merged = dedupeSiblings([
    { name: 'Sale', url: '/sale', children: [{ name: 'Men', children: [] }] },
    { name: 'sale', children: [{ name: 'Women', children: [] }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, '/sale');
  assert.equal(merged[0].children.length, 2);
});

test('countNodes and maxDepth', () => {
  const tree = normalizeTree(
    [{ name: 'A', children: [{ name: 'B', children: [{ name: 'C' }] }] }],
    {},
  );
  assert.equal(countNodes(tree), 3);
  assert.equal(maxDepth(tree), 3);
});
