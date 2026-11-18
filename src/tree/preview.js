/**
 * Pretty-print a category tree for the pre-push preview / confirmation gate.
 * Each node shows badges for the extra data it carries: [url] [img] [desc].
 */

import { countNodes, maxDepth } from './model.js';

function badges(node) {
  const b = [];
  if (node.url) b.push('url');
  if (node.image) b.push('img');
  if (node.description) b.push('desc');
  return b.length ? `  [${b.join('][')}]` : '';
}

/**
 * Render the tree to a string with box-drawing connectors.
 * @param {Array} nodes
 * @returns {string}
 */
export function renderTree(nodes) {
  const lines = [];
  renderLevel(nodes, '', lines);
  return lines.join('\n');
}

function renderLevel(nodes, prefix, lines) {
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    const connector = last ? '└─ ' : '├─ ';
    lines.push(`${prefix}${connector}${node.name}${badges(node)}`);
    if (node.children?.length) {
      const childPrefix = prefix + (last ? '   ' : '│  ');
      renderLevel(node.children, childPrefix, lines);
    }
  });
}

/** One-line summary: node count and depth. */
export function summarize(nodes) {
  return `${countNodes(nodes)} categories, ${maxDepth(nodes)} levels deep`;
}

/** Print the full preview block to stdout. */
export function printPreview(nodes) {
  console.log('\nCategory tree:');
  console.log(renderTree(nodes));
  console.log(`\n(${summarize(nodes)})\n`);
}
