import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkImage, filterInvalidImages, MAX_IMAGE_BYTES } from '../src/products/images.js';

function fakeFetch(headers = {}, ok = true) {
  return async () => ({
    ok,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });
}

test('checkImage: sizeOk when content-length is under the limit', async () => {
  const result = await checkImage('https://m.com/a.jpg', {
    fetchImpl: fakeFetch({ 'content-length': String(1024) }),
  });
  assert.equal(result.sizeOk, true);
  assert.equal(result.bytes, 1024);
});

test('checkImage: not sizeOk when content-length is over the limit', async () => {
  const overLimit = MAX_IMAGE_BYTES + 1024;
  const result = await checkImage('https://m.com/big.jpg', {
    fetchImpl: fakeFetch({ 'content-length': String(overLimit) }),
  });
  assert.equal(result.sizeOk, false);
  assert.equal(result.bytes, overLimit);
});

test('checkImage: passes through (sizeOk/formatOk) when nothing can be determined', async () => {
  const noHeaders = await checkImage('https://m.com/a.jpg', { fetchImpl: fakeFetch({}, false) });
  assert.equal(noHeaders.sizeOk, true);
  assert.equal(noHeaders.formatOk, true);

  const okNoContentType = await checkImage('https://m.com/a.jpg', { fetchImpl: fakeFetch({}) });
  assert.equal(okNoContentType.sizeOk, true);
  assert.equal(okNoContentType.formatOk, true);

  const throwingFetch = async () => {
    throw new Error('network error');
  };
  const onError = await checkImage('https://m.com/a.jpg', { fetchImpl: throwingFetch });
  assert.equal(onError.sizeOk, true);
  assert.equal(onError.formatOk, true);
});

test('checkImage: not formatOk for an unsupported content-type (e.g. TIFF)', async () => {
  const result = await checkImage('https://m.com/a.tiff', {
    fetchImpl: fakeFetch({ 'content-type': 'image/tiff' }),
  });
  assert.equal(result.formatOk, false);
  assert.equal(result.contentType, 'image/tiff');
});

test('checkImage: formatOk for a supported content-type', async () => {
  const result = await checkImage('https://m.com/a.jpg', {
    fetchImpl: fakeFetch({ 'content-type': 'image/jpeg; charset=utf-8' }),
  });
  assert.equal(result.formatOk, true);
});

test('checkImage: falls back to a ranged GET when HEAD is rejected (e.g. 405), revealing the real format', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    if (init.method === 'HEAD') return { ok: false, headers: { get: () => null } };
    // A ranged GET the host actually honors: 206, real content-type, and a
    // Content-Range revealing a full size the small chunk alone wouldn't show.
    return {
      ok: true,
      headers: {
        get: (name) =>
          ({ 'content-type': 'image/tiff', 'content-range': 'bytes 0-1023/2485312' })[name.toLowerCase()] ?? null,
      },
      body: { cancel: async () => {} },
    };
  };
  const result = await checkImage('https://pim.example.com/?id=36208', { fetchImpl });
  assert.deepEqual(calls, ['HEAD', 'GET']);
  assert.equal(result.formatOk, false);
  assert.equal(result.contentType, 'image/tiff');
  assert.equal(result.bytes, 2485312); // from Content-Range's total, not the 1024-byte chunk fetched
});

test('checkImage: a ranged-GET fallback reporting a huge Content-Range total is flagged oversized without downloading it', async () => {
  let cancelled = false;
  const fetchImpl = async (url, init) => {
    if (init.method === 'HEAD') return { ok: false, headers: { get: () => null } };
    return {
      ok: true,
      headers: {
        get: (name) =>
          ({ 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-1023/164620994' })[
            name.toLowerCase()
          ] ?? null,
      },
      body: { cancel: async () => { cancelled = true; } },
    };
  };
  const result = await checkImage('https://pim.example.com/?id=66643', { fetchImpl });
  assert.equal(result.sizeOk, false);
  assert.equal(result.bytes, 164620994);
  assert.equal(cancelled, true); // the 157 MB body was never actually read
});

test('checkImage: passes through when both HEAD and the ranged-GET fallback fail', async () => {
  const fetchImpl = async () => {
    throw new Error('network error');
  };
  const result = await checkImage('https://m.com/a.jpg', { fetchImpl });
  assert.equal(result.sizeOk, true);
  assert.equal(result.formatOk, true);
});

test('filterInvalidImages: drops only the confirmed-oversized or unsupported-format images', async () => {
  const headersByUrl = {
    'https://m.com/small.jpg': { 'content-length': '1024', 'content-type': 'image/jpeg' },
    'https://m.com/big.jpg': { 'content-length': String(MAX_IMAGE_BYTES + 1) },
    'https://m.com/unknown.jpg': {},
    'https://m.com/scan.tiff': { 'content-type': 'image/tiff' },
  };
  const fetchImpl = async (url) => ({
    ok: true,
    headers: { get: (name) => headersByUrl[url]?.[name.toLowerCase()] ?? null },
  });

  const logs = [];
  const kept = await filterInvalidImages(Object.keys(headersByUrl), {
    fetchImpl,
    log: (msg) => logs.push(msg),
  });

  assert.deepEqual(kept, ['https://m.com/small.jpg', 'https://m.com/unknown.jpg']);
  assert.equal(logs.length, 2);
  assert.ok(logs.some((l) => /big\.jpg/.test(l)));
  assert.ok(logs.some((l) => /scan\.tiff/.test(l) && /unsupported/.test(l)));
});

test('filterInvalidImages: no-op on an empty list', async () => {
  assert.deepEqual(await filterInvalidImages([]), []);
});
