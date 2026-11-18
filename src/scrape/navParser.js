/**
 * Deterministic navigation parser.
 *
 * Finds the most category-like navigation container on the page and walks it
 * into a raw tree of { name, url, image, children }. Handles two common shapes:
 *
 *   1. Classic list nav:   <nav><ul><li><a>…</a><ul>…</ul></li></ul></nav>
 *   2. Modern div nav:     <header><div>…<a href="/collections/x">…</a>…</div>  (no <ul>)
 *      (Tailwind / headless / Shopify-style storefronts)
 *
 * Candidates come from both fixed selectors and a scan of the <header> for
 * link clusters, so a div-based category bar isn't missed just because it isn't
 * a <nav>. Each candidate is scored — rewarding category-like hrefs and real
 * nesting, penalising footer containers — and the best one wins. Output is
 * intentionally "raw"; the tree model normalises/dedupes/trims it afterward.
 */

import { load } from 'cheerio';

/** Fixed selectors, most-to-least likely to hold the primary category nav. */
const NAV_SELECTORS = [
  'nav[aria-label*="main" i]',
  'nav[aria-label*="primary" i]',
  '[role="navigation"]',
  'header nav',
  'nav',
  '[class*="mega" i][class*="menu" i]',
  '[class*="main" i][class*="menu" i]',
  '[class*="main" i][class*="nav" i]',
  '[class*="primary" i][class*="nav" i]',
  '[class*="categor" i]',
  '[id*="menu" i]',
];

/** URL path prefixes that strongly indicate a product-category link. */
const CATEGORY_PATH_PATTERNS = [
  /^\/collections?\//i,
  /^\/categor(y|ies|ia|ias)\//i,
  /^\/product-categor/i,
  /^\/c\//i,
  /^\/shop\//i,
  /^\/store\//i,
  /^\/departments?\//i,
  /^\/catalog(ue)?\//i,
];

/** First path segments that are clearly NOT categories (footer/utility). */
const NON_CATEGORY_SEGMENTS = new Set([
  'pages', 'page', 'policies', 'policy', 'blog', 'blogs', 'news', 'account',
  'cart', 'checkout', 'help', 'faq', 'faqs', 'contact', 'about', 'login',
  'legal', 'info', 'support', 'wishlist', 'search', 'terms', 'privacy',
]);

/**
 * Parse navigation from HTML.
 * @param {string} html
 * @param {string} [baseUrl] used to judge category-like hrefs; resolution happens in the model
 * @returns {{ tree: Array, score: number }}
 */
export function parseNav(html, baseUrl) {
  const $ = load(html);
  $('script, style, svg, noscript, template').remove();
  const origin = safeOrigin(baseUrl);

  let best = { tree: [], score: -1 };
  for (const el of collectCandidates($)) {
    const tree = extractFromContainer($, el);
    if (!tree.length) continue;
    const score = scoreCandidate($, el, tree, origin);
    if (score > best.score) best = { tree, score };
  }

  return { tree: best.tree, score: Math.max(best.score, 0) };
}

/**
 * Gather candidate container elements: fixed selectors, plus header/body link
 * clusters (so div-based category bars with no <ul> are considered too).
 */
function collectCandidates($) {
  const seen = new Set();
  const out = [];
  const add = (el) => {
    if (el && !seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  };

  for (const selector of NAV_SELECTORS) {
    $(selector).each((_i, el) => add(el));
  }

  // Scan header (falling back to body) for elements that hold a link cluster.
  const scope = $('header').length ? $('header') : $('body');
  scope.find('div, nav, ul, section').each((_i, el) => {
    const n = $(el).find('a[href]').length;
    if (n >= 4 && n <= 60) add(el);
  });

  return out;
}

/**
 * Extract a raw tree from one container. Prefers explicit <ul> nesting; falls
 * back to a flat list of the container's direct-ish anchors for div menus.
 */
function extractFromContainer($, container) {
  // A <ul> candidate is parsed directly, not via a descendant list.
  if (container.tagName === 'ul') return parseList($, container);

  const $container = $(container);
  const topList = $container.children('ul').first();
  const list = topList.length ? topList : $container.find('ul').first();
  if (list.length) return parseList($, list);

  // Div-based menu: take anchors, skipping those nested inside a deeper
  // candidate block so we favour the top-level bar over merged hover panels.
  return $container
    .find('a')
    .toArray()
    .map((a) => anchorToNode($, a))
    .filter(Boolean);
}

/** Parse a <ul> into nodes, recursing into nested <ul> inside each <li>. */
function parseList($, ul) {
  const nodes = [];
  $(ul)
    .children('li')
    .each((_i, li) => {
      const $li = $(li);
      const anchor = $li.find('> a').get(0) || $li.find('a').get(0);
      if (!anchor) return;

      const node = anchorToNode($, anchor);
      if (!node) return;

      const nestedUl = $li.children('ul').first();
      if (nestedUl.length) node.children = parseList($, nestedUl);
      nodes.push(node);
    });
  return nodes;
}

/** Build a raw node from an <a> element. */
function anchorToNode($, a) {
  const $a = $(a);
  const name = $a.text().replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const node = { name, children: [] };

  const href = $a.attr('href');
  if (href) node.url = href;

  const img = $a.find('img').first();
  if (img.length) {
    const src = img.attr('src') || img.attr('data-src');
    if (src) node.image = src;
  }
  return node;
}

/**
 * Whether an href looks like a product-category link (used for scoring only).
 * Same-origin, not a known footer/utility section, and either matches a strong
 * category pattern or is a short clean path.
 */
export function isCategoryHref(href, origin) {
  if (!href || typeof href !== 'string') return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed === '#' || /^(javascript:|mailto:|tel:|#)/i.test(trimmed)) {
    return false;
  }
  let url;
  try {
    url = new URL(trimmed, origin || 'https://x.invalid');
  } catch {
    return false;
  }
  if (origin && url.origin !== origin && !trimmed.startsWith('/')) return false;

  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.length) return false; // homepage
  if (NON_CATEGORY_SEGMENTS.has(segments[0].toLowerCase())) return false;
  if (CATEGORY_PATH_PATTERNS.some((re) => re.test(url.pathname))) return true;
  // Short, clean path (e.g. /men, /portatiles) — plausibly a category.
  return segments.length <= 2;
}

/**
 * Container score. Combines the tree's breadth/nesting (scoreTree) with a
 * bonus for category-like links and a penalty for footer containers, so the
 * real product nav outranks footer/utility navs.
 */
function scoreCandidate($, el, tree, origin) {
  const base = scoreTree(tree);

  let categoryLinks = 0;
  let totalLinks = 0;
  $(el)
    .find('a[href]')
    .each((_i, a) => {
      totalLinks += 1;
      if (isCategoryHref($(a).attr('href'), origin)) categoryLinks += 1;
    });
  const bonus = Math.min(categoryLinks, 10); // count-based, not ratio

  // Prefer purer containers: penalise non-category links (logo/search/footer
  // clutter) so a tight category bar beats the whole noisy <header>.
  const noise = Math.min(totalLinks - categoryLinks, 10) * 0.8;

  const inFooter = $(el).closest('footer, [class*="footer" i], [id*="footer" i]').length > 0;
  const footerPenalty = inFooter ? 8 : 0;

  return base + bonus - noise - footerPenalty;
}

/**
 * Breadth/nesting score for a parsed tree. Rewards top-level breadth and real
 * hierarchy. Kept as a standalone export for tests and for scoreCandidate.
 */
export function scoreTree(tree) {
  if (!Array.isArray(tree) || tree.length === 0) return 0;
  let total = 0;
  let nested = 0;
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    total += 1;
    if (node.children?.length) {
      nested += 1;
      stack.push(...node.children);
    }
  }
  const topLevel = tree.length;
  return Math.min(topLevel, 12) + nested * 2 + Math.min(total, 40) * 0.25;
}

function safeOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}
