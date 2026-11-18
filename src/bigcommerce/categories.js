/**
 * Create the extracted category hierarchy in a BigCommerce category tree.
 *
 * Categories are created breadth-first (level by level) so that every parent
 * id exists before its children reference it. Creates are batched via
 * POST /catalog/trees/categories in chunks of <= 50.
 *
 * The --on-existing strategy governs collisions with categories already in the
 * tree (matched by parent_id + name):
 *   - skip     : reuse the existing id, create only what's missing (idempotent)
 *   - create   : always create (may duplicate)
 *   - recreate : delete the tree's categories first, then create fresh
 *
 * Unlike POST /catalog/products (one request per product), this endpoint
 * creates a whole batch (up to 50 categories) in a single request. A bad
 * `image_url` anywhere in it 422s the *overall* response — but, important
 * and non-obvious, that does **not** mean the rest of the batch was never
 * written: BigCommerce's bulk category-create isn't fully atomic, and valid
 * entries in the same request can still get silently created server-side
 * despite the call returning an error with no `data` for any of them. Two
 * layers guard against this: each node's image is pre-checked
 * (products/images.js's `checkImage`) before it's even sent, so a bad one
 * ideally never reaches the API at all; and if a batch still 422s, `createBatch`
 * re-fetches what's actually in the tree *before* retrying, so only entries
 * confirmed still-missing are resent (with the image stripped, for an
 * image-related failure) — never the whole original chunk, which would
 * otherwise 422 again on "duplicate category name" for whatever silently
 * went through the first time.
 */

import { getExistingCategories, categoryKey } from './trees.js';
import { chunked, slugify } from './util.js';
import { checkImage } from '../products/images.js';

const BATCH_SIZE = 50;
// Matches BigCommerce's "File is not a valid image" / "field 'image_url' is
// invalid" / unsupported-format 4xx on this endpoint — the same family of
// image failures products.js already retries around, just batch-shaped here.
const IMAGE_ERROR = /not a valid image|field 'image_url' is invalid|size limit.*exceeded|format is not supported/i;

/**
 * @param {import('./client.js').BigCommerceClient} client
 * @param {Array} tree  normalized category nodes
 * @param {object} opts
 * @param {number} opts.treeId
 * @param {'skip'|'create'|'recreate'} [opts.strategy='skip']
 * @param {string[]} [opts.include]  which extra fields to send: images/descriptions/urls
 * @param {boolean} [opts.dryRun=false]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ created: number, skipped: number, deleted: number }>}
 */
export async function pushTree(client, tree, opts) {
  const {
    treeId,
    strategy = 'skip',
    include = ['images', 'descriptions', 'urls'],
    dryRun = false,
    log = () => {},
  } = opts;

  const stats = { created: 0, skipped: 0, deleted: 0 };

  let existingByKey = new Map();
  if (strategy === 'recreate') {
    stats.deleted = await deleteTreeCategories(client, treeId, { dryRun, log });
  } else if (strategy === 'skip') {
    const { byKey } = await getExistingCategories(client, treeId);
    existingByKey = byKey;
  }

  // Queue of nodes to process, each carrying its resolved BigCommerce parent id.
  let level = tree.map((node) => ({ node, parentId: 0 }));

  while (level.length) {
    const next = [];
    const toCreate = []; // { node, payload }

    for (const { node, parentId } of level) {
      const key = categoryKey(parentId, node.name);

      if (strategy === 'skip' && existingByKey.has(key)) {
        const existing = existingByKey.get(key);
        stats.skipped += 1;
        enqueueChildren(next, node, existing.category_id ?? existing.id);
        continue;
      }

      toCreate.push({ node, parentId });
    }

    // Pre-check every to-create node's image once per level, before any
    // payload is built — same size/format rules as product images, so a bad
    // one never reaches the batch-validated endpoint in the first place.
    if (include.includes('images')) {
      await Promise.all(
        toCreate.map(async (entry) => {
          if (!entry.node.image) return;
          const result = await checkImage(entry.node.image);
          if (!result.sizeOk || !result.formatOk) {
            const reason = !result.sizeOk
              ? `oversized (${(result.bytes / (1024 * 1024)).toFixed(1)} MB > 8 MB limit)`
              : `unsupported format (${result.contentType})`;
            log(`  "${entry.node.name}": dropping invalid category image, ${reason}: ${entry.node.image}`);
            entry.imageOverride = null;
          }
        }),
      );
    }
    for (const entry of toCreate) {
      const node = 'imageOverride' in entry ? { ...entry.node, image: entry.imageOverride } : entry.node;
      entry.payload = buildPayload(node, treeId, entry.parentId, include);
    }

    // Create this level's missing nodes in batches, then descend.
    for (const chunk of chunked(toCreate, BATCH_SIZE)) {
      if (dryRun) {
        for (const { node, parentId } of chunk) {
          log(`  would create "${node.name}" (parent ${parentId})`);
          stats.created += 1;
          // No real id in dry-run; use a placeholder so children still enqueue.
          enqueueChildren(next, node, `dry:${node.name}`);
        }
        continue;
      }

      const { created, existing } = await createBatch(client, treeId, chunk, log);
      stats.created += chunk.length;

      // Match each input back to its id — either freshly returned by the
      // create call, or (see createBatch) discovered to already exist.
      const idByKey = new Map();
      for (const c of created) idByKey.set(categoryKey(c.parent_id ?? 0, c.name), c);
      for (const { entry, match } of existing) {
        idByKey.set(categoryKey(entry.parentId, entry.node.name), match);
      }
      for (const { node, parentId } of chunk) {
        const match = idByKey.get(categoryKey(parentId, node.name));
        const newId = match?.category_id ?? match?.id;
        if (newId != null) enqueueChildren(next, node, newId);
      }
    }

    level = next;
  }

  return stats;
}

/**
 * POST one batch. BigCommerce's bulk category-create endpoint turns out not
 * to be fully atomic: a 422 that names only *some* indices as invalid (e.g.
 * bad images) does not guarantee the rest of the batch was never written —
 * in practice, the valid entries in the same request can still get created
 * even though the overall call comes back as an error with no `data` for
 * any of them. Naively retrying with the *whole* original chunk (even after
 * fixing the named-bad entries) then 422s again on "duplicate category
 * name" for everything that silently went through the first time.
 *
 * So on any failure, re-fetch what's actually in the tree now before
 * deciding what's still safe to (re)send — only genuinely-missing entries
 * are retried, and an image-related failure additionally strips the image
 * from those (the same recovery as before, just scoped correctly now).
 */
async function createBatch(client, treeId, chunk, log) {
  try {
    const created = await client.post(
      '/catalog/trees/categories',
      chunk.map((c) => c.payload),
    );
    return { created: Array.isArray(created) ? created : [], existing: [] };
  } catch (err) {
    const { byKey: freshExisting } = await getExistingCategories(client, treeId);

    const stillMissing = [];
    const existing = [];
    for (const entry of chunk) {
      const match = freshExisting.get(categoryKey(entry.parentId, entry.node.name));
      if (match) existing.push({ entry, match });
      else stillMissing.push(entry);
    }

    if (existing.length) {
      log(
        `  ${existing.length} categor${existing.length === 1 ? 'y was' : 'ies were'} already created ` +
          `despite the failed batch create (${existing.map((e) => `"${e.entry.node.name}"`).join(', ')}) ` +
          `— reusing instead of recreating.`,
      );
    }

    if (!stillMissing.length) {
      return { created: [], existing }; // the whole batch had actually gone through
    }
    if (!existing.length && !IMAGE_ERROR.test(err.message)) {
      throw err; // a genuine, unrecovered failure — nothing to salvage
    }

    if (IMAGE_ERROR.test(err.message)) {
      for (const entry of stillMissing) {
        if (entry.payload.image_url == null) continue;
        log(`  "${entry.node.name}": create failed on its image — retrying without it (${err.message})`);
        delete entry.payload.image_url;
      }
    }

    const retried = await client.post(
      '/catalog/trees/categories',
      stillMissing.map((c) => c.payload),
    );
    return { created: Array.isArray(retried) ? retried : [], existing };
  }
}

function enqueueChildren(queue, node, parentId) {
  for (const child of node.children || []) {
    queue.push({ node: child, parentId });
  }
}

/** Build the create payload for one category, honoring the --include set. */
function buildPayload(node, treeId, parentId, include) {
  const payload = {
    tree_id: treeId,
    parent_id: parentId,
    name: node.name,
    is_visible: true,
  };
  if (include.includes('descriptions') && node.description) {
    payload.description = node.description;
  }
  if (include.includes('images') && node.image) {
    payload.image_url = node.image;
  }
  // BigCommerce requires a non-empty URL path on this endpoint. Prefer a cleaned
  // merchant slug (source platform prefix like /collections/ stripped); fall
  // back to a slug derived from the name.
  let path = '';
  if (include.includes('urls') && node.url) path = toPath(node.url);
  if (!path) path = `/${slugify(node.name)}`;
  payload.url = { path, is_customized: true };
  return payload;
}

/**
 * Source-platform URL path prefixes to strip so BigCommerce categories get a
 * clean slug (e.g. Shopify's "/collections/ordenadores" -> "/ordenadores").
 */
const PLATFORM_PREFIXES = new Set([
  'collections', 'collection', 'category', 'categories', 'product-category',
  'c', 'shop', 'store', 'departments', 'catalog', 'catalogue',
]);

/** Reduce a URL to a clean store-relative path, dropping a platform prefix. */
function toPath(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.startsWith('/') ? url : `/${url}`;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length && PLATFORM_PREFIXES.has(segments[0].toLowerCase())) {
    segments.shift();
  }
  return segments.length ? `/${segments.join('/')}` : '';
}

/** Delete all root categories in a tree (children cascade). */
async function deleteTreeCategories(client, treeId, { dryRun, log }) {
  const { list } = await getExistingCategories(client, treeId);
  const roots = list.filter((c) => (c.parent_id ?? 0) === 0);
  if (!roots.length) return 0;

  const ids = roots.map((c) => c.category_id ?? c.id).filter((id) => id != null);
  if (dryRun) {
    log(`  would delete ${ids.length} existing root categories (children cascade)`);
    return ids.length;
  }
  for (const chunk of chunked(ids, BATCH_SIZE)) {
    await client.delete(`/catalog/trees/categories?category_id:in=${chunk.join(',')}`);
  }
  log(`Deleted ${ids.length} existing root categories.`);
  return ids.length;
}
