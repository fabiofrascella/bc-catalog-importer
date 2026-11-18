/**
 * Resolve the 1-2 category names each product carries against the category
 * tree that's just been pushed (bigcommerce/categories.js's `pushTree`) —
 * a genuinely different problem from that tree push, so it's kept as its own
 * module rather than folded into it:
 *
 *   - pushTree reconciles a real, nested tree it was just handed 1:1
 *     (parent-scoped exact match — a "Sale" under Men is distinct from a
 *     "Sale" under Women).
 *   - This module reconciles loose, independently-authored category-name
 *     *strings* off of products against that tree, with no parent context to
 *     go on — so it needs fuzzy/plural matching, tree-wide, and only creates
 *     new leaf categories flat under a single catch-all parent (see below).
 *
 * Matching is tiered, cheapest/most-confident first:
 *   1. exact (accent/case-insensitive)
 *   2. plural-insensitive ("Backpack" == "Backpacks")
 *   3. fuzzy (Levenshtein similarity >= threshold, punctuation-insensitive)
 * Only names that clear none of those get queued for creation.
 *
 * Every product is also assigned to a store-wide "catch-all" category (e.g.
 * "Shop All" / "All Products" / "Products" — whichever already exists; see
 * findCatchAllCategory), and any *newly created* category (for a product tag
 * that didn't match anything in the tree) nests under that same catch-all
 * instead of the tree root, so ad hoc product-only categories land somewhere
 * visually consistent rather than at the top level.
 *
 * A product is also assigned to every *ancestor* of each category it matched
 * or was newly filed under, up to that ancestor chain's top-level category
 * (see withAncestorIds) — BigCommerce doesn't do this implicitly, so a
 * product tagged only with a deep category (e.g. "Daypacks" under
 * "Backpacks") would otherwise never show up browsing "Backpacks" itself.
 */

import { foldName, fuzzyFold, singularize, similarity, chunked, slugify } from './util.js';

const BATCH_SIZE = 50;
const FUZZY_THRESHOLD = 0.82;

// Priority order of conventional "browse everything" category names to look
// for in the store before falling back to creating one.
const CATCH_ALL_CANDIDATES = ['shop all', 'all products', 'products', 'all'];
export const CATCH_ALL_FALLBACK_NAME = 'Shop All';

/**
 * Pure matching: for each name, find the best existing category (if any), so
 * the caller can preview reuse-vs-create before writing anything.
 *
 * Matching is by name only, across the whole tree regardless of depth/parent
 * — two unrelated categories that happen to share (or nearly share) a name
 * will collide; the best-scoring existing category wins.
 *
 * @param {Array} existingList  categories from trees.js's getExistingCategories()
 * @param {string[]} names  distinct category names referenced by the catalog
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.82]  minimum fuzzy similarity to count as a match
 * @returns {{ matches: Map<string, {category: object, method: 'exact'|'plural'|'fuzzy', score: number}>, unmatched: string[] }}
 */
export function matchCategories(existingList, names, opts = {}) {
  const { threshold = FUZZY_THRESHOLD } = opts;

  const byExact = new Map();
  const bySingular = new Map();
  for (const cat of existingList) {
    const exactKey = foldName(cat.name);
    if (!byExact.has(exactKey)) byExact.set(exactKey, cat);
    const singularKey = singularize(fuzzyFold(cat.name));
    if (!bySingular.has(singularKey)) bySingular.set(singularKey, cat);
  }

  const matches = new Map();
  const unmatched = [];

  for (const name of names) {
    const exact = byExact.get(foldName(name));
    if (exact) {
      matches.set(name, { category: exact, method: 'exact', score: 1 });
      continue;
    }

    const singular = bySingular.get(singularize(fuzzyFold(name)));
    if (singular) {
      matches.set(name, { category: singular, method: 'plural', score: 1 });
      continue;
    }

    const folded = fuzzyFold(name);
    let best = null;
    for (const cat of existingList) {
      const score = similarity(folded, fuzzyFold(cat.name));
      if (score >= threshold && (!best || score > best.score)) {
        best = { category: cat, score };
      }
    }
    if (best) {
      matches.set(name, { category: best.category, method: 'fuzzy', score: best.score });
    } else {
      unmatched.push(name);
    }
  }

  return { matches, unmatched };
}

/**
 * Find the store's existing "browse everything" category, if any, checking
 * CATCH_ALL_CANDIDATES in priority order (exact name match only — this is a
 * conventional, recognizable name, not something to fuzzy-guess at).
 *
 * @param {Array} existingList  categories from trees.js's getExistingCategories()
 * @returns {object|null} the matching existing category, or null if none exist
 */
export function findCatchAllCategory(existingList) {
  for (const candidate of CATCH_ALL_CANDIDATES) {
    const match = existingList.find((cat) => foldName(cat.name) === candidate);
    if (match) return match;
  }
  return null;
}

/**
 * Create categories that had no existing match, flat, all under one parent
 * (the catch-all) — unlike pushTree, this never builds a multi-level
 * hierarchy, since a bare product category-name string carries no nesting
 * information.
 *
 * @param {import('./client.js').BigCommerceClient} client
 * @param {string[]} names  category names to create (already known to be missing)
 * @param {object} opts
 * @param {number} opts.treeId
 * @param {number} [opts.parentId=0]  parent category id for all of these (0 = tree root)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Map<string, number>>} name -> newly created category id
 */
export async function createCategories(client, names, opts) {
  const { treeId, parentId = 0, log = () => {} } = opts;
  const idByName = new Map();
  if (!names.length) return idByName;

  for (const chunk of chunked(names, BATCH_SIZE)) {
    const payload = chunk.map((name) => ({
      tree_id: treeId,
      parent_id: parentId,
      name,
      is_visible: true,
      url: { path: `/${slugify(name)}`, is_customized: true },
    }));
    const created = (await client.post('/catalog/trees/categories', payload)) || [];
    const returned = Array.isArray(created) ? created : [];
    const returnedByKey = new Map(returned.map((c) => [foldName(c.name), c]));
    for (const name of chunk) {
      const match = returnedByKey.get(foldName(name));
      const id = match?.category_id ?? match?.id;
      if (id != null) {
        idByName.set(name, id);
        log(`  created category "${name}" (id ${id})`);
      }
    }
  }

  return idByName;
}

/**
 * Walk a category id up to the top of the tree via `parentById` (category id
 * -> its parent id, with a top-level category's parent being 0/root), and
 * return that id plus every ancestor up to (and including) the level-one
 * category — but not the virtual root itself.
 *
 * A product tagged with a deep category (e.g. "Daypacks" under "Backpacks")
 * is assigned to *all* of those, not just the leaf, so it also surfaces when
 * browsing the ancestor category — standard e-commerce merchandising
 * behavior, and needed here because BigCommerce doesn't infer it: assigning a
 * product to a child category does not implicitly include it in the parent's
 * listing.
 *
 * @param {number} categoryId
 * @param {Map<number, number>} parentById
 * @returns {number[]} categoryId and every ancestor up to the top-level one, no duplicates
 */
export function withAncestorIds(categoryId, parentById) {
  const ids = [];
  const seen = new Set();
  let current = categoryId;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    ids.push(current);
    const parent = parentById.get(current);
    if (parent == null || parent === 0) break;
    current = parent;
  }
  return ids;
}
