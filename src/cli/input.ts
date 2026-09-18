import { readFile } from 'node:fs/promises';
import { CliError } from './cli-error.ts';

export async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

/** Reads one line from the terminal without echoing it, so secrets don't land on screen or in scrollback. */
export function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === CTRL_D) return finish();
        if (char === CTRL_C) return finish(new CliError('cancelled', 130));
        if (char === BACKSPACE || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

export async function promptLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  let line = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    line += chunk;
    if (line.includes('\n')) break;
  }
  process.stdin.pause();
  return line.split('\n')[0].trim();
}

/**
 * Finds a secret without ever taking it from argv (which lands in shell history and `ps`):
 * a file, an environment variable, piped stdin, or a hidden terminal prompt, in that order.
 */
export async function readSecret(options: { file?: string; env?: string; label: string; stdin?: boolean }): Promise<string> {
  let secret: string | undefined;
  if (options.file) secret = await readFile(options.file, 'utf8').catch(error => { throw new CliError(`cannot read ${options.file}: ${error.message}`); });
  else if (options.env && process.env[options.env]) secret = process.env[options.env];
  else if (options.stdin || !process.stdin.isTTY) secret = await readStdin();
  else secret = await promptHidden(`${options.label}: `);
  secret = secret?.trim();
  if (!secret) throw new CliError(`no ${options.label} provided`, 2);
  return secret;
}

/** Destructive commands need either --yes or the operator typing the target's id back. */
export async function confirmDestructive(action: string, id: string, options: { yes?: boolean }) {
  if (options.yes) return;
  if (!process.stdin.isTTY) throw new CliError(`refusing to ${action} without confirmation; pass --yes to skip the prompt`, 2);
  const answer = await promptLine(`About to ${action}. This cannot be undone.\nType the id (${id}) to confirm: `);
  if (answer !== id) throw new CliError('confirmation did not match; nothing was changed');
}
