import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNav, scoreTree } from '../src/scrape/navParser.js';
import { normalizeTree } from '../src/tree/model.js';

const MEGA_MENU_HTML = `
<!doctype html><html><body>
  <header>
    <nav aria-label="Main navigation">
      <ul>
        <li><a href="/men">Men</a>
          <ul>
            <li><a href="/men/shoes">Shoes</a>
              <ul><li><a href="/men/shoes/sneakers">Sneakers</a></li></ul>
            </li>
            <li><a href="/men/shirts">Shirts</a></li>
          </ul>
        </li>
        <li><a href="/women">Women</a>
          <ul><li><a href="/women/dresses">Dresses</a></li></ul>
        </li>
        <li><a href="/login">Login</a></li>
      </ul>
    </nav>
  </header>
</body></html>`;

const FLAT_HTML = `
<!doctype html><html><body>
  <nav><a href="/a">A</a></nav>
</body></html>`;

test('parseNav extracts nested mega-menu hierarchy', () => {
  const { tree, score } = parseNav(MEGA_MENU_HTML, 'https://m.com');
  const clean = normalizeTree(tree, { origin: 'https://m.com' });

  const names = clean.map((n) => n.name);
  assert.deepEqual(names, ['Men', 'Women']); // Login stripped by normalize

  const men = clean.find((n) => n.name === 'Men');
  assert.deepEqual(men.children.map((c) => c.name).sort(), ['Shirts', 'Shoes']);
  const shoes = men.children.find((c) => c.name === 'Shoes');
  assert.equal(shoes.children[0].name, 'Sneakers');
  assert.equal(shoes.url, 'https://m.com/men/shoes');

  assert.ok(score >= 6, `expected a strong score, got ${score}`);
});

test('scoreTree rewards nesting and breadth', () => {
  const nested = [{ name: 'A', children: [{ name: 'B', children: [] }] }];
  const flat = [{ name: 'A', children: [] }];
  assert.ok(scoreTree(nested) > scoreTree(flat));
  assert.equal(scoreTree([]), 0);
});

test('flat single-link nav scores below the weak threshold', () => {
  const { score } = parseNav(FLAT_HTML, 'https://m.com');
  assert.ok(score < 6, `expected weak score, got ${score}`);
});
