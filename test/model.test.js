import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanText,
  parsePrice,
  normalizeImages,
  normalizeCustomFields,
  normalizeCategories,
  normalizeOptionValues,
  normalizeBrandName,
  generateSku,
  normalizeProduct,
  normalizeCatalog,
} from '../src/products/model.js';

test('cleanText collapses whitespace', () => {
  assert.equal(cleanText('  Blue\n  Shirt '), 'Blue Shirt');
  assert.equal(cleanText(undefined), '');
});

test('parsePrice accepts numbers and currency strings, rejects junk', () => {
  assert.equal(parsePrice(19.99), 19.99);
  assert.equal(parsePrice('$19.99'), 19.99);
  assert.equal(parsePrice('19.99 USD'), 19.99);
  assert.equal(parsePrice(-5), null);
  assert.equal(parsePrice('free'), null);
  assert.equal(parsePrice(undefined), null);
});

test('normalizeImages accepts strings and {url}/{src} objects, dedupes, drops non-http', () => {
  const images = normalizeImages([
    'https://m.com/a.jpg',
    { url: 'https://m.com/b.jpg' },
    { src: 'https://m.com/c.jpg' },
    'https://m.com/a.jpg', // dup
    'not-a-url',
  ]);
  assert.deepEqual(images, ['https://m.com/a.jpg', 'https://m.com/b.jpg', 'https://m.com/c.jpg']);
});

test('normalizeImages percent-encodes fixable URLs but drops ones too long for BigCommerce', () => {
  const overlong = `https://m.com/${'a'.repeat(250)}.jpg`;
  const images = normalizeImages([
    'https://m.com/my photo.jpg', // unescaped space — fixable
    overlong, // valid URL, but over BigCommerce's 255-char image_url cap
  ]);
  assert.deepEqual(images, ['https://m.com/my%20photo.jpg']);
});

test('normalizeCustomFields accepts an object map or an array of pairs', () => {
  assert.deepEqual(normalizeCustomFields({ Material: 'Cotton', Color: 'Blue' }), [
    { name: 'Material', value: 'Cotton' },
    { name: 'Color', value: 'Blue' },
  ]);
  assert.deepEqual(
    normalizeCustomFields([
      { name: 'Material', value: 'Cotton' },
      { key: 'Color', value: 'Blue' },
    ]),
    [
      { name: 'Material', value: 'Cotton' },
      { name: 'Color', value: 'Blue' },
    ],
  );
});

test('normalizeCustomFields dedupes by name, last one wins', () => {
  const fields = normalizeCustomFields([
    { name: 'Color', value: 'Blue' },
    { name: 'color', value: 'Red' },
  ]);
  assert.deepEqual(fields, [{ name: 'color', value: 'Red' }]);
});

test('normalizeCategories accepts an array of strings, {name} objects, or a single string', () => {
  assert.deepEqual(normalizeCategories(['Backpacks', { name: 'Outdoor Gear' }]), [
    'Backpacks',
    'Outdoor Gear',
  ]);
  assert.deepEqual(normalizeCategories('Backpacks'), ['Backpacks']);
  assert.deepEqual(normalizeCategories(['Backpacks', 'backpacks']), ['Backpacks']); // dedupe
  assert.deepEqual(normalizeCategories(undefined), []);
});

test('normalizeOptionValues accepts an object map or an array of {name,value}/{option_display_name,label} pairs', () => {
  assert.deepEqual(normalizeOptionValues({ Color: 'Red', Size: 'Large' }), [
    { name: 'Color', value: 'Red' },
    { name: 'Size', value: 'Large' },
  ]);
  assert.deepEqual(
    normalizeOptionValues([
      { name: 'Color', value: 'Red' },
      { option_display_name: 'Size', label: 'Large' },
    ]),
    [
      { name: 'Color', value: 'Red' },
      { name: 'Size', value: 'Large' },
    ],
  );
});

test('normalizeBrandName accepts a plain string or a single-entry array, trims, defaults to empty', () => {
  assert.equal(normalizeBrandName('  TrailForge '), 'TrailForge');
  assert.equal(normalizeBrandName(['TrailForge']), 'TrailForge');
  assert.equal(normalizeBrandName(undefined), '');
  assert.equal(normalizeBrandName(''), '');
  assert.equal(normalizeBrandName([]), '');
});

test('generateSku produces a readable, unique-ish SKU from the name', () => {
  const a = generateSku('Trail Runner Backpack');
  const b = generateSku('Trail Runner Backpack');
  assert.match(a, /^TRAILRUN-[0-9A-F]{8}$/);
  assert.notEqual(a, b); // random suffix each call
  assert.match(generateSku(''), /^SKU-[0-9A-F]{8}$/);
});

test('normalizeProduct requires a name', () => {
  assert.equal(normalizeProduct({ price: 10 }).error, 'missing "name"');
});

test('normalizeProduct substitutes a fake price and flags not purchasable when price is missing/invalid', () => {
  const { product: p1, warnings: w1, error: e1 } = normalizeProduct({ name: 'Mug' });
  assert.equal(e1, undefined);
  assert.equal(p1.price, 0);
  assert.equal(p1.priceIsFake, true);
  assert.ok(w1.some((w) => /no usable price/.test(w) && /not purchasable/.test(w)));

  const { product: p2 } = normalizeProduct({ name: 'Mug', price: -1 });
  assert.equal(p2.priceIsFake, true);

  const { product: p3 } = normalizeProduct({ name: 'Mug', price: 'call for price' });
  assert.equal(p3.priceIsFake, true);
});

test('normalizeProduct warns (but does not drop) on thin data', () => {
  const { product, warnings, error } = normalizeProduct({ name: 'Mug', price: 9.99 });
  assert.equal(error, undefined);
  assert.equal(product.name, 'Mug');
  assert.equal(product.price, 9.99);
  assert.equal(product.images.length, 0);
  assert.equal(product.customFields.length, 0);
  assert.equal(product.categories.length, 0);
  assert.ok(warnings.some((w) => /description/.test(w)));
  assert.ok(warnings.some((w) => /image/.test(w)));
  assert.ok(warnings.some((w) => /custom field/.test(w)));
  assert.ok(warnings.some((w) => /categor/.test(w)));
});

test('normalizeProduct generates a SKU when the source has none', () => {
  const { product } = normalizeProduct({ name: 'Mug', price: 9.99 });
  assert.equal(product.skuGenerated, true);
  assert.ok(product.sku.length > 0);
});

test('normalizeProduct keeps the merchant SKU when present (incl. field-name variants)', () => {
  const { product: p1 } = normalizeProduct({ name: 'Mug', price: 9.99, sku: 'MUG-001' });
  assert.equal(p1.sku, 'MUG-001');
  assert.equal(p1.skuGenerated, false);

  const { product: p2 } = normalizeProduct({ name: 'Mug', price: 9.99, item_number: 'IN-42' });
  assert.equal(p2.sku, 'IN-42');
  assert.equal(p2.skuGenerated, false);
});

test('normalizeProduct is clean with full data and no warnings', () => {
  const { product, warnings, error } = normalizeProduct({
    name: 'Mug',
    description: 'A mug.',
    price: 9.99,
    images: ['https://m.com/a.jpg', 'https://m.com/b.jpg'],
    custom_fields: { Material: 'Ceramic', Color: 'White', Capacity: '350ml' },
    categories: ['Kitchen', 'Drinkware'],
  });
  assert.equal(error, undefined);
  assert.equal(warnings.length, 0);
  assert.equal(product.priceIsFake, false);
  assert.equal(product.images.length, 2);
  assert.equal(product.customFields.length, 3);
  assert.deepEqual(product.categories, ['Kitchen', 'Drinkware']);
});

test('normalizeProduct: variants get an option-value shape, auto-SKU, and optional price override', () => {
  const { product, warnings } = normalizeProduct({
    name: 'T-Shirt',
    description: 'A comfy tee.',
    price: 19.99,
    images: ['https://m.com/a.jpg', 'https://m.com/b.jpg'],
    custom_fields: { Material: 'Cotton', Fit: 'Regular', Origin: 'USA' },
    categories: ['Apparel'],
    variants: [
      { option_values: { Color: 'Red', Size: 'Small' } }, // no sku/price -> auto sku, no override
      { sku: 'TEE-BLU-M', price: 21.99, option_values: { Color: 'Blue', Size: 'Medium' } },
    ],
  });
  assert.equal(warnings.length, 0);
  assert.equal(product.variants.length, 2);

  const [v1, v2] = product.variants;
  assert.equal(v1.skuGenerated, true);
  assert.ok(v1.sku.length > 0);
  assert.equal(v1.priceOverride, undefined);
  assert.deepEqual(v1.optionValues, [
    { name: 'Color', value: 'Red' },
    { name: 'Size', value: 'Small' },
  ]);

  assert.equal(v2.sku, 'TEE-BLU-M');
  assert.equal(v2.skuGenerated, false);
  assert.equal(v2.priceOverride, 21.99);
});

test('normalizeProduct: a variant image is folded into the product images (after the base ones)', () => {
  const { product } = normalizeProduct({
    name: 'T-Shirt',
    price: 19.99,
    images: ['https://m.com/base.jpg'],
    variants: [
      { option_values: { Color: 'Red' }, image: 'https://m.com/red.jpg' },
      { option_values: { Color: 'Blue' } }, // no image
      { option_values: { Color: 'Green' }, image_url: 'https://m.com/base.jpg' }, // dup of a base image
    ],
  });
  // base image first (stays the thumbnail), then new variant-only images, deduped
  assert.deepEqual(product.images, ['https://m.com/base.jpg', 'https://m.com/red.jpg']);
  assert.equal(product.variants[0].image, 'https://m.com/red.jpg');
  assert.equal(product.variants[1].image, undefined);
  assert.equal(product.variants[2].image, 'https://m.com/base.jpg');
});

test('normalizeProduct: an invalid variant image is dropped silently, like product-level images', () => {
  const { product } = normalizeProduct({
    name: 'T-Shirt',
    price: 19.99,
    variants: [{ option_values: { Color: 'Red' }, image: 'not-a-url' }],
  });
  assert.equal(product.variants[0].image, undefined);
  assert.deepEqual(product.images, []);
});

test('normalizeProduct: variants with no option_values are dropped with a warning, not the product', () => {
  const { product, warnings, error } = normalizeProduct({
    name: 'T-Shirt',
    price: 19.99,
    variants: [{ sku: 'TEE-1' }, { option_values: { Color: 'Red' } }],
  });
  assert.equal(error, undefined);
  assert.equal(product.variants.length, 1);
  assert.ok(warnings.some((w) => /variant 1 skipped/.test(w) && /no option_values/.test(w)));
});

test('normalizeProduct: duplicate variant option combos and SKUs are deduped (first wins)', () => {
  const { product, warnings } = normalizeProduct({
    name: 'T-Shirt',
    price: 19.99,
    variants: [
      { sku: 'TEE-RED-S', option_values: { Color: 'Red', Size: 'Small' } },
      { sku: 'TEE-RED-S-2', option_values: { color: 'red', size: 'small' } }, // same combo, case-insensitive
      { sku: 'TEE-RED-S', option_values: { Color: 'Blue', Size: 'Small' } }, // same sku, different combo
    ],
  });
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0].sku, 'TEE-RED-S');
  assert.ok(warnings.some((w) => /duplicate variant combo/.test(w)));
  assert.ok(warnings.some((w) => /duplicate variant SKU/.test(w)));
});

test('normalizeProduct: no variants field is fine and produces an empty array', () => {
  const { product, warnings } = normalizeProduct({ name: 'Mug', price: 9.99 });
  assert.deepEqual(product.variants, []);
  assert.equal(warnings.some((w) => /variant/.test(w)), false);
});

test('normalizeProduct picks up a brand name (incl. field-name variants) and defaults to empty', () => {
  const { product: p1 } = normalizeProduct({ name: 'Mug', price: 9.99, brand_name: 'Acme' });
  assert.equal(p1.brandName, 'Acme');

  const { product: p2 } = normalizeProduct({ name: 'Mug', price: 9.99, brand: 'Acme' });
  assert.equal(p2.brandName, 'Acme');

  const { product: p3 } = normalizeProduct({ name: 'Mug', price: 9.99 });
  assert.equal(p3.brandName, '');
});

test('normalizeProduct warns (but does not drop) when more than 2 categories are given', () => {
  const { warnings } = normalizeProduct({
    name: 'Mug',
    price: 9.99,
    categories: ['Kitchen', 'Drinkware', 'Gifts'],
  });
  assert.ok(warnings.some((w) => /3 categories/.test(w)));
});

test('normalizeCatalog drops invalid entries and applies the limit', () => {
  const raw = [
    { name: 'A', price: 1 },
    { price: 2 }, // no name -> dropped
    { name: 'B', price: 3 },
    { name: 'C', price: 4 },
  ];
  const { products, errors, dropped } = normalizeCatalog(raw, { limit: 2 });
  assert.equal(products.length, 2);
  assert.equal(products[0].name, 'A');
  assert.equal(products[1].name, 'B');
  assert.equal(errors.length, 1);
  assert.equal(dropped, 1); // "C" truncated by the limit
});
