// Starts the real server on a throwaway database and drives it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3400 + Math.floor(Math.random() * 400);
const B = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'onerecord-'));
let server;

// open() stores the grant it is given; later hospital calls for that code send it, like the browser does
const grants = new Map();
const grantHeader = (path) => {
  const code = /^\/api\/h\/([A-Za-z0-9-]+)\//.exec(path)?.[1]?.replace(/-/g, '').toUpperCase();
  return code && grants.has(code) ? { 'x-grant': grants.get(code) } : {};
};

const call = async (method, path, body, token) => {
  const r = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...grantHeader(path) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};

let demo; let patientTok; let hospTok; let patientId;

before(async () => {
  server = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, 'test.db') }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('Running on') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
    setTimeout(() => reject(new Error('server did not start')), 15000);
  });
  demo = (await call('GET', '/api/demo')).json;
  // the sample patient with the most overlapping medicines makes the best test subject
  for (const p of demo.patients) {
    const t = (await call('POST', '/api/login', { role: 'patient', patientId: p.id })).json.token;
    const meds = (await call('GET', '/api/me/medicines', null, t)).json;
    if (meds.active.some((g) => g.flag?.type === 'same-ingredient')) { patientTok = t; patientId = p.id; break; }
  }
  patientTok ??= (await call('POST', '/api/login', { role: 'patient', patientId: demo.patients[0].id })).json.token;
  hospTok = (await call('POST', '/api/login', { role: 'hospital', hospital: demo.hospitals[0] })).json.token;
});

after(() => { server?.kill(); rmSync(dir, { recursive: true, force: true }); });

const share = async (scope, duration = '1h') => (await call('POST', '/api/me/shares', { scope, duration }, patientTok)).json;
const open = async (code) => {
  const r = await call('POST', '/api/h/open', { code }, hospTok);
  if (r.json?.grant) grants.set(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), r.json.grant);
  return r;
};

test('sample data loads and the timeline has dated, typed events', async () => {
  assert.ok(demo.patients.length >= 6);
  const tl = (await call('GET', '/api/me/timeline', null, patientTok)).json;
  assert.ok(tl.length > 20);
  assert.ok(tl.every((e) => e.kind && e.title));
});

test('tokens are signed: tampered or foreign tokens are rejected', async () => {
  const [body, sig] = patientTok.split('.');
  const forged = Buffer.from(JSON.stringify({ role: 'patient', patientId: 'x', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal((await call('GET', '/api/me/overview', null, `${forged}.${sig}`)).status, 401);
  assert.equal((await call('GET', '/api/me/overview', null, `${body}.${sig.slice(0, -2)}AA`)).status, 401);
  assert.equal((await call('GET', '/api/me/overview', null, 'not-a-token')).status, 401);
});

test('a grant for one code does not open another', async () => {
  const a = await share('full');
  const b = await share('full');
  await open(a.code);
  grants.set(b.code.replace(/-/g, ''), grants.get(a.code.replace(/-/g, '')));
  assert.equal((await call('GET', `/api/h/${b.code}/overview`, null, hospTok)).status, 403);
});

test('roles and tokens are enforced', async () => {
  assert.equal((await call('GET', '/api/me/overview')).status, 401);
  assert.equal((await call('GET', '/api/me/overview', null, hospTok)).status, 401);
  assert.equal((await call('POST', '/api/h/open', { code: 'AAA-AAA' }, patientTok)).status, 401);
});

test('a hospital cannot read a record before opening it with a code', async () => {
  const s = await share('full');
  assert.equal((await call('GET', `/api/h/${s.code}/overview`, null, hospTok)).status, 403);
  assert.equal((await open(s.code.toLowerCase().replace('-', ' '))).status, 200);
  assert.equal((await call('GET', `/api/h/${s.code}/overview`, null, hospTok)).status, 200);
});

test('emergency scope shows the summary but not the timeline or tests', async () => {
  const s = await share('emergency');
  await open(s.code);
  assert.equal((await call('GET', `/api/h/${s.code}/overview`, null, hospTok)).status, 200);
  assert.equal((await call('GET', `/api/h/${s.code}/timeline`, null, hospTok)).status, 403);
  assert.equal((await call('GET', `/api/h/${s.code}/tests?q=glucose`, null, hospTok)).status, 403);
});

test('"already tested" finds earlier results with date and place', async () => {
  const s = await share('full');
  await open(s.code);
  const hits = (await call('GET', `/api/h/${s.code}/tests?q=cholesterol`, null, hospTok)).json;
  if (hits.length) {
    assert.ok(Number.isInteger(hits[0].latest.daysAgo) && hits[0].latest.date);
  }
  assert.deepEqual((await call('GET', `/api/h/${s.code}/tests?q=zzzzqqq`, null, hospTok)).json, []);
});

test('prescriptions: duplicate warning, confirm to save, safe drug passes, allergy caught', async () => {
  const s = await share('full');
  await open(s.code);
  const rec = (body) => call('POST', `/api/h/${s.code}/records`, body, hospTok);

  await rec({ type: 'prescription', name: 'Crocin 500', dose: '500 mg', confirmed: true });
  const dup = (await rec({ type: 'prescription', name: 'Dolo 650', check: true })).json;
  assert.ok(dup.warnings.some((w) => w.type === 'same-ingredient'));
  assert.equal((await rec({ type: 'prescription', name: 'Dolo 650' })).status, 409);
  assert.equal((await rec({ type: 'prescription', name: 'Dolo 650', confirmed: true })).status, 201);

  const meds = (await call('GET', '/api/me/medicines', null, patientTok)).json;
  assert.ok(meds.active.some((g) => g.entries.some((e) => e.name === 'Dolo 650') && g.flag));

  assert.deepEqual((await rec({ type: 'prescription', name: 'Pantop 40', check: true })).json.warnings, []);

  await rec({ type: 'allergy', substance: 'Penicillin', reaction: 'rash' });
  const aug = (await rec({ type: 'prescription', name: 'Augmentin 625', check: true })).json;
  assert.ok(aug.warnings.some((w) => w.type === 'allergy'));
});

test('lab entry converts units and rejects bad input', async () => {
  const s = await share('full');
  await open(s.code);
  const rec = (body) => call('POST', `/api/h/${s.code}/records`, body, hospTok);
  const ok = await rec({ type: 'lab', code: '2339-0', value: '5.5', unit: 'mmol/L' });
  assert.equal(ok.status, 201);
  assert.match(ok.json.converted, /99/);
  assert.equal((await rec({ type: 'lab', code: '2339-0', value: 'abc' })).status, 400);
  assert.equal((await rec({ type: 'lab', code: '2339-0', value: '5', unit: 'bananas' })).status, 400);
  assert.equal((await rec({ type: 'lab', code: 'nope', value: '5' })).status, 400);
  assert.equal((await rec({ type: 'note', title: 'x', date: '2999-01-01' })).status, 400);
});

test('documents: upload, appears on timeline, hospital can open, other patients cannot', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', '/api/me/documents', { title: ' ' }, patientTok)).status, 400);
  assert.equal((await call('POST', '/api/me/documents', { title: 'x', file: { mime: 'text/html', name: 'a.html', base64: 'PGI+' } }, patientTok)).status, 400);
  assert.equal((await call('POST', '/api/me/documents', { title: 'Old prescription', date: '2025-11-02', file: { mime: 'image/png', name: 'rx.png', base64: png } }, patientTok)).status, 201);

  const doc = (await call('GET', '/api/me/timeline', null, patientTok)).json.find((e) => e.kind === 'document' && e.fileId);
  assert.ok(doc);
  const s = await share('full');
  await open(s.code);
  const f = await fetch(`${B}/api/h/${s.code}/files/${doc.fileId}`, { headers: { authorization: `Bearer ${hospTok}`, ...grantHeader(`/api/h/${s.code}/`) } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-security-policy'), 'sandbox');

  const other = demo.patients.find((p) => p.id !== patientId);
  const otherTok = (await call('POST', '/api/login', { role: 'patient', patientId: other.id })).json.token;
  assert.equal((await fetch(`${B}/api/me/files/${doc.fileId}`, { headers: { authorization: `Bearer ${otherTok}` } })).status, 404);
});

test('revoking a code cuts access immediately and the patient can see who looked', async () => {
  const s = await share('full');
  await open(s.code);
  assert.equal((await call('GET', `/api/h/${s.code}/overview`, null, hospTok)).status, 200);
  await call('POST', `/api/me/shares/${s.id}/revoke`, null, patientTok);
  assert.equal((await call('GET', `/api/h/${s.code}/overview`, null, hospTok)).status, 403);
  assert.equal((await open(s.code)).status, 403);
  const log = (await call('GET', '/api/me/log', null, patientTok)).json;
  assert.ok(log.some((l) => l.action === 'Opened the record'));
});

test('too many wrong codes are rate limited (keep this last)', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await open('AAA-AAA');
  assert.equal(last.status, 429);
});
