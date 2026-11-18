/**
 * Configuration: merges .env with CLI flags and validates what each run needs.
 * Flags take precedence over environment variables.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VALID_STRATEGIES = ['skip', 'create', 'recreate'];
const VALID_INCLUDES = ['images', 'descriptions', 'urls'];

// Shared with the bigcommerce-admin skill's bc_api.py, intentionally — one
// place to keep named-store credentials so both tools see the same
// environments instead of each maintaining their own copy.
const CONFIG_PATH = join(homedir(), '.bc-cli', 'config.json');

/** Read store_hash/access_token from a config entry, accepting camelCase too. */
function entryCreds(entry) {
  const storeHash = entry.store_hash || entry.storeHash;
  const accessToken = entry.access_token || entry.accessToken;
  return storeHash && accessToken ? { storeHash, accessToken } : null;
}

/** Load and parse the config file (default ~/.bc-cli/config.json), or null if it doesn't exist. */
function loadConfigFile(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }
}

/**
 * Resolve BigCommerce credentials, in priority order:
 *   1. --store/--token flags (both required together)
 *   2. a named environment (--env NAME or BC_ENV) — checked first against
 *      BC_<NAME>_STORE_HASH / BC_<NAME>_ACCESS_TOKEN in .env, then against
 *      ~/.bc-cli/config.json's "environments" map
 *   3. plain BC_STORE_HASH / BC_ACCESS_TOKEN (.env or process env), when no
 *      named environment was requested
 *   4. ~/.bc-cli/config.json's default_environment, or a flat
 *      { store_hash, access_token } config with no "environments" map
 *
 * @param {object} flags  parsed commander options
 * @param {object} [opts]
 * @param {string} [opts.configPath]  override for ~/.bc-cli/config.json (tests only)
 * @returns {{ storeHash: string, accessToken: string }}
 */
export function resolveBcCredentials(flags, opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;

  if (flags.store || flags.token) {
    const missing = [];
    if (!flags.store) missing.push('store hash (--store)');
    if (!flags.token) missing.push('access token (--token)');
    if (missing.length) {
      throw new Error(`Missing BigCommerce credentials: ${missing.join(', ')}.`);
    }
    return { storeHash: flags.store, accessToken: flags.token };
  }

  const envName = flags.env || process.env.BC_ENV;

  if (envName) {
    const prefix = `BC_${envName.toUpperCase()}_`;
    const storeHash = process.env[`${prefix}STORE_HASH`];
    const accessToken = process.env[`${prefix}ACCESS_TOKEN`];
    if (storeHash && accessToken) return { storeHash, accessToken };

    const config = loadConfigFile(configPath);
    const environments = config?.environments;
    if (environments && typeof environments === 'object') {
      const entry = environments[envName];
      const creds = entry && entryCreds(entry);
      if (creds) return creds;
      throw new Error(
        `Environment '${envName}' not found (available: ${Object.keys(environments).join(', ') || 'none'}).`,
      );
    }
    throw new Error(
      `Environment '${envName}' not found — no ${prefix}STORE_HASH/${prefix}ACCESS_TOKEN in .env and no ` +
        `"environments" map in ${configPath}.`,
    );
  }

  if (process.env.BC_STORE_HASH && process.env.BC_ACCESS_TOKEN) {
    return { storeHash: process.env.BC_STORE_HASH, accessToken: process.env.BC_ACCESS_TOKEN };
  }

  const config = loadConfigFile(configPath);
  if (config) {
    const environments = config.environments;
    if (environments && typeof environments === 'object') {
      const defaultName = config.default_environment;
      const entry = defaultName && environments[defaultName];
      const creds = entry && entryCreds(entry);
      if (creds) return creds;
      if (Object.keys(environments).length) {
        throw new Error(
          `Multiple environments in ${configPath} and no valid default_environment set; ` +
            `pass --env <name> (available: ${Object.keys(environments).join(', ')}).`,
        );
      }
    } else {
      const creds = entryCreds(config);
      if (creds) return creds;
    }
  }

  throw new Error(
    'Missing BigCommerce credentials: provide --store/--token, BC_STORE_HASH/BC_ACCESS_TOKEN, ' +
      `--env <name>, or set up ${configPath}.`,
  );
}

/** Parse and validate the --include list (comma-separated). */
export function parseInclude(raw) {
  if (!raw) return [...VALID_INCLUDES];
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = items.filter((i) => !VALID_INCLUDES.includes(i));
  if (bad.length) {
    throw new Error(
      `Invalid --include value(s): ${bad.join(', ')}. Allowed: ${VALID_INCLUDES.join(', ')}.`,
    );
  }
  return items;
}

/** Validate the --on-existing strategy. */
export function parseStrategy(raw) {
  const strategy = (raw || 'skip').toLowerCase();
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new Error(
      `Invalid --on-existing value: ${raw}. Allowed: ${VALID_STRATEGIES.join(', ')}.`,
    );
  }
  return strategy;
}

/** Parse --depth into a positive integer or Infinity. */
export function parseDepth(raw) {
  if (raw == null || raw === '') return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --depth: ${raw}. Must be a positive integer.`);
  }
  return n;
}

/** Parse --limit into a positive integer or Infinity (no limit). */
export function parseLimit(raw) {
  if (raw == null || raw === '') return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --limit: ${raw}. Must be a positive integer.`);
  }
  return n;
}

/** Parse --cost-margin into a 0–100 percentage, or undefined (not set, no cost_price sent). */
export function parseCostMargin(raw) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`Invalid --cost-margin: ${raw}. Must be a number between 0 and 100.`);
  }
  return n;
}

export { VALID_STRATEGIES, VALID_INCLUDES };
