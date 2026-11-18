/**
 * Hybrid scrape orchestration.
 *
 * 1. Fetch HTML (static, or Playwright-rendered with --render).
 * 2. Deterministic nav parse (cheerio) and score it.
 * 3. If the score is below threshold, or --use-llm forces it, fall back to
 *    the Anthropic-powered extractor.
 * 4. Normalize the winning raw tree (dedupe, strip utility links, depth-trim,
 *    resolve relative URLs) into the canonical model.
 */

import { getHtml } from './fetch.js';
import { parseNav } from './navParser.js';
import { extractWithLlm, DEFAULT_MODEL } from './llmExtract.js';
import { normalizeTree, countNodes } from '../tree/model.js';

/** Below this parse score we consider the deterministic tree too weak. */
export const WEAK_SCORE_THRESHOLD = 6;

/**
 * @param {string} url  merchant URL
 * @param {object} [opts]
 * @param {number} [opts.depth=Infinity]
 * @param {boolean} [opts.render=false]
 * @param {boolean} [opts.useLlm=false]  force LLM even if deterministic parse looks OK
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ tree: Array, method: 'deterministic'|'llm' }>}
 */
export async function scrapeSite(url, opts = {}) {
  const {
    depth = Infinity,
    render = false,
    useLlm = false,
    model = DEFAULT_MODEL,
    apiKey,
    log = () => {},
  } = opts;

  log(`Fetching ${url}${render ? ' (rendered)' : ''}…`);
  const { html, finalUrl } = await getHtml(url, { render });
  const origin = new URL(finalUrl).origin;

  log('Parsing navigation…');
  const { tree: rawTree, score } = parseNav(html, finalUrl);
  log(`Deterministic parse: score ${score.toFixed(1)}, ${countNodes(rawTree)} raw nodes.`);

  let raw = rawTree;
  let method = 'deterministic';

  const haveKey = Boolean(apiKey || process.env.ANTHROPIC_API_KEY);
  const wantLlm = useLlm || score < WEAK_SCORE_THRESHOLD;

  if (wantLlm && !haveKey) {
    // No key: deterministic-only. Fail only if the LLM was explicitly requested.
    if (useLlm) {
      throw new Error('--use-llm requires ANTHROPIC_API_KEY (set it in .env).');
    }
    log(
      `Parse is weak (score ${score.toFixed(1)}) but no ANTHROPIC_API_KEY set — ` +
        'using the deterministic result. For JS-built menus, try --render.',
    );
  } else if (wantLlm) {
    const reason = useLlm ? '--use-llm set' : `score ${score.toFixed(1)} < ${WEAK_SCORE_THRESHOLD}`;
    log(`Using LLM fallback (${reason})…`);
    raw = await extractWithLlm(html, { baseUrl: finalUrl, model, apiKey });
    method = 'llm';
  }

  const tree = normalizeTree(raw, { origin, depth });
  return { tree, method };
}
