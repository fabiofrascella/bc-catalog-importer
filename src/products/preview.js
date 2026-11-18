/**
 * Pretty-print the normalized product catalog for the pre-push preview /
 * confirmation gate.
 */

/** One-line summary: product count and price range (real prices only). */
export function summarize(products) {
  if (!products.length) return '0 products';
  const realPrices = products.filter((p) => !p.priceIsFake).map((p) => p.price);
  const fakeCount = products.length - realPrices.length;
  const fakeNote = fakeCount ? `, ${fakeCount} not purchasable (no price found)` : '';

  if (!realPrices.length) {
    return `${products.length} product${products.length === 1 ? '' : 's'}${fakeNote}`;
  }
  const min = Math.min(...realPrices);
  const max = Math.max(...realPrices);
  const range = min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)}–$${max.toFixed(2)}`;
  return `${products.length} product${products.length === 1 ? '' : 's'}, ${range}${fakeNote}`;
}

/** One-line variant summary, e.g. "variants: 3 (Color, Size) — Red/S, Red/M, +1 more". */
function variantsLine(product) {
  if (!product.variants.length) return '';
  const axes = [...new Set(product.variants.flatMap((v) => v.optionValues.map((o) => o.name)))];
  const maxShown = 4;
  const shown = product.variants.slice(0, maxShown).map((v) => {
    const combo = v.optionValues.map((o) => o.value).join('/');
    const priceNote = v.priceOverride != null ? ` $${v.priceOverride.toFixed(2)}` : '';
    const imageNote = v.image ? ' [img]' : '';
    return `${combo}${priceNote}${imageNote}`;
  });
  const more = product.variants.length > maxShown ? `, +${product.variants.length - maxShown} more` : '';
  return `\n   variants: ${product.variants.length} (${axes.join(', ')}) — ${shown.join(', ')}${more}`;
}

/** Print the full preview block to stdout. */
export function printPreview(products, { warnings = [], errors = [], costMarginPercent } = {}) {
  console.log('\nProducts:');
  products.forEach((p, i) => {
    const fields = p.customFields.map((f) => `${f.name}=${f.value}`).join(', ') || '(none)';
    const categories = p.categories.join(', ') || '(none)';
    const skuNote = p.skuGenerated ? ' (auto-generated)' : '';
    const costNote =
      costMarginPercent != null && !p.priceIsFake
        ? ` (cost: $${(p.price * (1 - costMarginPercent / 100)).toFixed(2)}, ${costMarginPercent}% margin)`
        : '';
    const priceLabel = p.priceIsFake
      ? `$${p.price.toFixed(2)} (fake — not purchasable)`
      : `$${p.price.toFixed(2)}${costNote}`;
    const brandNote = p.brandName ? `  brand: ${p.brandName}` : '';
    console.log(
      `${i + 1}. ${p.name} [${p.sku}]${skuNote} — ${priceLabel}\n` +
        `   categories: ${categories}${brandNote}\n` +
        `   images: ${p.images.length}  custom fields: ${fields}${variantsLine(p)}`,
    );
  });
  console.log(`\n(${summarize(products)})`);

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (errors.length) {
    console.log(`\n${errors.length} entrie(s) dropped (could not be normalized):`);
    for (const e of errors) console.log(`  - ${e}`);
  }
  console.log('');
}
