/**
 * Pre-flight checks for BigCommerce's per-image upload rules — an 8 MB size
 * cap and a limited set of supported formats — both enforced server-side
 * when it fetches the URL during product create. A single HEAD request per
 * image reads Content-Length and Content-Type so an oversized or unsupported
 * image can be dropped up front — losing one image is much better than the
 * whole product create failing with a 4xx ("8 MB size limit... exceeded" /
 * "image/tiff format is not supported by platform").
 *
 * Some asset hosts (seen in the wild: a merchant's PIM/DAM asset proxy that
 * serves print-ready originals — multi-hundred-MB PSDs/TIFFs — behind a
 * plain query-string URL) reject HEAD outright (405) or return nothing
 * useful on it, which used to make this pre-check a no-op for that host: the
 * bad image sailed through undetected, only for BigCommerce's own
 * server-side fetch to reject it at create time — and products.js's fallback
 * for that case retries with *no images at all*, so one such image quietly
 * cost the product every photo it had. When HEAD comes back non-ok, a
 * ranged GET (`Range: bytes=0-1023`) is tried instead: it still reveals the
 * real Content-Type, and — via `Content-Range: bytes .../TOTAL` on a server
 * that honors the range — the real full size, without downloading the file
 * itself. The response body is cancelled immediately either way.
 */

// Stay under BigCommerce's ~8 MB cap with a safety margin (unit ambiguity,
// plus the server may account for more than just the raw file bytes).
const MAX_IMAGE_BYTES = 7.5 * 1024 * 1024;

// BigCommerce's documented supported product image formats.
const SUPPORTED_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/pjpeg', 'image/png', 'image/webp']);

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ sizeOk: boolean, formatOk: boolean, bytes?: number, contentType?: string }>}
 *   *Ok flags are false only when confirmed bad — unknown/unreachable passes through as ok,
 *   leaving BigCommerce's own validation as the final word.
 */
export async function checkImage(url, opts = {}) {
  const { fetchImpl = fetch } = opts;

  const head = await safeFetch(fetchImpl, url, 'HEAD');
  if (head?.ok) return resultFromHeaders(head.headers);

  const ranged = await safeFetch(fetchImpl, url, 'GET', { Range: 'bytes=0-1023' });
  if (ranged) {
    const result = ranged.ok ? resultFromHeaders(ranged.headers) : { sizeOk: true, formatOk: true };
    await cancelBody(ranged);
    return result;
  }

  return { sizeOk: true, formatOk: true }; // nothing usable from either request — let BigCommerce's own validation be the final word
}

/** Fetch, swallowing network errors into `null` rather than throwing. */
async function safeFetch(fetchImpl, url, method, headers) {
  try {
    return await fetchImpl(url, { method, ...(headers ? { headers } : {}) });
  } catch {
    return null;
  }
}

/** Best-effort release of a response body we only read headers from. */
async function cancelBody(res) {
  try {
    await res.body?.cancel?.();
  } catch {
    // already consumed/closed — nothing to release
  }
}

/** Derive the sizeOk/formatOk verdict from a response's headers. */
function resultFromHeaders(headers) {
  // A ranged request that's honored reports the resource's real full size in
  // Content-Range ("bytes 0-1023/164620994"), even though Content-Length on
  // that same response only covers the small chunk actually sent.
  const contentRange = headers.get('content-range');
  const rangeTotal = contentRange ? Number(contentRange.split('/')[1]) : NaN;
  const bytes = Number.isFinite(rangeTotal) ? rangeTotal : Number(headers.get('content-length'));
  const sizeOk = !Number.isFinite(bytes) || bytes <= 0 || bytes <= MAX_IMAGE_BYTES;

  const contentType = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const formatOk = !contentType || SUPPORTED_IMAGE_TYPES.has(contentType);

  return { sizeOk, formatOk, bytes: Number.isFinite(bytes) ? bytes : undefined, contentType: contentType || undefined };
}

/**
 * Drop images confirmed to be oversized or an unsupported format; images that
 * couldn't be checked pass through unchanged.
 *
 * @param {string[]} images
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function filterInvalidImages(images, opts = {}) {
  const { log = () => {}, fetchImpl } = opts;
  if (!images.length) return images;

  const checks = await Promise.all(images.map((url) => checkImage(url, { fetchImpl })));
  const kept = [];
  checks.forEach((result, i) => {
    if (!result.sizeOk) {
      const mb = (result.bytes / (1024 * 1024)).toFixed(1);
      log(`    dropping oversized image (${mb} MB > 8 MB limit): ${images[i]}`);
    } else if (!result.formatOk) {
      log(`    dropping unsupported image format (${result.contentType}): ${images[i]}`);
    } else {
      kept.push(images[i]);
    }
  });
  return kept;
}

export { MAX_IMAGE_BYTES };
