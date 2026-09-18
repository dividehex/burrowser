import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate.ts';

const envFile = process.argv[2];
if (!envFile) throw new Error('usage: provision-postgres.ts <admin .env file> [output file] (admin .env must define POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB)');
const outputFile = process.argv[3] ?? '.agent-browser-postgres.env';
const username = process.env.AGENT_BROWSER_NEW_DB_USER ?? 'agent_browser';
const database = process.env.AGENT_BROWSER_NEW_DB_NAME ?? 'agent_browser';
if (!/^[a-z][a-z0-9_]{0,62}$/.test(username) || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error('new PostgreSQL role/database names are invalid');

function readDotenv(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const source = readDotenv(await readFile(envFile, 'utf8'));
for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) if (!source[key]) throw new Error(`${key} is missing from ${envFile}`);
const adminUrl = `postgresql://${encodeURIComponent(source.POSTGRES_USER)}:${encodeURIComponent(source.POSTGRES_PASSWORD)}@127.0.0.1:5432/${encodeURIComponent(source.POSTGRES_DB)}`;
const password = randomBytes(32).toString('base64url');
const adminPool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
let roleCreated = false;
let databaseCreated = false;
try {
  const client = await adminPool.connect();
  try {
    if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username])).rows.length) throw new Error(`role ${username} already exists; refusing to modify it`);
    if ((await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows.length) throw new Error(`database ${database} already exists; refusing to modify it`);
    const roleSql = (await client.query<{ sql: string }>("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql", [username, password])).rows[0].sql;
    await client.query(roleSql); roleCreated = true;
    const databaseSql = (await client.query<{ sql: string }>("SELECT format('CREATE DATABASE %I OWNER %I', $1::text, $2::text) AS sql", [database, username])).rows[0].sql;
    await client.query(databaseSql); databaseCreated = true;
  } finally { client.release(); }

  const appUrl = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:5432/${encodeURIComponent(database)}`;
  const appPool = new Pool({ connectionString: appUrl, max: 4, connectionTimeoutMillis: 5_000 });
  try { await runMigrations(appPool); }
  finally { await appPool.end(); }
  await mkdir(outputFile.substring(0, outputFile.lastIndexOf('/')) || '.', { recursive: true });
  await writeFile(outputFile, `AGENT_BROWSER_DB_USER=${username}\nAGENT_BROWSER_DB_NAME=${database}\nAGENT_BROWSER_DB_PASSWORD=${password}\nDATABASE_URL=${appUrl}\n`, { mode: 0o600 });
  console.log(`created isolated PostgreSQL role/database and wrote credentials to ${outputFile}`);
} catch (error) {
  if (roleCreated || databaseCreated) {
    const cleanup = await adminPool.connect();
    try {
      if (databaseCreated) await cleanup.query(`DROP DATABASE IF EXISTS "${database.replaceAll('"', '""')}"`);
      if (roleCreated) await cleanup.query(`DROP ROLE IF EXISTS "${username.replaceAll('"', '""')}"`);
    } finally { cleanup.release(); }
  }
  throw error;
} finally { await adminPool.end(); }
