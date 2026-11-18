/**
 * Minimal BigCommerce Catalog API v3 client.
 *
 * Wraps fetch with the store base URL and X-Auth-Token header, parses JSON,
 * and honors rate limiting: on HTTP 429 it waits for the window to reset
 * (X-Rate-Limit-Time-Reset-Ms) and retries.
 */

const API_ROOT = 'https://api.bigcommerce.com';
const MAX_RETRIES = 4;

export class BigCommerceClient {
  /**
   * @param {object} opts
   * @param {string} opts.storeHash
   * @param {string} opts.accessToken
   */
  constructor({ storeHash, accessToken }) {
    if (!storeHash) throw new Error('BigCommerce store hash is required.');
    if (!accessToken) throw new Error('BigCommerce access token is required.');
    this.base = `${API_ROOT}/stores/${storeHash}/v3`;
    this.token = accessToken;
  }

  /**
   * @param {string} method
   * @param {string} path  e.g. "/catalog/trees"
   * @param {object} [body]
   * @returns {Promise<any>} parsed `data` (or full body when no `data` field)
   */
  async request(method, path, body) {
    const url = `${this.base}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const res = await fetch(url, {
        method,
        headers: {
          'X-Auth-Token': this.token,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const resetMs = Number(res.headers.get('X-Rate-Limit-Time-Reset-Ms')) || 2000;
        await sleep(resetMs);
        continue;
      }

      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;

      if (!res.ok) {
        // `title` is often a generic bucket (e.g. "Missing Required Fields") while the real
        // culprit is in `errors` (per-field messages) — surface both when present.
        const parts = [];
        if (parsed?.title) parts.push(parsed.title);
        if (parsed?.errors && Object.keys(parsed.errors).length) parts.push(stringifyDetail(parsed.errors));
        const detail = parts.length ? parts.join(' — ') : text || res.statusText;
        throw new Error(`BigCommerce ${method} ${path} → HTTP ${res.status}: ${detail}`);
      }

      // v3 wraps payloads in { data, meta }; unwrap when present.
      return parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
        ? parsed.data
        : parsed;
    }

    throw new Error(`BigCommerce ${method} ${path}: exhausted retries (rate limited).`);
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  put(path, body) {
    return this.request('PUT', path, body);
  }

  delete(path) {
    return this.request('DELETE', path);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function stringifyDetail(detail) {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
