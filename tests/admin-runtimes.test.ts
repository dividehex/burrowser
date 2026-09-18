import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRuntimes, liveRuntimes, writeDiff, writeSnapshot, type AdminRuntime } from '../src/admin-runtimes.ts';

function runtime(overrides: Partial<AdminRuntime> = {}): AdminRuntime {
  return { id: 'p1', name: 'Main', state: 'READY', agentId: 'a1', agentDisplayName: 'agent-a', createdAt: 0, lastUsedAt: 0, ...overrides };
}

test('liveRuntimes only keeps STARTING/READY/IDLE, so stopped profiles fall off the dashboard', () => {
  const runtimes = [runtime({ id: 'p1', state: 'READY' }), runtime({ id: 'p2', state: 'STOPPED' }), runtime({ id: 'p3', state: 'FAILED' }), runtime({ id: 'p4', state: 'STARTING' })];
  assert.deepEqual(liveRuntimes(runtimes).map(r => r.id), ['p1', 'p4']);
});

test('diffRuntimes reports a new runtime as updated', () => {
  const { updated, removed } = diffRuntimes(new Map(), [runtime()]);
  assert.deepEqual(updated, [runtime()]);
  assert.deepEqual(removed, []);
});

test('diffRuntimes is silent when nothing relevant changed', () => {
  const previous = new Map([['p1', runtime()]]);
  const { updated, removed } = diffRuntimes(previous, [runtime()]);
  assert.deepEqual(updated, []);
  assert.deepEqual(removed, []);
});

test('diffRuntimes reports a state change as updated', () => {
  const previous = new Map([['p1', runtime({ state: 'STARTING' })]]);
  const { updated } = diffRuntimes(previous, [runtime({ state: 'READY' })]);
  assert.deepEqual(updated, [runtime({ state: 'READY' })]);
});

test('diffRuntimes reports a runtime missing from the current list as removed', () => {
  const previous = new Map([['p1', runtime()]]);
  const { updated, removed } = diffRuntimes(previous, []);
  assert.deepEqual(updated, []);
  assert.deepEqual(removed, ['p1']);
});

test('writeSnapshot and writeDiff format Server-Sent Events frames', () => {
  const chunks: string[] = [];
  const sink = { write: (chunk: string) => chunks.push(chunk) };
  writeSnapshot(sink, [runtime()]);
  writeDiff(sink, { updated: [runtime({ state: 'STARTING' })], removed: ['p9'] });
  assert.equal(chunks[0], `event: snapshot\ndata: ${JSON.stringify([runtime()])}\n\n`);
  assert.equal(chunks[1], `event: update\ndata: ${JSON.stringify([runtime({ state: 'STARTING' })])}\n\n`);
  assert.equal(chunks[2], `event: removed\ndata: ${JSON.stringify({ id: 'p9' })}\n\n`);
});

test('writeDiff sends nothing when the diff is empty', () => {
  const chunks: string[] = [];
  const sink = { write: (chunk: string) => chunks.push(chunk) };
  writeDiff(sink, { updated: [], removed: [] });
  assert.deepEqual(chunks, []);
});
