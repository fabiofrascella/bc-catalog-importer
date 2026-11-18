/**
 * Fetch a merchant page's HTML.
 *
 * Static fetch uses Node's built-in fetch (no dependency). For sites whose
 * navigation is built by JS at runtime, `--render` lazily loads Playwright
 * (an optional dependency) to get the rendered DOM.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.render=false]  use Playwright to render JS-built nav
 * @param {number} [opts.timeout=20000]
 * @returns {Promise<{ html: string, finalUrl: string }>}
 */
export async function getHtml(url, opts = {}) {
  const { render = false, timeout = DEFAULT_TIMEOUT_MS } = opts;
  return render ? getRenderedHtml(url, timeout) : getStaticHtml(url, timeout);
}

async function getStaticHtml(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${timeout}ms for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getRenderedHtml(url, timeout) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'The --render flag requires Playwright. Install it with:\n' +
        '  npm install playwright && npx playwright install chromium',
    );
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: DEFAULT_UA });
    await page.goto(url, { waitUntil: 'networkidle', timeout });
    const html = await page.content();
    return { html, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}
