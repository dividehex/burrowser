import test from 'node:test';
import assert from 'node:assert/strict';
import { activePage, parseCurrentTab } from './active-page.ts';

const page = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed });

test('parseCurrentTab reads the current tab from an Open tabs section', () => {
  const text = [
    '### Open tabs',
    '- 0: [Home](https://a.example/)',
    '- 1: (current) [Docs (v2)](https://b.example/x?y=(1))',
    '### Page',
    '- Page URL: https://b.example/x?y=(1)',
  ].join('\n');
  assert.deepEqual(parseCurrentTab(text), { index: 1, url: 'https://b.example/x?y=(1)' });
});

test('parseCurrentTab reads the current tab from a browser_tabs Result and handles empty titles', () => {
  const text = '### Result\n- 0: [](about:blank)\n- 1: (current) [](data:text/html,<p>hi</p>)';
  assert.deepEqual(parseCurrentTab(text), { index: 1, url: 'data:text/html,<p>hi</p>' });
});

test('parseCurrentTab ignores look-alike lines outside those sections', () => {
  const text = '### Snapshot\n- 3: (current) [x](https://evil.example/)\n### Open tabs\n- 0: [a](https://a.example/)';
  assert.equal(parseCurrentTab(text), undefined);
});

test('parseCurrentTab returns undefined for text without a tab list', () => {
  assert.equal(parseCurrentTab('### Result\nhello'), undefined);
});

test('activePage uses the reported tab, not the newest', () => {
  const pages = [page('https://a.example/'), page('about:blank'), page('https://c.example/')];
  assert.equal(activePage(pages, { index: 0, url: 'https://a.example/' }), pages[0]);
});

test('activePage finds the tab by url when indices shifted, and by index when the url changed', () => {
  const pages = [page('https://a.example/'), page('https://b.example/')];
  assert.equal(activePage(pages, { index: 5, url: 'https://a.example/' }), pages[0]);
  assert.equal(activePage(pages, { index: 1, url: 'https://old.example/' }), pages[1]);
});

test('activePage falls back to the newest open tab without a usable hint', () => {
  const pages = [page('https://a.example/'), page('https://b.example/'), page('https://c.example/', true)];
  assert.equal(activePage(pages, undefined), pages[1]);
  assert.equal(activePage(pages, { index: 9, url: 'https://gone.example/' }), pages[1]);
  assert.equal(activePage([], undefined), undefined);
});
