// Starts the real server on a throwaway database for tests, and gives back a small HTTP client.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startServer() {
  const port = 3800 + Math.floor(Math.random() * 400);
  const dir = mkdtempSync(join(tmpdir(), 'onerecord-'));
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db') }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('Running on') && resolve());
    child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
  const base = `http://localhost:${port}`;
  const grants = new Map();
  const call = async (method, path, body, token, extra = {}) => {
    const code = /^\/api\/h\/([A-Za-z0-9-]{6,7})\//.exec(path)?.[1]?.replace(/-/g, '').toUpperCase();
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(code && grants.has(code) ? { 'x-grant': grants.get(code) } : {}), ...extra },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = await r.json().catch(() => null);
    if (path === '/api/h/open' && r.ok) grants.set(String(json.code).replace(/-/g, '').toUpperCase(), json.grant);
    return { status: r.status, json };
  };
  const stop = () => { child.kill(); rmSync(dir, { recursive: true, force: true }); };
  return { call, stop, base };
}
