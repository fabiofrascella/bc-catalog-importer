# Prompt to feed to a Claude chat ("cowork")

Use this template to extract a representative category hierarchy and product catalog from a
merchant's live site for use with the `bc-catalog-importer` CLI tool. Both phases run in the
same chat so the product phase can tag products against the exact category names the category
phase just extracted — no separate file to keep in sync.

## Inputs

- `{MERCHANT_URL}` — root URL of the merchant's site
- `{N}` — target total number of products to extract
- `{DEPTH}` — optional max category depth to extract (omit for unlimited)

## Phase 1 — Category hierarchy

Browse the site's main navigation / mega-menu (and category landing pages if needed) and build
the category hierarchy.

- Each node has this shape:
  ```json
  {
    "name": "string (required, the category label as shown)",
    "url": "string (absolute URL to the category page, if known)",
    "image": "string (absolute image URL, only if clearly available)",
    "description": "string (short, only if clearly available)",
    "children": [ "...same node shape, or [] if none" ]
  }
  ```
- Only `name` is required. Omit `url`/`image`/`description` when you don't have a real value —
  never invent them.
- Preserve the real parent/child nesting from the menu. Use `"children": []` for leaf categories.
- Provide `url` for every category where possible, as an absolute URL starting with
  `{MERCHANT_URL}`. (The import tool cleans these into slugs automatically, so give the site's
  real category URLs — don't simplify them.)
- Include ONLY genuine product categories. EXCLUDE utility/marketing links: Home, Login/Account,
  Cart, Search, Wishlist, Blog, News, Contact, About, Help/FAQ, Store Locator, Gift Cards, Track
  Order, Returns, Shipping, Careers, and promo banners (e.g. "New", "Sale", "Top Sellers",
  "Clearance") unless they are true catalog categories.
- Keep category names in the site's original language, with correct accents.
- Go as deep as the menu goes (or to `{DEPTH}` if given); include all subcategory levels you can
  find.

Once Phase 1 is done, flatten the tree you just built to a list of every category name at every
depth (leaf and parent nodes) — Phase 2 tags products against this exact list.

## Phase 2 — Product catalog

1. **Coverage-first sampling.** Before adding a second product to any category from the Phase 1
   list, find at least one real product for every other category. Work category by category
   rather than page by page, so rare categories aren't crowded out by whichever items happen to
   load first.

2. **Search every source that could contain real listings for a category — don't stop at the
   first one:**
   - Priced/in-stock listing pages (e.g. "Used Equipment," clearance, outlet).
   - Quote-only / new-equipment category pages. Many B2B and equipment sites show no public price
     on these pages ("request a quote," "contact for pricing") — that does not disqualify the
     products on them. Include these products and include a fake but realistic price.
   - If a category page paginates or lists more than ~50 items, page through enough of it to
     reasonably expect coverage — don't stop after the first page or two just because nothing
     matched yet.
   - If a category isn't well represented by exact page structure, search by known brand/model
     naming conventions for that machine or product type (ask: which brands/models in this
     vertical are typically labeled as this category?) rather than relying only on whatever the
     default listing surfaces.

3. **Use real UI filters, not guessed query parameters.** Many sites filter listings via
   JavaScript rather than simple URL query strings. If a guessed filter URL (e.g.
   `?filter[category]=x`) returns zero results, that's a sign the guess is wrong, not that the
   category is empty — try the site's actual filter controls (via a browser tool) or navigate to
   the category's own landing page directly instead of retrying more URL-parameter guesses.

4. **Stop condition:** only mark a category as "skipped" once you've tried (a) its own dedicated
   category/listing page if one exists, (b) reasonable pagination depth on general listings, and
   (c) a brand/model-based search. If still nothing genuine turns up, skip it explicitly — never
   fabricate a product to fill a gap.

4a. **Respect the category's actual size.** If a category page genuinely only lists a handful of
   models (e.g. 1-3 total), don't force a fixed quota (like "2 per category") — take what's really
   there and note the smaller count in the coverage report. Padding a thin category with items
   from elsewhere defeats the point of coverage-first sampling.

4b. **Watch for the same model name spanning multiple categories as distinct listings.** Some
   sites carry the same base model under two different product pages/IDs when it's offered on two
   different configurations (e.g. two chassis-weight variants of the same aerial platform, each
   in its own weight-class category). These are genuine, separate SKUs belonging in different
   categories — not duplicates, and *not* the same thing as the variants in step 7 below, since
   BigCommerce variants always share one product's categories/description/images. If keeping both
   as separate products, and their specs conflict with what another pass already extracted under
   the same name, re-fetch the product page directly to confirm which numbers are real before
   trusting either one. When keeping both, disambiguate the `name` field (e.g. append the
   distinguishing config, like "(5T Chassis)" vs "(>7.5T Chassis)") so `bc-catalog-importer`
   doesn't collide them as one item.

5. Capture a `sku` field — the merchant's own SKU, item number, model code, or reference number —
   whenever it's shown on the product page. Omit the field if genuinely not present; don't invent
   one.

6. Tag each product with the **exact category names from the Phase 1 list**, not paraphrases or
   invented labels, so `bc-catalog-importer` can slot products into the categories it just created
   instead of near-duplicating them. A product may carry more than one tag (e.g. a general listing
   category plus a specific machine-type category) when both genuinely apply.

7. **Real variants (size/color/etc. of the exact same listing) go in a `variants` array on that
   one product — don't split them into separate top-level products.** Use this when the product
   page itself offers a dropdown/selector for options (e.g. Size: S/M/L, Color: Red/Blue) that are
   all still "the same product." For each variant, capture:
   - `option_values`: every selectable option and its value for that variant (e.g.
     `{ "Color": "Red", "Size": "Small" }`)
   - `sku`: that variant's own SKU/item number, if shown. Omit if not shown —
     `bc-catalog-importer` generates one.
   - `price`: only if that specific variant has its own price different from the product's base
     price. Omit it to just use the base price for that variant.
   - `image`: if the product page swaps in a specific photo when that option is selected (very
     common for Color), grab that image's own URL here. Omit it if selecting the option doesn't
     change the photo — the variant will just show the product's default image.

   Don't use `variants` for configurations that belong in *different* categories or are otherwise
   listed as distinct products/pages (see 4b) — BigCommerce variants can't have separate category
   placement from their parent product.

8. For SAP Commerce Cloud product images where the URL contains a `?context=` suffix, keep the
   entire URL including the suffix.

8a. **Grab the URL of the photo actually displayed on the page, not a "download original" / "print
   quality" / "high-res asset" link.** Sites backed by a PIM/DAM asset system (product images served
   by a separate asset-management host, sometimes with a bare query-string URL like
   `https://media.example.com/?id=12345` rather than a normal `/path/photo.jpg`) often expose *both*
   a small web-ready rendition (what's actually in the page's `<img>` tag) and a much larger raw
   original (print-resolution TIFF/PSD, sometimes hundreds of MB) reachable through a separate link,
   button, or API on the same page — the two can differ only in *host or path*, not in any way
   that's obvious from the id/filename alone. Only the rendered, on-page image is a real product
   photo for this purpose; the raw original is typically both oversized and an unsupported format
   for BigCommerce, and grabbing it by mistake silently costs the product all of its images at
   import time (`bc-catalog-importer` can detect and drop a bad image, but can't recover a good one
   from it). If a product page's own visible photo and a "download"/"original" link resolve to
   different URLs, always use the visible one.

## Output

A single JSON **object** with both phases' results:

```json
{
  "categories": [
    {
      "name": "string",
      "url": "string — omit if not known",
      "image": "string — omit if not known",
      "description": "string — omit if not known",
      "children": []
    }
  ],
  "products": [
    {
      "name": "string",
      "description": "string — factual, self-written, not copied marketing copy",
      "price": "number or omitted/null if quote-only",
      "images": ["at least 2 real image URLs from the product page where available"],
      "categories": ["exact Phase 1 category name(s)"],
      "brand_name": "string — exact product brand as shown on the merchant's site, omit if not shown",
      "sku": "string — omit if not shown on the page",
      "custom_fields": { "...": "brand, specs, year, etc. as available" },
      "variants": [
        {
          "option_values": { "Color": "Red", "Size": "Small" },
          "sku": "string — omit if not shown on the page",
          "image": "string — omit if this option doesn't swap the photo"
        },
        {
          "option_values": { "Color": "Blue", "Size": "Medium" },
          "sku": "string",
          "price": "number — only if this variant's price differs from the base price"
        }
      ]
    }
  ]
}
```

Omit a product's `variants` entirely when it doesn't offer options — most products won't have it.

Save the result to `catalog.json` in the project folder.

A quote-only product with `price` omitted/`null` isn't dropped by `bc-catalog-importer` — it gets
a fake `$0.00`, is created with BigCommerce's "This product cannot be purchased in my online
store" toggle on, and has its price hidden behind a "Call for pricing" label, so it still shows up
in the catalog and its category, just not buyable — and the storefront shows "Call for pricing"
rather than the fake $0.00. The preview flags these as `(fake — not purchasable)` before anything
is pushed.

`bc-catalog-importer` re-validates `variants` too: a variant with no `option_values` is dropped
(with a warning, not failing the product), as is a duplicate option combo or a duplicate SKU
across a product's own variants (first one wins in both cases) — so a slightly messy `variants`
array still loads instead of failing the whole product. Every surviving variant gets a real SKU
the same way the product itself does. A variant's `image` is automatically folded into the
product's own `images` gallery (BigCommerce links a variant to a photo already in that gallery —
there's no separate per-variant upload), so you don't need to also list it in the top-level
`images` array yourself.

`brand_name` is resolved to a real BigCommerce Brand at push time: an existing brand with the same
name (case/accent-insensitive) is reused, and a brand is only ever created once per distinct name
— even if it's spelled with different casing across products or extraction runs — so imports never
leave the store with duplicate Brand records for what's really one brand.

## After extraction, report:

- Which of the flattened Phase 1 category names got genuine product coverage in Phase 2.
- Which were skipped, and why (no public listings found after exhausting Phase 2 steps 2–4 above —
  be specific about what was tried).

## Then run locally (not by Claude — this CLI lives in the user's own environment)

`--channel` is required for any real push — find your BigCommerce channel id first (Storefront >
Channels in the control panel), then:

```
bc-catalog-importer --from-json catalog.json --channel <id> --dry-run
bc-catalog-importer --from-json catalog.json --channel <id> --limit 20
```
