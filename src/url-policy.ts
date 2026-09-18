import { isIP } from 'node:net';

function privateIpv4(host: string) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [first, second] = octets;
  return first === 0 || first === 10 || (first === 100 && second >= 64 && second <= 127) || (first === 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19)) || first >= 224;
}

function privateIpv6(host: string) {
  const normalized = host.toLowerCase();
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice('::ffff:'.length));
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export function validateBrowserUrl(raw: string, previous?: string) {
  let url: URL;
  try { url = new URL(raw, previous); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL scheme or credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host === 'kubernetes.default.svc') throw new Error('private destination is not allowed');
  if (isIP(host) === 4 && privateIpv4(host) || isIP(host) === 6 && privateIpv6(host)) throw new Error('private destination is not allowed');
  return url.href;
}
