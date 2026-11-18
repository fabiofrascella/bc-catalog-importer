/**
 * Small helpers shared across the BigCommerce push modules (category tree
 * push, product-category resolution, and product push).
 */

/** Accent- and case-fold a name for stable, forgiving lookup-key matching. */
export function foldName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Split an array into fixed-size chunks. */
export function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}

/** Fold + strip punctuation, for fuzzy comparisons that should ignore it (e.g. "Men's" vs "Mens"). */
export function fuzzyFold(name) {
  return foldName(name)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort singularize: strip one trailing "s" (not "ss"), for plural-insensitive comparisons. */
export function singularize(key) {
  return key.length > 3 && key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : key;
}

/** Levenshtein edit distance between two strings. */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

/** Similarity ratio in [0,1] (1 = identical), based on Levenshtein distance. */
export function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Slugify a name for a fallback URL path (category create, product-category create). */
export function slugify(name) {
  return (
    String(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'category'
  );
}
