/**
 * Resolve product brand-name strings to BigCommerce Brand ids.
 *
 * A brand is a store-wide entity (not scoped to a category tree or channel),
 * matched by name only, accent/case-insensitive — the same folding used for
 * category/product name matching elsewhere. Unlike categories/products,
 * brand resolution ignores `--on-existing`: a brand isn't the thing being
 * imported, it's an attribute products point at, so it's always reused when
 * it already exists and only ever created once per distinct name — even
 * across two differently-cased names in the same run (e.g. "Nike" and
 * "NIKE") — so a catalog import can never leave the store with duplicate
 * brand records for what's really one brand.
 */

import { foldName } from './util.js';

const PAGE_SIZE = 250;

/** Fetch all existing brands, keyed by folded name for idempotent matching. */
export async function getExistingBrands(client) {
  let page = 1;
  const list = [];
  for (;;) {
    const batch = (await client.get(`/catalog/brands?limit=${PAGE_SIZE}&page=${page}`)) || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page += 1;
  }
  const byKey = new Map();
  for (const b of list) {
    const key = foldName(b.name);
    if (!byKey.has(key)) byKey.set(key, b);
  }
  return { list, byKey };
}

/**
 * Resolve a list of brand names to BigCommerce brand ids, reusing any
 * existing brand that matches by folded name and creating the rest — at most
 * once per distinct folded name, regardless of how many differently-cased
 * duplicates appear in `names`.
 *
 * @param {import('./client.js').BigCommerceClient} client
 * @param {string[]} names  distinct-ish brand names referenced by the catalog
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  log what would be created; never write
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Map<string, number>>} name -> brand id (missing entries in
 *   dry-run mode, since no real id exists yet)
 */
export async function resolveBrands(client, names, opts = {}) {
  const { dryRun = false, log = () => {} } = opts;
  const idByName = new Map();
  if (!names.length) return idByName;

  const { byKey: existingByKey } = await getExistingBrands(client);
  const createdByKey = new Map();

  for (const name of names) {
    const key = foldName(name);
    const existing = existingByKey.get(key);
    if (existing) {
      idByName.set(name, existing.id);
      continue;
    }

    const alreadyCreated = createdByKey.get(key);
    if (alreadyCreated != null) {
      idByName.set(name, alreadyCreated);
      continue;
    }

    if (dryRun) {
      log(`  would create brand "${name}"`);
      continue;
    }

    const created = await client.post('/catalog/brands', { name });
    if (created?.id != null) {
      idByName.set(name, created.id);
      createdByKey.set(key, created.id);
      log(`  created brand "${name}" (id ${created.id})`);
    }
  }

  return idByName;
}
