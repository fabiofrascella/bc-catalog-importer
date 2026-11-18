/**
 * Category-tree resolution.
 *
 * In BigCommerce's multi-storefront model, categories live in a category tree,
 * and a tree is assigned to one or more channels. To create categories for a
 * channel we first need that channel's tree id — resolving an existing one or
 * creating and assigning a new tree.
 *
 * `--channel` is mandatory for any real push (enforced in index.js before this
 * is ever called) specifically so this never has to guess: an omitted channel
 * used to mean "fall back to the store's first tree, or create an unassigned
 * one," which silently created/matched categories in the wrong tree when the
 * channel was left out of one run but not another. There is no such fallback
 * here — every write always targets the one tree resolved from `channelId`.
 */

import { foldName } from './util.js';

/**
 * Find the tree assigned to `channelId`, or create one assigned to it.
 * @param {import('./client.js').BigCommerceClient} client
 * @param {number} channelId
 * @param {object} [opts]
 * @param {string} [opts.name]  name to use if a tree must be created
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<number>} tree id
 */
export async function resolveTreeId(client, channelId, opts = {}) {
  const { log = () => {} } = opts;
  const channel = Number(channelId);
  if (!Number.isInteger(channel)) {
    throw new Error(`Invalid channel id: ${channelId}`);
  }

  const trees = (await client.get('/catalog/trees')) || [];
  const existing = trees.find((t) => (t.channels || []).includes(channel));
  if (existing) {
    log(`Using existing category tree ${existing.id} ("${existing.name}") for channel ${channel}.`);
    return existing.id;
  }

  const name = opts.name || `Catalog (channel ${channel})`;
  log(`No tree assigned to channel ${channel}; creating one…`);
  const created = await client.put('/catalog/trees', [{ name, channels: [channel] }]);
  const tree = Array.isArray(created) ? created[0] : created;
  if (!tree?.id) {
    throw new Error('Failed to create category tree — no id returned.');
  }
  log(`Created category tree ${tree.id} ("${name}").`);
  return tree.id;
}

/**
 * Fetch all existing categories in a tree, keyed for name+parent lookup.
 * @param {import('./client.js').BigCommerceClient} client
 * @param {number} treeId
 * @returns {Promise<{ list: Array, byKey: Map<string, object> }>}
 */
export async function getExistingCategories(client, treeId) {
  let page = 1;
  const roots = [];
  // The trees/categories endpoint is paginated; walk until a short page.
  for (;;) {
    const batch =
      (await client.get(`/catalog/trees/${treeId}/categories?limit=250&page=${page}`)) || [];
    roots.push(...batch);
    if (batch.length < 250) break;
    page += 1;
  }

  // The endpoint returns a NESTED tree (each node has `children`). Flatten it so
  // every existing category — at any depth — is indexed for idempotent matching.
  const list = [];
  const flatten = (nodes) => {
    for (const cat of nodes) {
      list.push(cat);
      if (Array.isArray(cat.children) && cat.children.length) flatten(cat.children);
    }
  };
  flatten(roots);

  const byKey = new Map();
  for (const cat of list) {
    byKey.set(categoryKey(cat.parent_id ?? 0, cat.name), cat);
  }
  return { list, byKey };
}

/**
 * Stable lookup key for matching a node to an existing category. Accent- and
 * case-insensitive to align with how BigCommerce normalises category names
 * (e.g. "Portátiles" and "Portatiles" are treated as the same).
 */
export function categoryKey(parentId, name) {
  return `${parentId}::${foldName(name)}`;
}
