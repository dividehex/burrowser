#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { adminCommand } from './admin.ts';
import { CliError, usageError } from './cli-error.ts';
import { enrollCommand, whoamiCommand } from './enroll.ts';
import { mcpCommand } from './mcp-bridge.ts';

const HELP = `burrowser - command line for a Burrowser gateway

Agent commands
  burrowser enroll --url URL --name NAME [--invitation-file FILE] [--force]
      Redeem an admin-issued invitation and save a new identity (an Ed25519 key) for this agent.
      The invitation is read from the file, piped stdin, or a hidden prompt; never from argv.
  burrowser whoami [--identity NAME]
      Authenticate with a saved identity and list its profiles.
  burrowser mcp [--identity NAME]
      Run a stdio MCP server that forwards to the gateway as this agent. Point an MCP client at it,
      e.g.  claude mcp add burrowser -- burrowser mcp --identity NAME

Admin commands (need the admin bootstrap token: BURROWSER_ADMIN_BOOTSTRAP, --admin-token-file, or --admin-token-stdin)
  burrowser admin invite [--json]
  burrowser admin agents list [--json]
  burrowser admin agents revoke ID
  burrowser admin agents delete ID [--yes]
  burrowser admin profiles list [--json]
  burrowser admin profiles delete ID [--yes] [--wait] [--timeout SECONDS]
      ID may be any unique prefix of four or more characters.

Common
  --url URL     Gateway address (or set BURROWSER_URL)
  --help        Show this help

Identities live in $XDG_CONFIG_HOME/burrowser/identities (default ~/.config/burrowser/identities), owner-only.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<void>> = { enroll: enrollCommand, whoami: whoamiCommand, mcp: mcpCommand, admin: adminCommand };

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') { console.log(HELP); return; }
  const run = COMMANDS[command];
  if (!run) throw usageError(`unknown command "${command}"`);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return; }
  await run(rest);
}

main(process.argv.slice(2)).catch(error => {
  if (error instanceof CliError) {
    console.error(`burrowser: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`burrowser: unexpected error: ${error instanceof Error ? (process.env.BURROWSER_DEBUG ? error.stack : error.message) : String(error)}`);
    process.exitCode = 1;
  }
});
