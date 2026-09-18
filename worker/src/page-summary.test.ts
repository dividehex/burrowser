import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPage, PAGE_LIMITS, summarizePage } from './page-summary.ts';

const heading = (tag: string, text: string, ariaLevel?: string) => ({ tagName: tag, innerText: text, getAttribute: (name: string) => name === 'aria-level' ? ariaLevel ?? null : null });

/** collectPage runs inside the browser; give it just enough of a DOM to exercise its own logic in Node. */
function withDocument<T>(fake: { title: string; headings: any[]; body: string | null }, run: () => T): T {
  const g = globalThis as any;
  const original = g.document;
  g.document = { title: fake.title, querySelectorAll: () => fake.headings, body: fake.body === null ? null : { innerText: fake.body } };
  try { return run(); } finally { g.document = original; }
}

test('collectPage reads title, heading levels (tags and aria-level), skips empty headings, and caps the text it returns', () => {
  const page = withDocument({
    title: 'Example Domain',
    headings: [heading('H1', 'Example Domain'), heading('H2', '   '), heading('H3', 'A  spaced\n heading'), heading('DIV', 'Custom', '4'), heading('SPAN', 'No level given')],
    body: 'x'.repeat(50),
  }, () => collectPage({ textChars: 10 }));
  assert.equal(page.title, 'Example Domain');
  assert.deepEqual(page.headings, [{ level: 1, text: 'Example Domain' }, { level: 3, text: 'A spaced heading' }, { level: 4, text: 'Custom' }, { level: 2, text: 'No level given' }]);
  assert.equal(page.text.length, 11, 'one character past the limit, so the caller can tell it was cut');
  assert.equal(withDocument({ title: '', headings: [], body: null }, () => collectPage({ textChars: 10 })).text, '', 'a page with no body yields empty text');
});

test('collectPage stops collecting headings on pathological pages', () => {
  const many = Array.from({ length: 2000 }, (_, i) => heading('H2', `heading ${i}`));
  assert.equal(withDocument({ title: 't', headings: many, body: '' }, () => collectPage({ textChars: 10 })).headings.length, 500);
});

test('summarizePage passes a small page through unchanged and flags nothing', () => {
  const summary = summarizePage('https://example.com/', { title: '  Example  Domain ', headings: [{ level: 1, text: 'Example Domain' }], text: 'Example Domain\n\nThis domain is for use in examples.' });
  assert.deepEqual(summary, {
    url: 'https://example.com/', title: 'Example Domain', headings: [{ level: 1, text: 'Example Domain' }], headingsTruncated: false,
    text: 'Example Domain\n\nThis domain is for use in examples.', textTruncated: false,
  });
});

test('summarizePage bounds text, heading count and heading length, and says so', () => {
  const limits = { textChars: 20, headings: 3, headingChars: 8 };
  const summary = summarizePage('https://x/', {
    title: 't',
    headings: [1, 2, 3, 4, 5].map(level => ({ level, text: 'a very long heading indeed' })),
    text: 'y'.repeat(21),
  }, limits);
  assert.equal(summary.headings.length, 3);
  assert.ok(summary.headings.every(h => h.text.length === 8));
  assert.equal(summary.headingsTruncated, true);
  assert.equal(summary.text.length, 20);
  assert.equal(summary.textTruncated, true);
  assert.equal(summarizePage('https://x/', { title: '', headings: [], text: 'y'.repeat(20) }, limits).textTruncated, false, 'exactly at the limit is not truncated');
});

test('summarizePage normalises odd heading levels and drops empty headings before counting', () => {
  const summary = summarizePage('https://x/', { title: '', headings: [{ level: 0, text: 'zero' }, { level: 9, text: 'nine' }, { level: 2.7, text: 'frac' }, { level: NaN, text: 'nan' }, { level: 1, text: '  ' }], text: '' });
  assert.deepEqual(summary.headings.map(h => h.level), [2, 6, 2, 2], 'zero and NaN fall back to 2; 9 clamps to 6; 2.7 truncates to 2; the blank heading is gone');
  assert.equal(PAGE_LIMITS.textChars, 20_000);
});
