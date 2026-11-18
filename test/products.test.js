import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { pushProducts, MIN_INVENTORY_LEVEL, MAX_INVENTORY_LEVEL } from '../src/bigcommerce/products.js';

// Stub global fetch so the image pre-check never makes a real network call in
// tests — treat every HEAD check as "can't tell" (images pass through
// unchanged), matching checkImage's own safe-fallback behavior.
let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => null } });
});
after(() => {
  globalThis.fetch = originalFetch;
});

function baseProduct(overrides = {}) {
  return {
    name: 'Widget',
    sku: 'WID-1',
    skuGenerated: false,
    description: 'A widget.',
    price: 9.99,
    priceIsFake: false,
    images: ['https://m.com/a.jpg', 'https://m.com/b.jpg'],
    customFields: [],
    categories: [],
    categoryIds: [],
    variants: [],
    ...overrides,
  };
}

test('pushProducts: creates each product with a single POST when nothing fails', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push({ path, body });
      return { id: 1 };
    },
  };
  const stats = await pushProducts(client, [baseProduct()], { strategy: 'create', dryRun: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.images.length, 2);
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesDropped, 0);
});

test('pushProducts: retries once with no images when create fails on the image-size error', async () => {
  const calls = [];
  let attempt = 0;
  const client = {
    post: async (path, body) => {
      calls.push(body);
      attempt += 1;
      if (attempt === 1) {
        throw new Error(
          'BigCommerce POST /catalog/products → HTTP 422: The maximum of 8 MB size limit for upload image is exceeded',
        );
      }
      return { id: 2 };
    },
  };
  const logs = [];
  const stats = await pushProducts(client, [baseProduct()], {
    strategy: 'create',
    dryRun: false,
    log: (m) => logs.push(m),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].images, undefined); // second attempt sent with no images at all
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesDropped, 2);
  assert.ok(logs.some((l) => /retrying with no images/.test(l)));
});

test('pushProducts: retries once with no images when create fails on an invalid image_url error', async () => {
  const calls = [];
  let attempt = 0;
  const client = {
    post: async (path, body) => {
      calls.push(body);
      attempt += 1;
      if (attempt === 1) {
        throw new Error(`BigCommerce POST /catalog/products → HTTP 422: The field 'image_url' is invalid`);
      }
      return { id: 2 };
    },
  };
  const logs = [];
  const stats = await pushProducts(client, [baseProduct()], {
    strategy: 'create',
    dryRun: false,
    log: (m) => logs.push(m),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].images, undefined);
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesDropped, 2);
  assert.ok(logs.some((l) => /retrying with no images/.test(l)));
});

test('pushProducts: retries once with no images when create fails on an unsupported image format error', async () => {
  const calls = [];
  let attempt = 0;
  const client = {
    post: async (path, body) => {
      calls.push(body);
      attempt += 1;
      if (attempt === 1) {
        throw new Error('BigCommerce POST /catalog/products → HTTP 400: image/tiff format is not supported by platform');
      }
      return { id: 2 };
    },
  };
  const logs = [];
  const stats = await pushProducts(client, [baseProduct()], {
    strategy: 'create',
    dryRun: false,
    log: (m) => logs.push(m),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].images, undefined);
  assert.equal(stats.created, 1);
  assert.equal(stats.imagesDropped, 2);
  assert.ok(logs.some((l) => /retrying with no images/.test(l)));
});

test('pushProducts: fake-priced products are created disabled with a "Call for pricing" label', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 3 };
    },
  };
  await pushProducts(client, [baseProduct({ price: 0, priceIsFake: true })], {
    strategy: 'create',
    dryRun: false,
  });
  assert.equal(calls[0].availability, 'disabled');
  assert.equal(calls[0].is_price_hidden, true);
  assert.equal(calls[0].price_hidden_label, 'Call for pricing');
});

test('pushProducts: normally-priced products get no availability/price-hidden overrides', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 4 };
    },
  };
  await pushProducts(client, [baseProduct()], { strategy: 'create', dryRun: false });
  assert.equal(calls[0].availability, undefined);
  assert.equal(calls[0].is_price_hidden, undefined);
});

test('pushProducts: variants are nested as create-time variants and switch inventory_tracking', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 5 };
    },
  };
  await pushProducts(
    client,
    [
      baseProduct({
        variants: [
          {
            sku: 'WID-RED-S',
            optionValues: [
              { name: 'Color', value: 'Red' },
              { name: 'Size', value: 'Small' },
            ],
          },
          {
            sku: 'WID-BLU-M',
            priceOverride: 12.5,
            optionValues: [
              { name: 'Color', value: 'Blue' },
              { name: 'Size', value: 'Medium' },
            ],
          },
        ],
      }),
    ],
    { strategy: 'create', dryRun: false },
  );

  assert.equal(calls[0].inventory_tracking, 'variant');
  assert.equal(calls[0].inventory_level, undefined); // superseded by each variant's own level
  assert.equal(calls[0].variants.length, 2);
  const { inventory_level: v1Level, ...v1Rest } = calls[0].variants[0];
  assert.deepEqual(v1Rest, {
    sku: 'WID-RED-S',
    option_values: [
      { option_display_name: 'Color', label: 'Red' },
      { option_display_name: 'Size', label: 'Small' },
    ],
  });
  assert.ok(Number.isInteger(v1Level) && v1Level >= MIN_INVENTORY_LEVEL && v1Level <= MAX_INVENTORY_LEVEL);
  assert.equal(calls[0].variants[1].price, 12.5);
  assert.ok(Number.isInteger(calls[0].variants[1].inventory_level));
});

test('pushProducts: a variant image_url is linked only when the URL is in the product\'s own images', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 7 };
    },
  };
  await pushProducts(
    client,
    [
      baseProduct({
        images: ['https://m.com/a.jpg', 'https://m.com/red.jpg'],
        variants: [
          {
            sku: 'WID-RED',
            optionValues: [{ name: 'Color', value: 'Red' }],
            image: 'https://m.com/red.jpg', // present in product.images -> linked
          },
          {
            sku: 'WID-BLU',
            optionValues: [{ name: 'Color', value: 'Blue' }],
            image: 'https://m.com/blue-not-uploaded.jpg', // not present -> not linked
          },
        ],
      }),
    ],
    { strategy: 'create', dryRun: false },
  );

  assert.equal(calls[0].variants[0].image_url, 'https://m.com/red.jpg');
  assert.equal(calls[0].variants[1].image_url, undefined);
});

test('pushProducts: products with no variants get "product"-level tracking and a random inventory_level, no variants key', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 6 };
    },
  };
  await pushProducts(client, [baseProduct()], { strategy: 'create', dryRun: false });
  assert.equal(calls[0].inventory_tracking, 'product');
  assert.ok(Number.isInteger(calls[0].inventory_level));
  assert.ok(calls[0].inventory_level >= MIN_INVENTORY_LEVEL && calls[0].inventory_level <= MAX_INVENTORY_LEVEL);
  assert.equal(calls[0].variants, undefined);
});

test('pushProducts: inventory_level is not the same fixed number on every product', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 9 };
    },
  };
  const products = Array.from({ length: 20 }, (_, i) => baseProduct({ name: `Widget ${i}`, sku: `WID-${i}` }));
  await pushProducts(client, products, { strategy: 'create', dryRun: false });
  const levels = new Set(calls.map((c) => c.inventory_level));
  assert.ok(levels.size > 1, 'expected some variety across 20 random inventory levels');
});

test('pushProducts: brandId is sent as brand_id when present, omitted when absent', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 8 };
    },
  };
  await pushProducts(client, [baseProduct({ brandId: 42 }), baseProduct({ name: 'Other Widget' })], {
    strategy: 'create',
    dryRun: false,
  });
  assert.equal(calls[0].brand_id, 42);
  assert.equal(calls[1].brand_id, undefined);
});

test('pushProducts: a SKU conflict with a different existing product is skipped, not fatal, and the run continues', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      if (body.name === 'Widget') {
        throw new Error(`BigCommerce POST /catalog/products → HTTP 409: Sku 6800-9862638 is not unique`);
      }
      return { id: 9 };
    },
  };
  const logs = [];
  const stats = await pushProducts(
    client,
    [baseProduct({ sku: '6800-9862638' }), baseProduct({ name: 'Other Widget', sku: 'OTHER-1' })],
    { strategy: 'create', dryRun: false, log: (m) => logs.push(m) },
  );
  assert.equal(calls.length, 2); // both attempted — the conflict didn't abort the run
  assert.equal(stats.created, 1);
  assert.equal(stats.skuConflicts, 1);
  assert.ok(logs.some((l) => /SKU "6800-9862638" is already used/.test(l)));
});

test('pushProducts: a different create error is not retried and propagates', async () => {
  const client = {
    post: async () => {
      throw new Error('BigCommerce POST /catalog/products → HTTP 422: Missing Required Fields');
    },
  };
  await assert.rejects(
    () => pushProducts(client, [baseProduct()], { strategy: 'create', dryRun: false }),
    /Missing Required Fields/,
  );
});

test('pushProducts: costMarginPercent sets cost_price as a % below price', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 1 };
    },
  };
  await pushProducts(client, [baseProduct({ price: 10 })], {
    strategy: 'create',
    dryRun: false,
    costMarginPercent: 20,
  });
  assert.equal(calls[0].cost_price, 8);
});

test('pushProducts: no costMarginPercent means no cost_price sent at all', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 1 };
    },
  };
  await pushProducts(client, [baseProduct()], { strategy: 'create', dryRun: false });
  assert.equal('cost_price' in calls[0], false);
});

test('pushProducts: costMarginPercent is skipped for a fake (not-purchasable) price', async () => {
  const calls = [];
  const client = {
    post: async (path, body) => {
      calls.push(body);
      return { id: 1 };
    },
  };
  await pushProducts(client, [baseProduct({ price: 0, priceIsFake: true })], {
    strategy: 'create',
    dryRun: false,
    costMarginPercent: 20,
  });
  assert.equal('cost_price' in calls[0], false);
});
