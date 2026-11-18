import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBcCredentials, parseCostMargin } from '../src/config.js';

// dotenv (imported by config.js) loads real BC_* values from this repo's own
// .env at module-load time — isolate every test from that (and from each
// other) by snapshotting/clearing all BC_* vars around each test.
let savedBcEnv;
beforeEach(() => {
  savedBcEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BC_')) {
      savedBcEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BC_')) delete process.env[key];
  }
  Object.assign(process.env, savedBcEnv);
});

/** Write a throwaway ~/.bc-cli/config.json-shaped fixture and return its path. */
function tempConfigFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'bc-cli-test-'));
  const file = join(dir, 'config.json');
  if (content !== undefined) writeFileSync(file, JSON.stringify(content));
  return file;
}

test('resolveBcCredentials: --store/--token flags win over everything else', () => {
  process.env.BC_STORE_HASH = 'env-hash';
  process.env.BC_ACCESS_TOKEN = 'env-token';
  const creds = resolveBcCredentials({ store: 'flag-hash', token: 'flag-token' });
  assert.deepEqual(creds, { storeHash: 'flag-hash', accessToken: 'flag-token' });
});

test('resolveBcCredentials: --store without --token is a validation error', () => {
  assert.throws(() => resolveBcCredentials({ store: 'flag-hash' }), /access token \(--token\)/);
});

test('resolveBcCredentials: plain BC_STORE_HASH/BC_ACCESS_TOKEN env vars are used with no flags', () => {
  process.env.BC_STORE_HASH = 'env-hash';
  process.env.BC_ACCESS_TOKEN = 'env-token';
  const creds = resolveBcCredentials({});
  assert.deepEqual(creds, { storeHash: 'env-hash', accessToken: 'env-token' });
});

test('resolveBcCredentials: --env resolves via BC_<NAME>_STORE_HASH/BC_<NAME>_ACCESS_TOKEN env vars', () => {
  process.env.BC_STAGING_STORE_HASH = 'staging-hash';
  process.env.BC_STAGING_ACCESS_TOKEN = 'staging-token';
  const creds = resolveBcCredentials({ env: 'staging' });
  assert.deepEqual(creds, { storeHash: 'staging-hash', accessToken: 'staging-token' });
});

test('resolveBcCredentials: BC_ENV acts like --env when no --env flag is given', () => {
  process.env.BC_ENV = 'staging';
  process.env.BC_STAGING_STORE_HASH = 'staging-hash';
  process.env.BC_STAGING_ACCESS_TOKEN = 'staging-token';
  const creds = resolveBcCredentials({});
  assert.deepEqual(creds, { storeHash: 'staging-hash', accessToken: 'staging-token' });
});

test('resolveBcCredentials: --env falls back to ~/.bc-cli/config.json "environments" map', () => {
  const configPath = tempConfigFile({
    environments: { staging: { store_hash: 'cfg-hash', access_token: 'cfg-token' } },
  });
  const creds = resolveBcCredentials({ env: 'staging' }, { configPath });
  assert.deepEqual(creds, { storeHash: 'cfg-hash', accessToken: 'cfg-token' });
});

test('resolveBcCredentials: config file entries accept camelCase keys too', () => {
  const configPath = tempConfigFile({
    environments: { staging: { storeHash: 'cfg-hash', accessToken: 'cfg-token' } },
  });
  const creds = resolveBcCredentials({ env: 'staging' }, { configPath });
  assert.deepEqual(creds, { storeHash: 'cfg-hash', accessToken: 'cfg-token' });
});

test('resolveBcCredentials: an unknown --env name throws, listing what is available', () => {
  const configPath = tempConfigFile({
    environments: { prod: { store_hash: 'a', access_token: 'b' } },
  });
  assert.throws(
    () => resolveBcCredentials({ env: 'staging' }, { configPath }),
    /Environment 'staging' not found \(available: prod\)/,
  );
});

test('resolveBcCredentials: falls back to config file default_environment when nothing else is set', () => {
  const configPath = tempConfigFile({
    default_environment: 'prod',
    environments: {
      prod: { store_hash: 'prod-hash', access_token: 'prod-token' },
      staging: { store_hash: 'staging-hash', access_token: 'staging-token' },
    },
  });
  const creds = resolveBcCredentials({}, { configPath });
  assert.deepEqual(creds, { storeHash: 'prod-hash', accessToken: 'prod-token' });
});

test('resolveBcCredentials: multiple environments with no default_environment throws, listing names', () => {
  const configPath = tempConfigFile({
    environments: {
      prod: { store_hash: 'a', access_token: 'b' },
      staging: { store_hash: 'c', access_token: 'd' },
    },
  });
  assert.throws(
    () => resolveBcCredentials({}, { configPath }),
    /no valid default_environment set.*available: prod, staging/,
  );
});

test('resolveBcCredentials: a flat config (no "environments" map) is used directly', () => {
  const configPath = tempConfigFile({ store_hash: 'flat-hash', access_token: 'flat-token' });
  const creds = resolveBcCredentials({}, { configPath });
  assert.deepEqual(creds, { storeHash: 'flat-hash', accessToken: 'flat-token' });
});

test('resolveBcCredentials: no credentials anywhere throws a helpful error', () => {
  const configPath = tempConfigFile(undefined); // no file written
  assert.throws(() => resolveBcCredentials({}, { configPath }), /Missing BigCommerce credentials/);
});

test('resolveBcCredentials: a malformed config.json surfaces a parse error, not a silent skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-cli-test-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{ not valid json');
  assert.throws(() => resolveBcCredentials({}, { configPath }), /Could not parse/);
});

test('parseCostMargin: omitted/empty returns undefined (no cost_price sent)', () => {
  assert.equal(parseCostMargin(undefined), undefined);
  assert.equal(parseCostMargin(''), undefined);
});

test('parseCostMargin: parses a valid percentage', () => {
  assert.equal(parseCostMargin('20'), 20);
  assert.equal(parseCostMargin('0'), 0);
  assert.equal(parseCostMargin('100'), 100);
});

test('parseCostMargin: rejects out-of-range or non-numeric values', () => {
  assert.throws(() => parseCostMargin('-5'), /Invalid --cost-margin/);
  assert.throws(() => parseCostMargin('101'), /Invalid --cost-margin/);
  assert.throws(() => parseCostMargin('abc'), /Invalid --cost-margin/);
});
