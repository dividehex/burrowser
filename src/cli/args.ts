import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from './cli-error.ts';

/** node:util's strict parser, with its errors reported as ordinary usage errors. */
export function parse<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) throw usageError((error as Error).message);
    throw error;
  }
}

export function requireUrl(value: unknown): string {
  const url = typeof value === 'string' ? value : process.env.BURROWSER_URL;
  if (!url) throw usageError('the gateway URL is required: pass --url or set BURROWSER_URL');
  return url;
}
