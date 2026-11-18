#!/usr/bin/env node
/**
 * bc-catalog-importer — CLI entry point.
 *
 * Single-command flow: load a combined { categories, products } catalog JSON
 * (produced e.g. by a Claude chat — see PROMPT.md), preview both halves, gate
 * on confirmation, then create the category tree and the product catalog in
 * a BigCommerce demo store/channel via Catalog API v3.
 *
 *   bc-catalog-importer --from-json catalog.json --channel <id> [flags]
 *
 * See README.md for the full flag reference.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';

import {
  resolveBcCredentials,
  parseStrategy,
  parseLimit,
  parseDepth,
  parseInclude,
  parseCostMargin,
} from './config.js';
import { scrapeSite } from './scrape/index.js';
import { DEFAULT_MODEL } from './scrape/llmExtract.js';
import { normalizeTree, countNodes } from './tree/model.js';
import { printPreview as printTreePreview, summarize as summarizeTree } from './tree/preview.js';
import { normalizeCatalog } from './products/model.js';
import { printPreview as printProductPreview, summarize as summarizeProducts } from './products/preview.js';
import { BigCommerceClient } from './bigcommerce/client.js';
import { resolveTreeId, getExistingCategories } from './bigcommerce/trees.js';
import { pushTree } from './bigcommerce/categories.js';
import {
  matchCategories,
  findCatchAllCategory,
  createCategories,
  withAncestorIds,
  CATCH_ALL_FALLBACK_NAME,
} from './bigcommerce/productCategories.js';
import { pushProducts } from './bigcommerce/products.js';
import { resolveBrands } from './bigcommerce/brands.js';

const program = new Command();

program
  .name('bc-catalog-importer')
  .description(
    "Load a merchant category hierarchy and product catalog and create both in a " +
      'BigCommerce demo store/channel via Catalog API v3.',
  )
  .option('--from-json <file>', 'combined { categories, products } catalog JSON (see PROMPT.md)')
  .option(
    '--url <url>',
    'scrape categories live from this site instead of the "categories" in --from-json ' +
      '(products always come from --from-json)',
  )
  .option('--channel <id>', 'BigCommerce channel id to target — required for any real push')
  .option('--depth <n>', 'max category depth to keep when scraping (default: unlimited)')
  .option('--store <hash>', 'BigCommerce store hash (else BC_STORE_HASH)')
  .option('--token <token>', 'BigCommerce access token (else BC_ACCESS_TOKEN)')
  .option(
    '--env <name>',
    'named credential environment (else BC_ENV) — looked up in .env as ' +
      'BC_<NAME>_STORE_HASH/BC_<NAME>_ACCESS_TOKEN, then in ~/.bc-cli/config.json',
  )
  .option('--render', 'render JS-built menus with Playwright (only with --url)', false)
  .option('--use-llm', 'force the LLM extractor even if the parse looks fine (only with --url)', false)
  .option('--model <model>', 'LLM fallback model for category scraping', DEFAULT_MODEL)
  .option('--include <list>', 'category data to push: images,descriptions,urls', undefined)
  .option('--limit <n>', 'max number of products to import (default: all in file)')
  .option(
    '--cost-margin <percent>',
    'set every product\'s cost_price this % below its price (e.g. 20 → cost = 80% of price); ' +
      'omitted entirely for fake/not-purchasable prices. Default: not set, no cost_price sent',
  )
  .option(
    '--catch-all <name>',
    'catch-all category every product also joins (else auto-detected: "Shop All" / ' +
      '"All Products" / "Products" / "All", creating "Shop All" if none of those exist)',
  )
  .option('--on-existing <strategy>', 'skip | create | recreate — applies to both categories and products', 'skip')
  .option('--dry-run', 'preview only; never write to the store', false)
  .option('--out <file>', 'also save the normalized { categories, products } to a JSON file')
  .option('--yes', 'skip the confirmation prompt', false)
  .action(run);

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});

async function run(flags) {
  const log = (msg) => console.error(msg);
  const depth = parseDepth(flags.depth);
  const include = parseInclude(flags.include);
  const limit = parseLimit(flags.limit);
  const strategy = parseStrategy(flags.onExisting);
  const costMarginPercent = parseCostMargin(flags.costMargin);

  if (!flags.fromJson && !flags.url) {
    throw new Error(
      'Provide --from-json <file> (categories + products), or --url to scrape categories ' +
        'live (still needs --from-json for products).',
    );
  }

  // 1. Categories: from the combined JSON, or a live scrape.
  const { categories: rawCategories, products: rawProducts } = await loadCatalogFile(flags.fromJson);

  let tree;
  let treeMethod;
  if (flags.url) {
    ({ tree, method: treeMethod } = await scrapeSite(flags.url, {
      depth,
      render: flags.render,
      useLlm: flags.useLlm,
      model: flags.model,
      log,
    }));
  } else {
    tree = normalizeTree(rawCategories || [], { depth });
    treeMethod = `file (${flags.fromJson})`;
  }

  // 2. Products.
  const { products, warnings, errors, dropped } = normalizeCatalog(rawProducts || [], { limit });

  if (!tree.length && !products.length) {
    throw new Error('Nothing to import — no categories and no products found.');
  }

  // 3. Preview both halves.
  console.log(`\nCategory extraction method: ${treeMethod}`);
  printTreePreview(tree);
  printProductPreview(products, { warnings, errors, costMarginPercent });
  if (dropped) log(`(${dropped} product entrie(s) beyond --limit ${limit} were not loaded)`);

  // Optional: persist the normalized combined catalog.
  if (flags.out) {
    await writeFile(flags.out, JSON.stringify({ categories: tree, products }, null, 2));
    log(`Saved normalized catalog to ${flags.out}`);
  }

  if (flags.dryRun) {
    log('Dry run — no changes written to BigCommerce.');
    return;
  }

  // `--channel` is required for any real write — never guessed or defaulted,
  // so categories always land on a known tree instead of an easy-to-lose
  // default one. --dry-run above is the only way to preview without it.
  if (!flags.channel) {
    throw new Error('--channel is required to push (or use --dry-run to preview only).');
  }

  // 4. Confirmation gate — one prompt covers both halves.
  if (!flags.yes) {
    const ok = await confirm(
      `Create ${summarizeTree(tree)} and ${summarizeProducts(products)} in channel ${flags.channel} ` +
        `(on-existing: ${strategy})? [y/N] `,
    );
    if (!ok) {
      log('Aborted.');
      return;
    }
  }

  const { storeHash, accessToken } = resolveBcCredentials(flags);
  const client = new BigCommerceClient({ storeHash, accessToken });
  const treeId = await resolveTreeId(client, flags.channel, { log });

  // 5. Push the category tree first (Phase 1) — every id a product might
  // reference below either already exists or gets created here.
  log('Pushing categories to BigCommerce…');
  const treeStats = await pushTree(client, tree, { treeId, strategy, include, dryRun: false, log });
  console.log(
    `Categories: created ${treeStats.created}, skipped ${treeStats.skipped}` +
      (treeStats.deleted ? `, deleted ${treeStats.deleted}` : '') +
      ` (of ${countNodes(tree)} total).`,
  );

  if (!products.length) return;

  // 6. Resolve each product's category-name strings against the tree just
  // pushed (Phase 2) — reads what step 5 just wrote, not a stale earlier GET,
  // so a category created moments ago is reused instead of near-duplicated.
  const { list: existingCategories } = await getExistingCategories(client, treeId);
  const catchAllName = flags.catchAll || findCatchAllCategory(existingCategories)?.name || CATCH_ALL_FALLBACK_NAME;
  const categoryNames = [...new Set(products.flatMap((p) => p.categories))];
  const allNames = [...new Set([...categoryNames, catchAllName])];
  const { matches: categoryMatches, unmatched: categoriesToCreate } = matchCategories(
    existingCategories,
    allNames,
  );
  printCategoryPlan(allNames, categoryMatches, categoriesToCreate, { catchAllName });

  // Parent links for every category a product might resolve to, so a product
  // tagged with a deep category also gets assigned to its ancestors up to the
  // top-level one (see withAncestorIds) — BigCommerce doesn't do this
  // implicitly, so without it a product would only ever show up browsing its
  // most specific category, not the broader ones it also genuinely belongs to.
  const parentById = new Map();
  for (const cat of existingCategories) {
    parentById.set(cat.category_id ?? cat.id, cat.parent_id ?? 0);
  }

  const categoryIdByName = new Map();
  for (const [name, match] of categoryMatches) {
    categoryIdByName.set(name, match.category.category_id ?? match.category.id);
  }

  let catchAllId = categoryIdByName.get(catchAllName);
  if (catchAllId == null) {
    const created = await createCategories(client, [catchAllName], { treeId, parentId: 0, log });
    catchAllId = created.get(catchAllName);
    categoryIdByName.set(catchAllName, catchAllId);
    if (catchAllId != null) parentById.set(catchAllId, 0);
  }

  const remainingToCreate = categoriesToCreate.filter((name) => name !== catchAllName);
  const createdIds = await createCategories(client, remainingToCreate, {
    treeId,
    parentId: catchAllId,
    log,
  });
  for (const [name, id] of createdIds) {
    categoryIdByName.set(name, id);
    parentById.set(id, catchAllId);
  }

  const productsWithCategoryIds = products.map((p) => {
    const ids = new Set();
    for (const name of p.categories) {
      const directId = categoryIdByName.get(name);
      if (directId == null) continue;
      for (const id of withAncestorIds(directId, parentById)) ids.add(id);
    }
    if (catchAllId != null) ids.add(catchAllId);
    return { ...p, categoryIds: [...ids] };
  });

  // 6b. Resolve each product's brand name to a BigCommerce Brand id — reusing
  // an existing brand by name, creating one only if genuinely missing, so the
  // same brand name (here or across separate runs) never ends up duplicated.
  const brandNames = [...new Set(productsWithCategoryIds.map((p) => p.brandName).filter(Boolean))];
  let brandIdByName = new Map();
  if (brandNames.length) {
    log('Resolving brands…');
    brandIdByName = await resolveBrands(client, brandNames, { log });
    log(`Brands: ${brandNames.length} referenced, ${brandIdByName.size} resolved.`);
  }
  const productsWithBrandIds = productsWithCategoryIds.map((p) => {
    const brandId = p.brandName ? brandIdByName.get(p.brandName) : undefined;
    return brandId != null ? { ...p, brandId } : p;
  });

  // 7. Push products.
  log('Pushing products to BigCommerce…');
  const productStats = await pushProducts(client, productsWithBrandIds, {
    strategy,
    channel: flags.channel,
    dryRun: false,
    costMarginPercent,
    log,
  });

  console.log(
    `\nDone. Categories — created ${treeStats.created}, skipped ${treeStats.skipped}` +
      (treeStats.deleted ? `, deleted ${treeStats.deleted}` : '') +
      `. Products — created ${productStats.created}, skipped ${productStats.skipped}` +
      (productStats.deleted ? `, deleted ${productStats.deleted}` : '') +
      (productStats.channelAssigned ? `, assigned ${productStats.channelAssigned} to channel ${flags.channel}` : '') +
      (productStats.imagesDropped ? `, dropped ${productStats.imagesDropped} invalid image(s)` : '') +
      (productStats.skuConflicts ? `, ${productStats.skuConflicts} SKU conflict(s) skipped` : '') +
      ` (of ${products.length} total).`,
  );
}

/** Print what each product category name will reuse vs. create, before writing. */
function printCategoryPlan(names, matches, toCreate, { catchAllName }) {
  console.log('\nProduct categories:');
  for (const name of names) {
    const isCatchAll = name === catchAllName;
    const tag = isCatchAll ? ' [catch-all: every product also joins this]' : '';
    const match = matches.get(name);
    if (!match) {
      const parentNote = isCatchAll ? '' : ` (nested under "${catchAllName}")`;
      console.log(`  "${name}" — will create new${parentNote}${tag}`);
      continue;
    }
    const { category, method, score } = match;
    const note =
      method === 'exact'
        ? ''
        : method === 'plural'
          ? ' [singular/plural match]'
          : ` [fuzzy match, ${Math.round(score * 100)}% similar]`;
    console.log(`  "${name}" — reusing existing "${category.name}" (id ${category.category_id ?? category.id})${note}${tag}`);
  }
  if (toCreate.length) {
    console.log(`\n(${toCreate.length} of ${names.length} product categories will be newly created)`);
  } else {
    console.log(`\n(all ${names.length} product categories already exist — none will be created)`);
  }
}

/**
 * Load the combined catalog JSON: { categories: [...], products: [...] }.
 * Either key may be absent/empty (e.g. a products-only file when scraping
 * categories live via --url instead).
 */
async function loadCatalogFile(file) {
  if (!file) return { categories: [], products: [] };

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Could not read catalog file ${file}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must be a JSON object: { "categories": [...], "products": [...] }.`);
  }

  const categories = Array.isArray(data.categories) ? data.categories : [];
  const products = Array.isArray(data.products) ? data.products : [];
  return { categories, products };
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
