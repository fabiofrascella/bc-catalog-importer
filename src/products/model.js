/**
 * Product model: the canonical shape shared across the file-loading and
 * BigCommerce layers.
 *
 * A normalized product is:
 *   { name, sku, skuGenerated: boolean, description, price, priceIsFake: boolean,
 *     brandName, images: string[], customFields: {name, value}[], categories: string[],
 *     variants: { sku, skuGenerated, optionValues: {name, value}[], priceOverride? }[] }
 *
 * This module takes the loosely-shaped JSON a chat AI ("cowork") produces and
 * turns it into that shape, tolerating common field-name variants. The only
 * hard requirement is `name` — a product missing that is dropped with a
 * reason; everything else is kept and just flagged in `warnings` so the
 * preview can surface it before push.
 *
 * `sku` is always populated: the merchant's own SKU/item number when the
 * source JSON has one, otherwise a random one generated from the product name
 * (`skuGenerated: true`) so every product still gets a usable identifier.
 *
 * `price` is always populated too: when the source has no usable price, it
 * gets a fake placeholder (`priceIsFake: true`) and the BigCommerce push
 * layer marks the product as not purchasable (`availability: "disabled"`)
 * instead of dropping it — real catalog data, thin pricing.
 *
 * `categories` holds plain category *names* (e.g. "Backpacks") straight out of
 * the JSON — resolving those to BigCommerce category ids (creating any that
 * don't exist) happens later, at push time, in bigcommerce/categories.js.
 *
 * `brandName` is the plain brand name straight out of the JSON, or '' if the
 * source had none — resolving it to a BigCommerce Brand id (reusing an
 * existing brand by name, creating one only if genuinely missing, never
 * duplicating) happens later, at push time, in bigcommerce/brands.js.
 *
 * `variants` is optional (most products have none) — real BigCommerce option
 * combinations (e.g. Color × Size) of the *same* product, sharing its
 * description/images/categories. A malformed variant entry (no option_values)
 * or a duplicate (same option combo, or same SKU as another variant) is
 * dropped with a warning rather than failing the product; each surviving
 * variant always gets a SKU the same way the product itself does.
 *
 * A variant's own `image` (BigCommerce links a variant to a specific photo by
 * URL match against the product's own image gallery — there's no separate
 * per-variant upload) is folded into the product's `images` array here if it
 * isn't already there, so it's guaranteed to exist as one of the product's
 * uploaded images by the time bigcommerce/products.js references it.
 */

import { randomUUID } from 'node:crypto';

const TARGET_IMAGES = 2;
const TARGET_CUSTOM_FIELDS_MIN = 3;
const TARGET_CUSTOM_FIELDS_MAX = 4;
const TARGET_CATEGORIES_MIN = 1;
const TARGET_CATEGORIES_MAX = 2;
const FAKE_PRICE = 0;

/** Collapse whitespace and trim a raw string field. */
export function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Parse a price value (number or a currency-formatted string) into a number >= 0. */
export function parsePrice(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^0-9.-]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

// BigCommerce's catalog `image_url` field rejects anything longer than this.
const MAX_IMAGE_URL_LENGTH = 255;

/**
 * Turn a raw string into the canonical http(s) URL BigCommerce's `image_url`
 * field will accept, or undefined if it can't be made into one. Parsing
 * through the URL constructor (rather than a prefix regex) both rejects
 * anything BigCommerce would too (malformed host, stray whitespace it can't
 * percent-encode away, etc.) and fixes up minor issues — like an unescaped
 * space in a scraped filename — that would otherwise 422 at push time.
 */
function toHttpUrl(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.href.length <= MAX_IMAGE_URL_LENGTH ? url.href : undefined;
}

/** Pull a URL out of a string entry or an {url}/{src}/{image_url} object entry. */
function extractUrl(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    return String(entry.url || entry.src || entry.image_url || '').trim();
  }
  return '';
}

/** Normalize a raw images field (array of strings, or array of {url}/{src}) into a string[]. */
export function normalizeImages(raw) {
  if (!Array.isArray(raw)) return [];
  const urls = raw.map(extractUrl).map(toHttpUrl).filter(Boolean);
  return [...new Set(urls)];
}

/** Normalize a single raw image field (string, or {url}/{src}/{image_url}) into a URL or undefined. */
export function normalizeImage(raw) {
  return toHttpUrl(extractUrl(raw));
}

/**
 * Shared name/value pair parsing for fields that accept either an object map
 * ({ Material: "Cotton" }) or an array of pairs. `nameKeys`/`valueKeys` widen
 * which raw property names count as the name/value on array-of-object input.
 */
function normalizeNamedPairs(raw, { nameKeys = ['name', 'key'], valueKeys = ['value'] } = {}) {
  const pairs = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const name = cleanText(nameKeys.map((k) => entry[k]).find((v) => v));
      const rawValue = valueKeys.map((k) => entry[k]).find((v) => v != null);
      const value = cleanText(String(rawValue ?? ''));
      if (name && value) pairs.push({ name, value });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      const cleanedName = cleanText(name);
      const cleanedValue = cleanText(String(value ?? ''));
      if (cleanedName && cleanedValue) pairs.push({ name: cleanedName, value: cleanedValue });
    }
  }

  // Dedupe by name (case-insensitive), last one wins.
  const byName = new Map();
  for (const pair of pairs) byName.set(pair.name.toLowerCase(), pair);
  return [...byName.values()];
}

/**
 * Normalize a raw custom-fields field into a [{name, value}] array.
 * Accepts either an object map ({ Material: "Cotton" }) or an array of
 * {name, value} / {key, value} pairs. Drops empty/duplicate names — BigCommerce
 * rejects duplicate custom_field names on the same product.
 */
export function normalizeCustomFields(raw) {
  return normalizeNamedPairs(raw);
}

/**
 * Normalize a raw variant option-values field into a [{name, value}] array,
 * e.g. { Color: "Red", Size: "Large" }. Also accepts an array of
 * {name, value} / {option_display_name, label} pairs.
 */
export function normalizeOptionValues(raw) {
  return normalizeNamedPairs(raw, {
    nameKeys: ['name', 'key', 'option_display_name'],
    valueKeys: ['value', 'label'],
  });
}

/**
 * Normalize a raw brand field into a single brand name string, or '' if none.
 * Accepts a plain string, or (tolerating the array shape some chats produce
 * for a single value) an array — the first non-empty string entry is used.
 */
export function normalizeBrandName(raw) {
  const value = Array.isArray(raw) ? raw.find((v) => cleanText(v)) : raw;
  return cleanText(typeof value === 'string' ? value : '');
}

/**
 * Normalize a raw categories field into a string[] of category names.
 * Accepts an array of strings, an array of {name}, or a single string
 * (via the singular "category" field). Dedupes case-insensitively.
 */
export function normalizeCategories(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
  const names = list
    .map((c) => cleanText(typeof c === 'string' ? c : c?.name))
    .filter(Boolean);

  const byKey = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()];
}

/**
 * Generate a random-but-readable SKU from a product name, for products whose
 * source JSON didn't carry one. Not guaranteed globally unique, but collision
 * odds are negligible for a demo catalog (8 hex chars of randomness).
 */
export function generateSku(name) {
  const prefix = cleanText(name).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'SKU';
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `${prefix}-${suffix}`;
}

/** Stable key for a variant's option-value combo, order-independent. */
function optionValuesKey(optionValues) {
  return optionValues
    .map((o) => `${o.name.toLowerCase()}:${o.value.toLowerCase()}`)
    .sort()
    .join('|');
}

/**
 * Normalize one raw variant entry.
 * @returns {{ variant?: object, error?: string }}
 */
function normalizeVariant(raw, productName) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };

  const optionValues = normalizeOptionValues(raw.option_values ?? raw.optionValues ?? raw.options);
  if (!optionValues.length) return { error: 'no option_values' };

  const comboLabel = optionValues.map((o) => o.value).join(' ');
  const merchantSku = cleanText(raw.sku);
  const sku = merchantSku || generateSku(`${productName} ${comboLabel}`);
  const skuGenerated = !merchantSku;

  const parsedPrice = parsePrice(raw.price);
  const variant = { sku, skuGenerated, optionValues };
  if (parsedPrice != null) variant.priceOverride = parsedPrice;

  const image = normalizeImage(raw.image ?? raw.image_url ?? raw.imageUrl);
  if (image) variant.image = image;

  return { variant };
}

/**
 * Normalize a raw variants field into a validated, deduped variant list.
 * Drops (with a warning, not a hard error) any entry with no option_values,
 * any duplicate option-value combo, and any duplicate SKU — first occurrence
 * wins in both cases.
 *
 * @param {Array} raw
 * @param {string} productName  for warning messages and auto-generated SKUs
 * @returns {{ variants: object[], warnings: string[] }}
 */
export function normalizeVariants(raw, productName) {
  const list = Array.isArray(raw) ? raw : [];
  const variants = [];
  const warnings = [];
  const seenCombos = new Set();
  const seenSkus = new Set();

  list.forEach((rawVariant, i) => {
    const { variant, error } = normalizeVariant(rawVariant, productName);
    if (error) {
      warnings.push(`"${productName}": variant ${i + 1} skipped (${error})`);
      return;
    }

    const comboKey = optionValuesKey(variant.optionValues);
    if (seenCombos.has(comboKey)) {
      const combo = variant.optionValues.map((o) => `${o.name}=${o.value}`).join(', ');
      warnings.push(`"${productName}": duplicate variant combo skipped (${combo})`);
      return;
    }
    const skuKey = variant.sku.toLowerCase();
    if (seenSkus.has(skuKey)) {
      warnings.push(`"${productName}": duplicate variant SKU skipped (${variant.sku})`);
      return;
    }

    seenCombos.add(comboKey);
    seenSkus.add(skuKey);
    variants.push(variant);
  });

  return { variants, warnings };
}

/**
 * Normalize one raw product entry.
 * @returns {{ product?: object, warnings: string[], error?: string }}
 */
export function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') {
    return { warnings: [], error: 'entry is not an object' };
  }

  const name = cleanText(raw.name ?? raw.title);
  if (!name) return { warnings: [], error: 'missing "name"' };

  const parsedPrice = parsePrice(raw.price);
  const priceIsFake = parsedPrice == null;
  const price = priceIsFake ? FAKE_PRICE : parsedPrice;

  const description = cleanText(raw.description ?? raw.body ?? raw.body_html);
  const merchantSku = cleanText(raw.sku ?? raw.item_number ?? raw.itemNumber ?? raw.product_code ?? raw.productCode);
  const sku = merchantSku || generateSku(name);
  const skuGenerated = !merchantSku;
  const brandName = normalizeBrandName(raw.brand_name ?? raw.brandName ?? raw.brand);
  const baseImages = normalizeImages(raw.images ?? raw.image_urls ?? raw.photos);
  const customFields = normalizeCustomFields(raw.custom_fields ?? raw.customFields ?? raw.attributes);
  const categories = normalizeCategories(raw.categories ?? raw.category ?? raw.collections);
  const { variants, warnings: variantWarnings } = normalizeVariants(raw.variants, name);

  // A variant's image has to exist in the product's own gallery for BigCommerce
  // to link it (see normalizeVariant) — fold in any variant-only images, after
  // the product's own so the thumbnail (images[0]) stays a real base photo.
  const variantImages = variants.map((v) => v.image).filter(Boolean);
  const images = [...new Set([...baseImages, ...variantImages])];

  const warnings = [...variantWarnings];
  if (priceIsFake) {
    warnings.push(
      `"${name}": no usable price — set a fake $${FAKE_PRICE.toFixed(2)} and marked not purchasable`,
    );
  }
  if (!description) warnings.push(`"${name}": no description`);
  if (images.length < TARGET_IMAGES) {
    warnings.push(`"${name}": only ${images.length} image(s) (target ${TARGET_IMAGES}+)`);
  }
  if (customFields.length < TARGET_CUSTOM_FIELDS_MIN) {
    warnings.push(
      `"${name}": only ${customFields.length} custom field(s) (target ${TARGET_CUSTOM_FIELDS_MIN}-${TARGET_CUSTOM_FIELDS_MAX})`,
    );
  }
  if (categories.length < TARGET_CATEGORIES_MIN) {
    warnings.push(`"${name}": no categories (target ${TARGET_CATEGORIES_MIN}-${TARGET_CATEGORIES_MAX})`);
  } else if (categories.length > TARGET_CATEGORIES_MAX) {
    warnings.push(
      `"${name}": ${categories.length} categories (target ${TARGET_CATEGORIES_MIN}-${TARGET_CATEGORIES_MAX}, all will still be assigned)`,
    );
  }

  return {
    product: {
      name,
      sku,
      skuGenerated,
      description,
      price,
      priceIsFake,
      brandName,
      images,
      customFields,
      categories,
      variants,
    },
    warnings,
  };
}

/**
 * Normalize a raw catalog (array of loosely-shaped product entries) and cap it
 * to `limit` products.
 *
 * @param {Array} rawEntries
 * @param {object} [opts]
 * @param {number} [opts.limit=Infinity]
 * @returns {{ products: object[], warnings: string[], errors: string[], dropped: number }}
 */
export function normalizeCatalog(rawEntries, opts = {}) {
  const { limit = Infinity } = opts;
  const products = [];
  const warnings = [];
  const errors = [];
  let dropped = 0;

  for (const raw of rawEntries) {
    if (products.length >= limit) {
      dropped += 1;
      continue;
    }
    const { product, warnings: w, error } = normalizeProduct(raw);
    if (error) {
      errors.push(error);
      continue;
    }
    products.push(product);
    warnings.push(...w);
  }

  return { products, warnings, errors, dropped };
}
