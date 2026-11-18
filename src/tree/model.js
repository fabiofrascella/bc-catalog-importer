/**
 * Tree model: the canonical category hierarchy shape shared across the scrape
 * and BigCommerce layers.
 *
 * A node is: { name, url?, image?, description?, children: Node[] }
 *
 * This module normalizes raw parsed/LLM output into that shape, drops utility
 * links, dedupes siblings, trims to a max depth, and resolves relative URLs.
 */

/**
 * Nav labels that are almost never real merchant categories. Matched
 * case-insensitively against the trimmed node name.
 */
const UTILITY_LABELS = new Set([
  'login', 'log in', 'sign in', 'signin', 'register', 'sign up', 'signup',
  'account', 'my account', 'cart', 'basket', 'bag', 'checkout', 'wishlist',
  'search', 'home', 'blog', 'news', 'contact', 'contact us', 'about',
  'about us', 'help', 'support', 'faq', 'faqs', 'stores', 'store locator',
  'find a store', 'gift cards', 'gift card', 'track order', 'track my order',
  'returns', 'shipping', 'careers', 'press', 'privacy', 'terms', 'sitemap',
  'newsletter', 'subscribe', 'menu', 'close', 'skip to content',
]);

/** Collapse whitespace and trim a raw label. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Is this label a utility/non-category link we should drop? */
export function isUtilityLabel(name) {
  return UTILITY_LABELS.has(cleanName(name).toLowerCase());
}

/**
 * Resolve a possibly-relative href against the merchant origin.
 * Returns undefined for empty, fragment-only, or non-navigational hrefs.
 */
export function resolveUrl(href, origin) {
  if (!href || typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed === '#') return undefined;
  if (/^(javascript:|mailto:|tel:)/i.test(trimmed)) return undefined;
  if (trimmed.startsWith('#')) return undefined;
  try {
    return new URL(trimmed, origin || undefined).href;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a raw tree (array of loosely-shaped nodes) into clean model nodes.
 *
 * @param {Array} rawNodes
 * @param {object} opts
 * @param {string} [opts.origin]  merchant origin for relative-URL resolution
 * @param {number} [opts.depth=Infinity]  max levels to keep (1 = top level only)
 * @param {boolean} [opts.stripUtility=true]
 * @returns {Array} normalized nodes
 */
export function normalizeTree(rawNodes, opts = {}) {
  const { origin, depth = Infinity, stripUtility = true } = opts;
  return normalizeLevel(rawNodes, { origin, remaining: depth, stripUtility });
}

function normalizeLevel(nodes, ctx) {
  if (!Array.isArray(nodes) || ctx.remaining < 1) return [];

  const out = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanName(raw.name);
    if (!name) continue;
    if (ctx.stripUtility && isUtilityLabel(name)) continue;

    const node = { name, children: [] };

    const url = resolveUrl(raw.url ?? raw.href, ctx.origin);
    if (url) node.url = url;

    const image = resolveUrl(raw.image ?? raw.image_url ?? raw.img, ctx.origin);
    if (image) node.image = image;

    const description = cleanName(raw.description);
    if (description) node.description = description;

    node.children = normalizeLevel(raw.children, {
      ...ctx,
      remaining: ctx.remaining - 1,
    });

    out.push(node);
  }

  return dedupeSiblings(out);
}

/**
 * Merge sibling nodes that share a name (case-insensitive). The first
 * occurrence wins for scalar fields; children are concatenated then re-deduped.
 */
export function dedupeSiblings(nodes) {
  const byKey = new Map();
  const order = [];

  for (const node of nodes) {
    const key = node.name.toLowerCase();
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      // Fill in any scalar the first occurrence was missing.
      for (const field of ['url', 'image', 'description']) {
        if (existing[field] === undefined && node[field] !== undefined) {
          existing[field] = node[field];
        }
      }
      existing.children.push(...node.children);
    } else {
      const copy = { ...node, children: [...node.children] };
      byKey.set(key, copy);
      order.push(key);
    }
  }

  const merged = order.map((key) => byKey.get(key));
  for (const node of merged) {
    if (node.children.length) node.children = dedupeSiblings(node.children);
  }
  return merged;
}

/** Depth-first walk; calls fn(node, parent, depth) for every node. */
export function walk(nodes, fn, parent = null, depth = 1) {
  for (const node of nodes) {
    fn(node, parent, depth);
    if (node.children?.length) walk(node.children, fn, node, depth + 1);
  }
}

/** Count total nodes in a tree. */
export function countNodes(nodes) {
  let n = 0;
  walk(nodes, () => { n += 1; });
  return n;
}

/** Max depth of a tree (0 for empty). */
export function maxDepth(nodes) {
  let max = 0;
  walk(nodes, (_node, _parent, depth) => { if (depth > max) max = depth; });
  return max;
}
