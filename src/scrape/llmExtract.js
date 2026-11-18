/**
 * LLM fallback extraction.
 *
 * When deterministic nav parsing yields a weak/flat tree, we send the trimmed
 * navigation HTML to Claude and ask it to return a strict category hierarchy.
 * Structured output is forced via a tool definition (tool_choice), so we get
 * valid JSON instead of prose we'd have to salvage.
 *
 * Only public navigation markup is sent — no PII.
 */

import Anthropic from '@anthropic-ai/sdk';
import { load } from 'cheerio';

export const DEFAULT_MODEL = 'claude-sonnet-5';

/** Node shape the tool must return, described once for the schema. */
const CATEGORY_ITEMS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Category display name' },
    url: { type: 'string', description: 'Category page URL or path, if present' },
    image: { type: 'string', description: 'Representative image URL, if present' },
    description: { type: 'string', description: 'Short description, if present' },
    children: {
      type: 'array',
      description: 'Nested subcategories',
      items: { $ref: '#/$defs/category' },
    },
  },
  required: ['name'],
};

const EXTRACT_TOOL = {
  name: 'emit_category_tree',
  description: 'Return the merchant category hierarchy extracted from the navigation HTML.',
  input_schema: {
    type: 'object',
    $defs: { category: CATEGORY_ITEMS },
    properties: {
      categories: {
        type: 'array',
        description: 'Top-level categories, each with nested children',
        items: { $ref: '#/$defs/category' },
      },
    },
    required: ['categories'],
  },
};

const SYSTEM_PROMPT =
  'You extract a merchant e-commerce category hierarchy from raw navigation HTML. ' +
  'Include only real product categories and subcategories — exclude utility links ' +
  '(login, cart, search, blog, contact, account, store locator, gift cards, help, etc.). ' +
  'Preserve the parent/child nesting exactly as the menu implies. Keep names as shown. ' +
  'Include url/image/description only when clearly present in the markup.';

/**
 * @param {string} html  full page HTML
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]  falls back to ANTHROPIC_API_KEY env
 * @returns {Promise<Array>} raw tree nodes (unnormalized)
 */
export async function extractWithLlm(html, opts = {}) {
  const { model = DEFAULT_MODEL, apiKey } = opts;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'LLM fallback needed but ANTHROPIC_API_KEY is not set. Provide it in .env, ' +
        'or improve the deterministic parse (e.g. try --render).',
    );
  }

  const navHtml = extractNavMarkup(html);
  const client = new Anthropic({ apiKey: key });

  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          'Extract the category tree from this navigation HTML:\n\n' + navHtml,
      },
    ],
  });

  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error('LLM did not return a structured category tree.');
  }
  return Array.isArray(toolUse.input?.categories) ? toolUse.input.categories : [];
}

/**
 * Reduce a full page to just its navigation markup to keep the prompt small
 * and focused. Falls back to the <body> (capped) when no nav is found.
 */
export function extractNavMarkup(html, maxChars = 60_000) {
  const $ = load(html);
  $('script, style, svg, noscript').remove();

  const parts = [];
  $('nav, [role="navigation"], header').each((_i, el) => {
    parts.push($.html(el));
  });

  let markup = parts.join('\n');
  if (!markup.trim()) markup = $('body').html() || html;
  return markup.slice(0, maxChars);
}
