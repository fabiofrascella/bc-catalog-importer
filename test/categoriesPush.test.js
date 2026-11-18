import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { pushTree } from '../src/bigcommerce/categories.js';

// Only exercised by the image pre-check test below (every other test's nodes
// have no `image`, so checkImage never runs) — a URL containing "bad-format"
// reports back as an unsupported-format image; anything else is "can't
// tell" (ok: false, like a 405), matching checkImage's own safe pass-through.
let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('bad-format')) {
      return { ok: true, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/tiff' : null) } };
    }
    return { ok: false, headers: { get: () => null } };
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});

function tree() {
  return [
    {
      name: 'Men',
      children: [
        { name: 'Shoes', children: [{ name: 'Sneakers', children: [] }] },
        { name: 'Shirts', children: [] },
      ],
    },
    { name: 'Women', children: [] },
  ];
}

test('pushTree: skip strategy reuses existing categories and only creates what is missing', async () => {
  const calls = [];
  let nextId = 100;
  const client = {
    // "Men" already exists at the root; everything else is new.
    get: async () => [{ id: 1, name: 'Men', parent_id: 0 }],
    post: async (path, body) => {
      calls.push(body);
      return body.map((b) => ({ id: nextId++, name: b.name, parent_id: b.parent_id }));
    },
  };
  const stats = await pushTree(client, tree(), { treeId: 1, strategy: 'skip', log: () => {} });

  assert.equal(stats.skipped, 1); // "Men" reused
  assert.equal(stats.created, 4); // Women, Shoes, Shirts, Sneakers
  // "Shoes"/"Shirts" must have been created under Men's existing id (1), not re-created at root.
  const level1 = calls.find((chunk) => chunk.some((c) => c.name === 'Shoes' || c.name === 'Shirts'));
  assert.ok(level1.every((c) => c.parent_id === 1 || c.name === 'Women'));
});

test('pushTree: create strategy always creates, even for a name that already exists', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return body.map((b, i) => ({ id: 200 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const stats = await pushTree(client, [{ name: 'Men', children: [] }], {
    treeId: 1,
    strategy: 'create',
    log: () => {},
  });
  assert.equal(stats.skipped, 0);
  assert.equal(stats.created, 1);
  assert.equal(calls.length, 1);
});

test('pushTree: recreate strategy deletes existing root categories first, then creates fresh', async () => {
  const deleted = [];
  const created = [];
  const client = {
    get: async () => [
      { id: 1, name: 'Men', parent_id: 0 },
      { id: 2, name: 'Old Sub', parent_id: 1 },
    ],
    delete: async (path) => {
      deleted.push(path);
    },
    post: async (path, body) => {
      created.push(body);
      return body.map((b, i) => ({ id: 300 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const stats = await pushTree(client, [{ name: 'Men', children: [] }], {
    treeId: 1,
    strategy: 'recreate',
    log: () => {},
  });
  assert.equal(stats.deleted, 1); // only the root "Men" is deleted directly; children cascade server-side
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /category_id:in=1/);
  assert.equal(stats.created, 1);
  assert.equal(created[0][0].name, 'Men');
});

test('pushTree: builds a fallback slug from the name when no url is included/available', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return body.map((b, i) => ({ id: 400 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  await pushTree(client, [{ name: 'Men & Women', children: [] }], {
    treeId: 1,
    strategy: 'create',
    log: () => {},
  });
  assert.equal(calls[0][0].url.path, '/men-women');
});

test('pushTree: drops an invalid category image pre-flight instead of sending it', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return body.map((b, i) => ({ id: 500 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const logs = [];
  await pushTree(
    client,
    [{ name: 'Men', image: 'https://m.com/bad-format.tiff', children: [] }],
    { treeId: 1, strategy: 'create', log: (m) => logs.push(m) },
  );
  assert.equal(calls[0][0].image_url, undefined);
  assert.ok(logs.some((l) => /dropping invalid category image/.test(l) && /unsupported format/.test(l)));
});

test('pushTree: a batch that silently partially committed despite a 422 is not re-sent in full (regression: avoids a "duplicate name" error on retry)', async () => {
  // Reproduces a real BigCommerce behavior: the first create call 422s citing
  // only "Men"'s image, but "Women" was actually created anyway server-side
  // despite the overall error response. A naive retry of the whole original
  // chunk would re-send "Women" too and get "duplicate category name" back.
  const calls = [];
  let attempt = 0;
  const client = {
    get: async () => [{ id: 999, name: 'Women', parent_id: 0 }], // already exists after the "failed" call
    post: async (path, body) => {
      calls.push(body.map((b) => ({ ...b })));
      attempt += 1;
      if (attempt === 1) {
        throw new Error(
          'BigCommerce POST /catalog/trees/categories → HTTP 422: {"status":422,"title":"...",' +
            '"errors":{"0.image_url":"File is not a valid image"}}',
        );
      }
      return body.map((b, i) => ({ id: 600 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const logs = [];
  const stats = await pushTree(
    client,
    [
      { name: 'Men', image: 'https://m.com/a.jpg', children: [] },
      { name: 'Women', image: 'https://m.com/b.jpg', children: [] },
    ],
    { treeId: 1, strategy: 'create', log: (m) => logs.push(m) },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 2); // first attempt: original full chunk
  assert.equal(calls[1].length, 1); // retry: only "Men" — "Women" is not re-sent
  assert.equal(calls[1][0].name, 'Men');
  assert.equal(calls[1][0].image_url, undefined); // stripped before retry
  assert.equal(stats.created, 2); // both end up accounted for: 1 created + 1 reused
  assert.ok(logs.some((l) => /"Men": create failed on its image/.test(l)));
  assert.ok(logs.some((l) => /already created despite the failed batch create/.test(l) && /"Women"/.test(l)));
});

test('pushTree: an image error where nothing was actually committed strips images from the whole batch and retries', async () => {
  const calls = [];
  let attempt = 0;
  const client = {
    get: async () => [], // neither entry exists yet — a genuine full-batch failure
    post: async (path, body) => {
      calls.push(body.map((b) => ({ ...b })));
      attempt += 1;
      if (attempt === 1) {
        throw new Error('BigCommerce POST /catalog/trees/categories → HTTP 422: File is not a valid image');
      }
      return body.map((b, i) => ({ id: 700 + i, name: b.name, parent_id: b.parent_id }));
    },
  };
  const stats = await pushTree(
    client,
    [
      { name: 'Men', image: 'https://m.com/a.jpg', children: [] },
      { name: 'Women', image: 'https://m.com/b.jpg', children: [] },
    ],
    { treeId: 1, strategy: 'create', log: () => {} },
  );

  assert.equal(calls[1].length, 2); // both retried — neither had already gone through
  assert.equal(calls[1][0].image_url, undefined);
  assert.equal(calls[1][1].image_url, undefined);
  assert.equal(stats.created, 2);
});

test('pushTree: a non-image batch error with nothing already committed is not retried and propagates', async () => {
  const client = {
    get: async () => [], // confirms nothing from the chunk was silently created
    post: async () => {
      throw new Error('BigCommerce POST /catalog/trees/categories → HTTP 422: Missing Required Fields');
    },
  };
  await assert.rejects(
    () => pushTree(client, [{ name: 'Men', children: [] }], { treeId: 1, strategy: 'create', log: () => {} }),
    /Missing Required Fields/,
  );
});

test('pushTree: a non-image batch error where the entry was actually already committed recovers instead of throwing', async () => {
  const client = {
    get: async () => [{ id: 42, name: 'Men', parent_id: 0 }], // it did go through, despite the error
    post: async () => {
      throw new Error('BigCommerce POST /catalog/trees/categories → HTTP 422: Something unrelated and odd');
    },
  };
  const stats = await pushTree(client, [{ name: 'Men', children: [] }], {
    treeId: 1,
    strategy: 'create',
    log: () => {},
  });
  assert.equal(stats.created, 1);
});

test('pushTree: dry run reports what would be created without calling the client', async () => {
  const client = {
    post: async () => {
      throw new Error('should not be called in dry run');
    },
  };
  const logs = [];
  const stats = await pushTree(client, tree(), {
    treeId: 1,
    strategy: 'create',
    dryRun: true,
    log: (m) => logs.push(m),
  });
  assert.equal(stats.created, 5); // Men, Women, Shoes, Shirts, Sneakers — nothing reused in dry run
  assert.ok(logs.some((l) => /would create "Sneakers"/.test(l)));
});
