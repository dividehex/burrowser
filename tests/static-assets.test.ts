import test from 'node:test';
import assert from 'node:assert/strict';
import { serveNovncAsset } from '../src/static-assets.ts';

function fakeResponse() {
  const value: { status?: number; headers?: Record<string, string>; body?: Buffer } = {};
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) { value.status = status; value.headers = headers; },
    end(body?: unknown) { if (body !== undefined) value.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); },
  };
  return { value, res };
}

test('serveNovncAsset rejects a path-traversal attempt outside the package root', async () => {
  const { value, res } = fakeResponse();
  await serveNovncAsset('/novnc/../../../../etc/passwd', res);
  assert.equal(value.status, 403);
});

test('serveNovncAsset serves a real file within the package with the right content type', async () => {
  const { value, res } = fakeResponse();
  await serveNovncAsset('/novnc/core/rfb.js', res);
  assert.equal(value.status, 200);
  assert.match(value.headers!['content-type'], /javascript/);
  assert.match(value.body!.toString(), /RFB/);
});

test('serveNovncAsset 404s a missing file', async () => {
  const { value, res } = fakeResponse();
  await serveNovncAsset('/novnc/core/does-not-exist.js', res);
  assert.equal(value.status, 404);
});
