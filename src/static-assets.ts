import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };
const NOVNC_ROOT = fileURLToPath(new URL('../node_modules/@novnc/novnc/', import.meta.url));
const VIEW_HTML_PATH = fileURLToPath(new URL('./view.html', import.meta.url));
const ADMIN_DASHBOARD_HTML_PATH = fileURLToPath(new URL('./admin-dashboard.html', import.meta.url));

export async function serveViewPage(res: ServerResponse) {
  const html = await readFile(VIEW_HTML_PATH, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(html);
}

export async function serveAdminDashboardPage(res: ServerResponse) {
  const html = await readFile(ADMIN_DASHBOARD_HTML_PATH, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(html);
}

export async function serveNovncAsset(pathname: string, res: ServerResponse) {
  const relative = pathname.slice('/novnc/'.length);
  const resolved = normalize(join(NOVNC_ROOT, relative));
  if (!resolved.startsWith(NOVNC_ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
}
