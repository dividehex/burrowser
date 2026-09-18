import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { keepBrowserAlive } from './keep-alive.ts';

function fakeContext(initialUrls: string[] = []) {
  const emitter = new EventEmitter();
  const pages: any[] = [];
  let opened = 0;
  const makePage = (url: string) => {
    const page: any = new EventEmitter();
    page.url = () => url;
    page.close = async () => { pages.splice(pages.indexOf(page), 1); page.emit('close'); };
    return page;
  };
  const addPage = (url = 'about:blank') => { const page = makePage(url); pages.push(page); emitter.emit('page', page); return page; };
  initialUrls.forEach(url => pages.push(makePage(url)));
  const context: any = {
    on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
    pages: () => pages,
    newPage: async () => { opened++; return addPage(); },
  };
  return { context, emitter, pages, addPage, opened: () => opened };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('closing the last tab opens a new one, but closing one of several does not', async () => {
  const { context, pages, opened } = fakeContext(['https://a.example/', 'https://b.example/']);
  keepBrowserAlive(context, () => {}, 0);
  await pages[1].close();
  assert.equal(opened(), 0);
  await pages[0].close();
  await tick();
  assert.equal(opened(), 1);
  assert.equal(pages.length, 1);
});

test('tabs opened later are watched too, and the replacement tab is itself kept', async () => {
  const { context, pages, addPage, opened } = fakeContext();
  keepBrowserAlive(context, () => {}, 0);
  await addPage('https://a.example/').close();
  await tick();
  assert.equal(opened(), 1);
  await pages[0].close();
  await tick();
  assert.equal(opened(), 2);
  assert.equal(pages.length, 1);
});

test('a second blank tab created by Playwright MCP after the last one closed is dropped', async () => {
  const { context, pages, addPage } = fakeContext(['https://a.example/']);
  keepBrowserAlive(context, () => {}, 0);
  await pages[0].close();
  addPage();
  await tick();
  assert.equal(pages.length, 1);
});

test('surplus blank tabs are left alone when any tab has content', async () => {
  const { context, pages, addPage } = fakeContext(['https://a.example/']);
  keepBrowserAlive(context, () => {}, 0);
  await pages[0].close();
  addPage('https://b.example/');
  await tick();
  assert.deepEqual(pages.map(page => page.url()), ['about:blank', 'https://b.example/']);
});

test('a context close is reported', () => {
  const { context, emitter } = fakeContext();
  let closed = 0;
  keepBrowserAlive(context, () => { closed++; });
  emitter.emit('close');
  assert.equal(closed, 1);
});
