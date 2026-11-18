/**
 * Create the normalized product catalog in BigCommerce via Catalog API v3.
 *
 * Each product is created with its images and custom fields nested directly
 * in the POST /catalog/products payload (BigCommerce supports images,
 * custom_fields, and variants as create-time sub-resources — no separate
 * follow-up calls needed). Unlike the categories endpoint, POST /catalog/products
 * does not accept a batch/array body — one POST per product.
 *
 * `product.brandId` (resolved by index.js via bigcommerce/brands.js before this
 * is called, reusing/creating a Brand by name so the same name never produces
 * two Brand records) is sent as `brand_id` when present; a product whose
 * source data had no brand simply omits the field.
 *
 * The --on-existing strategy governs collisions with products already in the
 * store (matched by name, case/accent-insensitive):
 *   - skip     : reuse the existing product, create only what's missing (idempotent)
 *   - create   : always create (may duplicate)
 *   - recreate : delete matching existing products first, then create fresh
 *
 * With `channel` set, every product touched by this run (created, or matched
 * under --on-existing skip) is also assigned to that channel via
 * PUT /catalog/products/channel-assignments — being in a category tied to a
 * channel is not enough on its own for a product to actually list there.
 *
 * A product whose source data had no usable price (products/model.js sets
 * `priceIsFake`) is created with `availability: "disabled"` — BigCommerce's
 * "This product cannot be purchased in my online store" toggle — plus
 * `is_price_hidden: true` / `price_hidden_label: "Call for pricing"` so the
 * fake price never actually renders on the storefront. It still shows up in
 * the catalog/categories instead of being dropped.
 *
 * Each product's images are pre-checked against BigCommerce's 8 MB per-image
 * upload cap and its supported-format list (products/images.js) so an
 * oversized or unsupported (e.g. TIFF) image is dropped rather than failing
 * the whole create with a 4xx, and each URL is validated/canonicalized up
 * front in products/model.js so malformed ones (BigCommerce's `image_url`
 * field rejects those too) never reach the API at all. As a second line of
 * defense (the HEAD check can miss a case — redirects, no Content-Length/
 * Content-Type, etc. — and BigCommerce's own fetch-time validation can still
 * reject a URL that looked fine to us), a create that still fails on the size
 * cap, an unsupported format, or `image_url` being invalid is retried once
 * with no images at all, so one bad image URL can't sink the product.
 *
 * A product with `variants` (products/model.js normalizes/dedupes these —
 * real BigCommerce option combinations of the same product, e.g. Color ×
 * Size) gets them nested as create-time `variants`, and `inventory_tracking`
 * switches from "product" to "variant" so each combination is a distinct SKU
 * with its own stock count. Variants share the parent product's
 * description/categories — BigCommerce has no notion of per-variant category
 * placement — but a variant *can* show its own photo: products/model.js
 * folds any variant-specific `image` into the product's own gallery, and
 * buildPayload here links each variant to it via `image_url` (a URL match
 * against that gallery, not a separate upload) — as long as the image
 * survived the size pre-check above.
 *
 * Inventory levels: almost no merchant storefront exposes real stock counts
 * publicly, so there's no source data to carry through here the way there is
 * for price/sku/etc. Rather than import every demo product as permanently
 * untracked/zero-stock (which reads as a broken, empty-shelved store),
 * every product gets inventory tracking turned on with a random, plausible
 * starting level (`randomInventoryLevel`) — "product"-level (one count) for
 * a simple product, or one random count per variant for a product with
 * variants. This is explicitly fake data, the same spirit as the fake-price
 * placeholder above, just without a "not purchasable" flag to hide it behind
 * — there's no real-vs-fake distinction to preserve for a number that was
 * never real to begin with.
 */

import { foldName, chunked } from './util.js';
import { filterInvalidImages } from '../products/images.js';

const PAGE_SIZE = 250;
const CHANNEL_ASSIGN_BATCH_SIZE = 50;
// Plausible demo stock range — not real data (see module docstring).
const MIN_INVENTORY_LEVEL = 5;
const MAX_INVENTORY_LEVEL = 250;

/** A random, plausible starting inventory count — never real merchant data. */
function randomInventoryLevel() {
  return Math.floor(Math.random() * (MAX_INVENTORY_LEVEL - MIN_INVENTORY_LEVEL + 1)) + MIN_INVENTORY_LEVEL;
}
// Matches the "8 MB size limit... exceeded" 422, BigCommerce's
// "The field 'image_url' is invalid" 422 (e.g. a URL that looks well-formed to
// us but fails BigCommerce's own fetch/format check), and its "<mime> format
// is not supported by platform" 400 (an image type our pre-check missed or
// didn't recognize) — either way, the fix is the same: retry the create with
// no images rather than failing the product.
const IMAGE_ERROR = /size limit.*exceeded|field 'image_url' is invalid|format is not supported/i;
// BigCommerce enforces SKU uniqueness store-wide, independent of the
// --on-existing strategy (which only ever matches by *name* — see
// getExistingProducts below). A product whose SKU already belongs to some
// other, differently-named product 409s here; that's not a reason to abort
// the whole run, so it's skipped with a warning like any other per-product
// issue instead of throwing.
const SKU_CONFLICT_ERROR = /Sku .* is not unique/i;

/**
 * @param {import('./client.js').BigCommerceClient} client
 * @param {Array} products  normalized products (see products/model.js)
 * @param {object} opts
 * @param {'skip'|'create'|'recreate'} [opts.strategy='skip']
 * @param {string|number} [opts.channel]  channel id to list every touched product on
 * @param {boolean} [opts.dryRun=false]
 * @param {number} [opts.costMarginPercent]  if set, cost_price = price * (1 - this/100)
 *   for every product with a real (non-fake) price; omitted entirely otherwise, matching
 *   existing behavior (no cost_price sent)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ created: number, skipped: number, deleted: number, channelAssigned: number, imagesDropped: number, skuConflicts: number }>}
 */
export async function pushProducts(client, products, opts = {}) {
  const { strategy = 'skip', channel, dryRun = false, costMarginPercent, log = () => {} } = opts;
  const stats = {
    created: 0,
    skipped: 0,
    deleted: 0,
    channelAssigned: 0,
    imagesDropped: 0,
    skuConflicts: 0,
  };

  let existingByKey = new Map();
  if (strategy === 'recreate') {
    stats.deleted = await deleteMatching(client, products, { dryRun, log });
  } else if (strategy === 'skip') {
    ({ byKey: existingByKey } = await getExistingProducts(client));
  }

  const touchedIds = [];

  for (const product of products) {
    if (strategy === 'skip' && existingByKey.has(foldName(product.name))) {
      stats.skipped += 1;
      const existing = existingByKey.get(foldName(product.name));
      if (existing?.id != null) touchedIds.push(existing.id);
      continue;
    }

    if (dryRun) {
      log(`  would create "${product.name}"`);
      stats.created += 1;
      continue;
    }

    const images = await filterInvalidImages(product.images, { log });
    if (images.length !== product.images.length) {
      stats.imagesDropped += product.images.length - images.length;
    }

    let created;
    try {
      created = await client.post('/catalog/products', buildPayload({ ...product, images }, { costMarginPercent }));
    } catch (err) {
      if (IMAGE_ERROR.test(err.message) && images.length) {
        log(
          `  "${product.name}": create failed on an image field even after filtering — ` +
            `retrying with no images (${err.message})`,
        );
        stats.imagesDropped += images.length;
        created = await client.post(
          '/catalog/products',
          buildPayload({ ...product, images: [] }, { costMarginPercent }),
        );
      } else if (SKU_CONFLICT_ERROR.test(err.message)) {
        stats.skuConflicts += 1;
        log(
          `  "${product.name}": SKU "${product.sku}" is already used by a different product in ` +
            `the store — skipped (${err.message})`,
        );
        continue;
      } else {
        throw err;
      }
    }
    stats.created += 1;
    log(`  created "${product.name}"`);
    if (created?.id != null) touchedIds.push(created.id);
  }

  if (channel != null && touchedIds.length) {
    if (dryRun) {
      log(`  would assign ${touchedIds.length} product(s) to channel ${channel}`);
    } else {
      try {
        stats.channelAssigned = await assignToChannel(client, touchedIds, channel, { log });
      } catch (err) {
        log(`Warning: could not assign products to channel ${channel}: ${err.message}`);
      }
    }
  }

  return stats;
}

/** Assign product ids to a channel so they actually list on that storefront. */
async function assignToChannel(client, productIds, channel, { log }) {
  const channelId = Number(channel);
  if (!Number.isInteger(channelId)) throw new Error(`Invalid channel id: ${channel}`);

  for (const chunk of chunked(productIds, CHANNEL_ASSIGN_BATCH_SIZE)) {
    await client.put(
      '/catalog/products/channel-assignments',
      chunk.map((id) => ({ product_id: id, channel_id: channelId })),
    );
  }
  log(`Assigned ${productIds.length} product(s) to channel ${channelId}.`);
  return productIds.length;
}

/**
 * Build the create payload for one product, nesting images and custom fields.
 * @param {object} product
 * @param {object} [opts]
 * @param {number} [opts.costMarginPercent]  see pushProducts' jsdoc
 */
function buildPayload(product, opts = {}) {
  const { costMarginPercent } = opts;
  const payload = {
    name: product.name,
    type: 'physical',
    weight: 0,
    price: product.price,
    description: product.description,
    is_visible: true,
    inventory_tracking: 'product',
    inventory_level: randomInventoryLevel(),
  };
  payload.sku = product.sku;
  if (product.brandId != null) {
    payload.brand_id = product.brandId;
  }
  // Skip for a fake ($0.00, not-purchasable) price — there's no real price to take a
  // margin off of, and a non-zero cost above a $0.00 price would read as a negative margin.
  if (costMarginPercent != null && !product.priceIsFake) {
    payload.cost_price = Math.round(product.price * (1 - costMarginPercent / 100) * 100) / 100;
  }
  if (product.priceIsFake) {
    // BigCommerce's "This product cannot be purchased in my online store" toggle,
    // plus "Show 'Call for pricing' message instead of the price".
    payload.availability = 'disabled';
    payload.is_price_hidden = true;
    payload.price_hidden_label = 'Call for pricing';
  }
  if (product.images.length) {
    payload.images = product.images.map((url, i) => ({
      image_url: url,
      is_thumbnail: i === 0,
    }));
  }
  if (product.customFields.length) {
    payload.custom_fields = product.customFields.map((f) => ({ name: f.name, value: f.value }));
  }
  if (product.categoryIds?.length) {
    payload.categories = product.categoryIds;
  }
  if (product.variants?.length) {
    payload.inventory_tracking = 'variant';
    delete payload.inventory_level; // superseded by each variant's own level below
    // BigCommerce links a variant to a specific photo by URL match against the
    // product's own gallery, not a separate upload — only reference a variant's
    // image if it actually made it into the (possibly size-filtered) images
    // being sent for this product; otherwise the variant just falls back to
    // showing the product's default image.
    const uploadedImages = new Set(product.images);
    payload.variants = product.variants.map((v) => {
      const variantPayload = {
        sku: v.sku,
        inventory_level: randomInventoryLevel(),
        ...(v.priceOverride != null ? { price: v.priceOverride } : {}),
        option_values: v.optionValues.map((o) => ({ option_display_name: o.name, label: o.value })),
      };
      if (v.image && uploadedImages.has(v.image)) variantPayload.image_url = v.image;
      return variantPayload;
    });
  }
  return payload;
}

/** Fetch all existing products, keyed by normalized name for idempotent matching. */
export async function getExistingProducts(client) {
  let page = 1;
  const list = [];
  for (;;) {
    const batch = (await client.get(`/catalog/products?limit=${PAGE_SIZE}&page=${page}`)) || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page += 1;
  }
  const byKey = new Map();
  for (const p of list) byKey.set(foldName(p.name), p);
  return { list, byKey };
}

/** Delete existing products whose name matches one of `products`. */
async function deleteMatching(client, products, { dryRun, log }) {
  const { byKey } = await getExistingProducts(client);
  const ids = products
    .map((p) => byKey.get(foldName(p.name))?.id)
    .filter((id) => id != null);
  if (!ids.length) return 0;

  if (dryRun) {
    log(`  would delete ${ids.length} existing matching product(s)`);
    return ids.length;
  }
  for (const chunk of chunked(ids, PAGE_SIZE)) {
    await client.delete(`/catalog/products?id:in=${chunk.join(',')}`);
  }
  log(`Deleted ${ids.length} existing matching product(s).`);
  return ids.length;
}

export { MIN_INVENTORY_LEVEL, MAX_INVENTORY_LEVEL };
