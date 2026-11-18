# bc-catalog-importer

A Node.js CLI that loads a merchant category hierarchy **and** product catalog from a single
combined JSON file — produced by pasting [PROMPT.md](PROMPT.md) into a browsing-capable Claude
chat ("cowork") — and creates both in a BigCommerce demo store/channel via **Catalog API v3**.
This is the merger of two previously separate sibling tools (`category-scraper` and
`product-scraper`) into one command and one prompt, so products always reference category names
Claude just extracted in the same chat, instead of a second file that can drift out of sync.

## Branch summary

One command runs both phases in sequence: it pushes/reconciles the category tree first
(breadth-first create, matched to existing categories by exact parent+name — the same logic
`category-scraper` used to recreate a scraped hierarchy 1:1), then resolves each product's loose
category-name strings against the tree it just pushed (exact → singular/plural → fuzzy
Levenshtein match — the same logic `product-scraper` used to reconcile independently-authored
names against an existing store) and creates the products. These are genuinely different
reconciliation problems — a real nested tree vs. flat name strings with no parent context — so
they're kept as two distinct modules (`bigcommerce/categories.js` for the tree push,
`bigcommerce/productCategories.js` for the product-side resolution) rather than force-unified
into one. `--channel <id>` is **mandatory** for any real push (only `--dry-run` can skip it): the
category tree always resolves against that one channel's tree, never a store's "first tree" or a
newly created unassigned one — the specific failure mode that motivated this requirement (an
omitted/inconsistent `--channel` across separate scrape/push runs silently landing categories in
the wrong, empty tree, making an unrelated product-push run think everything needed to be
recreated) can no longer happen. A product whose source data had no usable price gets a fake
`$0.00` and BigCommerce's "This product cannot be purchased" toggle instead of being dropped.
Every product also joins a store-wide catch-all category (auto-detected — "Shop All" / "All
Products" / "Products" / "All" — or created), and is also assigned to every ancestor of each of
its matched categories up to the top-level one (BigCommerce doesn't infer this: a product filed
under "Daypacks" wouldn't otherwise show up browsing its parent "Backpacks"). Images are
pre-checked against BigCommerce's 8 MB
upload cap and supported-format list (GIF/JPEG/PNG/WEBP); a confirmed-bad one is dropped rather
than failing the product, with a fallback retry if a create still 422s/400s on an image field.
Categories can alternatively be scraped live via `--url` (deterministic nav parsing, with an LLM
fallback via `--use-llm`/`ANTHROPIC_API_KEY` for weak/JS-heavy menus) instead of reading them from
the JSON — products always come from `--from-json` regardless, since there's no live product
scraper (that's what the Claude chat step is for).

| Concern | Technical approach |
|---|---|
| CLI / flags | `commander`; single command, `node:readline` confirmation prompt |
| Input | `--from-json <file>` — `{ "categories": [...], "products": [...] }`, from PROMPT.md. `--url <site>` optionally replaces the categories half with a live scrape; products always come from `--from-json` |
| Category model | `{ name, url?, image?, description?, children: Node[] }` — dedupes siblings, strips utility/marketing links, trims to `--depth`, resolves relative URLs |
| Product model | `{ name, sku, skuGenerated, description, price, priceIsFake, brandName, images: string[], customFields: {name,value}[], categories: string[], variants: {...}[] }` — tolerant of field-name variants; only `name` is a hard requirement |
| Category scrape (optional, `--url`) | Static fetch or Playwright-rendered (`--render`) HTML → deterministic cheerio nav parser, scored; falls back to an Anthropic-powered structured extractor (`--use-llm`, or automatically when the deterministic score is weak) |
| **Phase 1 — category tree push** | `bigcommerce/categories.js`'s `pushTree`: breadth-first `POST /catalog/trees/categories` (batched ≤50), so parent ids exist before children reference them. Matched to existing categories by **parent_id + name** (`categoryKey` in `bigcommerce/trees.js`), accent/case-insensitive — a "Sale" under Men is distinct from a "Sale" under Women |
| Category image validation | Since this endpoint batch-creates up to 50 categories in **one request that's validated as a whole**, a single bad `image_url` would otherwise 422 the entire batch, not just that category. Each node's image is pre-checked with the same size/format rules as product images. The endpoint also turns out **not to be fully atomic**: a 422 doesn't guarantee nothing in the batch was written — valid entries can get created despite the overall error. So on any batch failure, `createBatch` re-fetches what's actually in the tree before retrying, resending only entries confirmed still-missing (stripping the image, for an image-related failure) — never the original full chunk, which would otherwise 422 again on "duplicate category name" for whatever silently went through the first time |
| **Phase 2 — product category resolution** | `bigcommerce/productCategories.js`'s `matchCategories`: tiered exact → singular/plural → fuzzy (Levenshtein similarity ≥ 82%) match of each product's bare category-name strings against the tree Phase 1 just pushed, tree-wide (no parent context to scope by). Only names that clear none of those tiers get created, flat, under the catch-all |
| `--channel` | **Required** for any real push (validated before the confirmation prompt) — resolves (or creates+assigns) the one tree wired to that channel; there is no "first tree" / unassigned-tree fallback, so categories can never land somewhere unexpected because the flag was left off |
| Catch-all category | Every product also joins a "browse everything" category: `--catch-all <name>`, else auto-detected among existing categories ("Shop All" → "All Products" → "Products" → "All"), else a new "Shop All" is created. Newly created (non-catch-all) product categories nest under it |
| Ancestor assignment | `withAncestorIds` in `bigcommerce/productCategories.js`: a product matched/filed to a category is also assigned to every ancestor of it up to (and including) the top-level one — BigCommerce doesn't infer this on its own |
| Create products | One `POST /catalog/products` per product (no batch endpoint) with `images`, `custom_fields`, resolved `categories` (ids), resolved `brand_id`, and `variants` nested at create time. `inventory_tracking` switches from `"product"` to `"variant"` when variants are present |
| Inventory levels | Not sourced from the merchant site (almost none expose real stock counts) — every product gets tracking turned on with a random, plausible level instead (`MIN_INVENTORY_LEVEL`–`MAX_INVENTORY_LEVEL` in `bigcommerce/products.js`, currently 5–250): one count on the product itself, or one per variant for a product with variants. This is explicitly fake data, so a demo store doesn't read as permanently empty-shelved |
| `--cost-margin <percent>` | Not sourced from the merchant site either (cost/COGS is never public) — opt-in only, no cost_price sent by default. When set, every product with a real (non-fake) price gets `cost_price = price * (1 - percent/100)`, e.g. `--cost-margin 20` → cost is 80% of price. Skipped for fake/`$0.00`/not-purchasable prices (see "Create products" below) — there's no real price to take a margin off of. Shown in the `--dry-run` preview alongside the price when set |
| Brand resolution | `bigcommerce/brands.js`'s `resolveBrands`: each product's `brand_name` string is matched against existing Brands by **name** (accent/case-insensitive); a genuinely new name is created once and reused for every other product (even a differently-cased duplicate) in the same run — never duplicated. Ignores `--on-existing` (a brand isn't the thing being imported, it's an attribute products point at) |
| Oversized/unsupported/invalid images | `HEAD` pre-check against the 8 MB cap and GIF/JPEG/PNG/WEBP allowlist; every URL is also validated/canonicalized (well-formed http(s), ≤255 chars) at normalize time. A create that still fails on the size cap, an unsupported format, or `image_url` being invalid is retried once with no images |
| `--on-existing` | `skip` (idempotent, default) \| `create` \| `recreate` (destructive) — applies to **both** categories and products from one flag |
| Channel listing | With `--channel`, every touched product id is also assigned to that channel via `PUT /catalog/products/channel-assignments` — being in a channel-linked category isn't enough on its own |
| Rate limits | Client honors HTTP 429 + `X-Rate-Limit-Time-Reset-Ms` with backoff/retry |

> [!WARNING]
> **Proof-of-concept disclaimer.** BigCommerce **Catalyst** (the `main` branch of the Catalyst
> project) is production-ready. This disclaimer applies **only to this tool and its custom code**.
> `bc-catalog-importer` is for **proof-of-concept / demo-building purposes only**. Before any of
> this code is used in production it requires a thorough review covering **security,
> accessibility, error handling, edge cases, localisation, and compliance**. Scraping/browsing
> third-party websites may also be subject to their terms of service and applicable law — confirm
> you are permitted to extract data from a given site.

## Requirements

- Node.js ≥ 20
- A BigCommerce store API account token with **Products (Catalog) = Modify**
- A combined catalog JSON file — get one by pasting [PROMPT.md](PROMPT.md) into a Claude chat
  with web browsing (no API key needed for that step)
- Optional, only for `--url` live category scraping: `ANTHROPIC_API_KEY` for the LLM fallback,
  and `playwright` (`npm install playwright && npx playwright install chromium`) for `--render`

## Setup

```bash
npm install
cp .env.example .env    # then fill in the values
```

`.env`:

```
BC_STORE_HASH=...        # the <hash> in https://api.bigcommerce.com/stores/<hash>/v3/
BC_ACCESS_TOKEN=...      # Products (Catalog) = Modify
ANTHROPIC_API_KEY=...    # only needed for --url --use-llm category scraping
```

### Multiple stores (`--env`)

If you're importing into more than one store (e.g. separate client engagements), credentials
resolve in this order — see `resolveBcCredentials` in `src/config.js`:

1. `--store <hash>` / `--token <token>` flags (both required together) — always wins
2. `--env <name>` (or `BC_ENV=<name>`) — looked up first as `BC_<NAME>_STORE_HASH` /
   `BC_<NAME>_ACCESS_TOKEN` in `.env` (e.g. `--env staging` → `BC_STAGING_STORE_HASH`), then in
   `~/.bc-cli/config.json`'s `"environments"` map
3. Plain `BC_STORE_HASH` / `BC_ACCESS_TOKEN` (`.env` or process env), when no `--env` was given
4. `~/.bc-cli/config.json`'s `default_environment`, or a flat `{ store_hash, access_token }`
   config with no `"environments"` map

`~/.bc-cli/config.json` is intentionally the **same file and shape** used by the `bigcommerce-admin`
skill, so named stores are configured once and shared across both tools:

```json
{
  "default_environment": "prod",
  "environments": {
    "prod":    { "store_hash": "...", "access_token": "..." },
    "staging": { "store_hash": "...", "access_token": "..." }
  }
}
```

## Usage

```bash
bc-catalog-importer \
  --from-json catalog.json \
  --channel <id>                             # required for any real push
  [--url <site>]                             # scrape categories live instead of reading them from the JSON
  [--limit 20]                               # cap how many products to import
  [--cost-margin 20]                         # set cost_price this % below price (else no cost_price sent)
  [--store <hash>] [--token <token>]         # else --env / .env / ~/.bc-cli/config.json
  [--env <name>]                             # named credential environment — see "Multiple stores" above
  [--catch-all "Shop All"]                   # override the auto-detected catch-all category
  [--on-existing skip|create|recreate]       # default: skip (idempotent) — applies to both halves
  [--dry-run] [--out normalized.json] [--yes]
```

Examples:

```bash
# Preview only — never touches the store, --channel not required
node src/index.js --from-json catalog.json --dry-run

# Push categories + products to channel 12345, skipping the confirm prompt
node src/index.js --from-json catalog.json --channel 12345 --yes

# Import only the first 15 products (categories are still pushed in full)
node src/index.js --from-json catalog.json --channel 12345 --limit 15

# Set every product's cost_price to 20% below its price (cost = 80% of price)
node src/index.js --from-json catalog.json --channel 12345 --cost-margin 20

# Scrape categories live instead of reading them from the JSON; products still come from the file
node src/index.js --from-json catalog.json --url https://merchant.example.com --channel 12345

# Wipe and re-create matching categories and products from scratch
node src/index.js --from-json catalog.json --channel 12345 --on-existing recreate
```

Progress/log lines go to **stderr**; the preview and final summary go to **stdout**, so you can
pipe or redirect cleanly.

Before the confirmation prompt, you'll see both the category tree and the product list preview.
The product-category reuse/create plan (Phase 2) is only known *after* Phase 1 actually pushes
the tree, so it's printed as it happens, after you've confirmed — not before, unlike the
single-tool predecessors' fully pre-confirmation plans:

```
Categories:
  "Backpack" — reusing existing "Backpacks" (id 42) [singular/plural match]
  "Winter Sale" — will create new (nested under "Shop All")
  "Shop All" — reusing existing "Shop All" (id 5) [catch-all: every product also joins this]

(1 of 3 product categories will be newly created)
```

## Catalog JSON shape

```json
{
  "categories": [
    {
      "name": "Backpacks",
      "url": "https://merchant.com/backpacks",
      "children": [
        { "name": "Daypacks", "url": "https://merchant.com/backpacks/daypacks", "children": [] }
      ]
    }
  ],
  "products": [
    {
      "name": "Trail Runner Backpack",
      "sku": "TRB-20L-GRN",
      "description": "A lightweight 20L backpack built for day hikes and trail running.",
      "price": 79.99,
      "images": [
        "https://merchant.com/images/backpack-front.jpg",
        "https://merchant.com/images/backpack-back.jpg"
      ],
      "categories": ["Backpacks", "Daypacks"],
      "brand_name": "TrailForge",
      "custom_fields": { "Material": "Ripstop Nylon", "Capacity": "20L", "Color": "Forest Green" }
    }
  ]
}
```

Both top-level keys are optional (an empty/missing one just means that phase pushes nothing —
e.g. a categories-only file when scraping products isn't needed, or omit `categories` entirely
when using `--url`). `sku` is optional — omitted ones get auto-generated. `price` is also optional
in practice: a missing/unparseable one gets a fake `$0.00` and is created not-purchasable rather
than failing. `variants` is optional and only for products that genuinely offer options on the
same listing. `brand_name` is optional — omitted products are created with no brand; when present,
it's resolved to a BigCommerce Brand id (reusing an existing one by name, never creating a
duplicate) at push time. See [PROMPT.md](PROMPT.md) for the full extraction prompt, field-by-field
guidance, and the exact node/product shapes.

## How it works

```
PROMPT.md pasted into a Claude chat ─▶ chat browses the merchant site ─▶ one combined JSON saved
                                                                              │
                                                                              ▼
                                                    load + normalize both halves
                                                                              │
                                                                              ▼
                                              preview: category tree + product list
                                                                              │
                                                                              ▼
                                                    require --channel (unless --dry-run)
                                                                              │
                                                                              ▼
                                                              confirmation gate
                                                                              │
                                                                              ▼
                              Phase 1 — resolve tree id, push category hierarchy (BFS)
                                                                              │
                                                                              ▼
                    Phase 2 — resolve product category names against the tree just pushed
                                                                              │
                                                                              ▼
                                            create/reuse catch-all + remaining categories
                                                                              │
                                                                              ▼
                                    resolve product brand names to Brand ids (reuse-or-create)
                                                                              │
                                                                              ▼
                                              create products (one POST each, resolved ids)
                                                                              │
                                                                              ▼
                                              assign every touched product to --channel
```

## Tests

```bash
npm test      # node:test — category/product normalization, tree-push, category matching,
              # image checks, and product-push unit tests
```

## Known limitations (POC)

- Category scraping (`--url`) inherits `category-scraper`'s limitations: div-based hover-panel
  menus come back flat (top-level only) unless `--use-llm` is used; `--render` is needed for
  pure JS-built menus; utility-link stripping is English-only.
- Product data has **no live scraping path** — it only ever comes from a Claude-chat-authored
  JSON (`--from-json`). If you want a fully automated product scrape, look at how `scrape/`
  wires up `@anthropic-ai/sdk` for the category side and adapt that pattern.
- Phase 2's product-category resolution is by **name only, tree-wide**, regardless of
  parent/depth — two unrelated categories that happen to share (or nearly share) a name will
  collide with the best-scoring match. The 82% fuzzy-similarity threshold
  (`FUZZY_THRESHOLD` in `bigcommerce/productCategories.js`) is hardcoded — no flag to tune it.
- New categories created in Phase 2 (for a product tag that didn't match anything in the pushed
  tree) nest only one level deep, flat under the catch-all — they don't get a real multi-level
  placement. Use Phase 1 / `--url` to build the real hierarchy first so Phase 2 has more to match
  against and creates fewer of these flat fallbacks.
- `--on-existing` matching is by **name only** (case/accent-insensitive) for both categories
  (parent+name) and products (name), not SKU/id — two differently-named entries for the same
  real-world thing won't be recognized as duplicates. If a product's SKU already belongs to a
  *different*, differently-named product already in the store, BigCommerce's create call 409s
  ("Sku ... is not unique") — `bigcommerce/products.js` catches that specific error and skips just
  that one product (counted in `skuConflicts`) rather than aborting the rest of the run.
- Every product is created as `type: "physical"` with `weight: 0`; adjust `buildPayload` in
  `bigcommerce/products.js` if your demo needs digital products or real weights.
- Inventory levels are **randomly generated, not real** (see "Inventory levels" above) — fine for
  a demo store, but don't mistake the numbers for actual merchant stock data if you ever compare
  against the source site.
- Oversized/unsupported-format image handling depends on the image host returning accurate
  `Content-Length`/`Content-Type` on a `HEAD` request — hosts that don't get treated as "unknown"
  and pass through unfiltered; BigCommerce's own create-time validation plus the one-retry
  fallback (no images at all) is the real backstop for those.
- The nested create-time `variants` shape (auto-creating matching product options from
  `option_values`, linking `image_url` by URL match against the product's gallery) is based on
  documented BigCommerce v3 behavior but hasn't been exhaustively tested here — try a `--dry-run`
  and then a small real push (e.g. `--limit 1`) on a product with variants before pushing a large
  catalog.
