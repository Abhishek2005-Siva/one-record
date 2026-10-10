// The scan flow end to end: real OCR on real files, then the review-and-save step.
// Also pins the bugs that were fixed alongside it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './_server.js';

const fixture = (name, mime) => ({ mime, name, base64: readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).toString('base64') });
let s; let demo; let tok; let patient;

before(async () => {
  s = await startServer();
  demo = (await s.call('GET', '/api/demo')).json;
  patient = demo.patients.find((p) => p.name.startsWith('Jesus')); // has paracetamol active
  tok = (await s.call('POST', '/api/login', { role: 'patient', patientId: patient.id })).json.token;
});
after(() => s.stop());

test('a photo of a lab report is read, nothing is saved until the patient confirms', async () => {
  const before = (await s.call('GET', '/api/me/timeline', undefined, tok)).json.length;
  const r = await s.call('POST', '/api/me/scan', { file: fixture('lab-report.png', 'image/png') }, tok);
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'lab');
  assert.equal(r.json.method, 'ocr');
  assert.equal(r.json.labs.length, 6);
  assert.equal(r.json.date, '2026-09-14');
  assert.equal((await s.call('GET', '/api/me/timeline', undefined, tok)).json.length, before, 'scanning alone stores nothing');

  const saved = await s.call('POST', '/api/me/scan/save', { file: fixture('lab-report.png', 'image/png'), review: r.json }, tok);
  assert.equal(saved.status, 201);
  const rec = (await s.call('GET', '/api/me/timeline', undefined, tok)).json.find((e) => e.kind === 'lab' && e.place === 'Metro Diagnostics Laboratory');
  assert.equal(rec.results.length, 6);
  assert.ok(rec.fileId, 'the original is kept');
  assert.equal(rec.results.find((x) => x.loinc === '2093-3').unit, 'mg/dL', 'cholesterol was written in mmol/L');
});

test('the patient can correct a value and drop a line before saving', async () => {
  const r = (await s.call('POST', '/api/me/scan', { file: fixture('lab-report-text.pdf', 'application/pdf') }, tok)).json;
  assert.equal(r.method, 'pdf-text', 'a PDF with a text layer needs no OCR');
  const review = { ...r, title: 'My own title', labs: r.labs.map((l) => (l.code === '4548-4' ? { ...l, value: '7.4' } : l.code === '38483-4' ? { ...l, include: false } : l)) };
  await s.call('POST', '/api/me/scan/save', { file: fixture('lab-report-text.pdf', 'application/pdf'), review }, tok);
  const rec = (await s.call('GET', '/api/me/timeline', undefined, tok)).json.find((e) => e.title === 'My own title');
  assert.equal(rec.results.find((x) => x.loinc === '4548-4').value, 7.4);
  assert.ok(!rec.results.some((x) => x.loinc === '38483-4'));
});

test('a scanned (image-only) prescription PDF is read with OCR and checked against current medicines', async () => {
  const r = await s.call('POST', '/api/me/scan', { file: fixture('prescription-scanned.pdf', 'application/pdf') }, tok);
  assert.equal(r.json.kind, 'prescription');
  assert.equal(r.json.method, 'ocr');
  assert.equal(r.json.medicines.length, 3);
  const dolo = r.json.medicines.find((m) => /Dolo/.test(m.name));
  assert.ok(dolo.checks.some((c) => c.type === 'same-ingredient'), 'paracetamol is already being taken');

  const noDate = await s.call('POST', '/api/me/scan/save', { file: fixture('prescription-scanned.pdf', 'application/pdf'), review: { ...r.json, date: '' } }, tok);
  assert.equal(noDate.status, 400, 'a course length needs a start date');
  const review = { ...r.json, medicines: r.json.medicines.map((m) => (/Glycomet/.test(m.name) ? { ...m, include: false } : m)) };
  const saved = await s.call('POST', '/api/me/scan/save', { file: fixture('prescription-scanned.pdf', 'application/pdf'), review }, tok);
  assert.equal(saved.json.saved.medicines, 2);
  const meds = JSON.stringify((await s.call('GET', '/api/me/medicines', undefined, tok)).json);
  assert.ok(/Omez/.test(meds) && !/Glycomet/.test(meds));
});

test('hospitals find a scanned result in "already tested"', async () => {
  const hosp = (await s.call('POST', '/api/login', { role: 'hospital', hospital: demo.hospitals[0] })).json.token;
  const share = (await s.call('POST', '/api/me/shares', { scope: 'full', duration: '1h' }, tok)).json;
  await s.call('POST', '/api/h/open', { code: share.code }, hosp);
  const found = (await s.call('GET', `/api/h/${share.code}/tests?q=hba1c`, undefined, hosp)).json;
  assert.equal(found[0].latest.place, 'Metro Diagnostics Laboratory');
});

test('uploads are checked by content, not by the label the browser gave them', async () => {
  const b64 = (x) => Buffer.from(x).toString('base64');
  const png = readFileSync(fileURLToPath(new URL('./fixtures/lab-report.png', import.meta.url))).toString('base64');
  const bad = [
    { mime: 'application/pdf', name: 'a.pdf', base64: b64('<script>alert(1)</script>') },
    { mime: 'application/pdf', name: 'b.pdf', base64: png },
    { mime: 'image/png', name: 'c.png', base64: b64('not an image') },
    { mime: 'image/svg+xml', name: 'd.svg', base64: b64('<svg/>') },
    { mime: 'image/png', name: 'e.png', base64: '' },
  ];
  for (const file of bad) assert.equal((await s.call('POST', '/api/me/scan', { file }, tok)).status, 400, file.name);
  // a PNG that claims to be 30000 x 30000 pixels
  const bomb = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bomb);
  bomb.write('IHDR', 12, 'latin1'); bomb.writeUInt32BE(30000, 16); bomb.writeUInt32BE(30000, 20);
  assert.equal((await s.call('POST', '/api/me/scan', { file: { mime: 'image/png', name: 'bomb.png', base64: bomb.toString('base64') } }, tok)).status, 400);
  // the older document upload gets the same checks
  assert.equal((await s.call('POST', '/api/me/documents', { title: 'x', file: bad[0] }, tok)).status, 400);
});

test('scan needs a patient sign-in', async () => {
  assert.equal((await s.call('POST', '/api/me/scan', { file: fixture('lab-report.png', 'image/png') })).status, 401);
  const hosp = (await s.call('POST', '/api/login', { role: 'hospital', hospital: demo.hospitals[0] })).json.token;
  assert.equal((await s.call('POST', '/api/me/scan', { file: fixture('lab-report.png', 'image/png') }, hosp)).status, 401);
});

test('save re-checks everything the browser sends', async () => {
  const file = fixture('lab-report.png', 'image/png');
  const save = (review) => s.call('POST', '/api/me/scan/save', { file, review }, tok);
  assert.equal((await save({ kind: 'lab', title: 'x', labs: [{ code: '2339-0', value: 'abc', unit: 'mg/dL' }] })).status, 400);
  assert.equal((await save({ kind: 'lab', title: 'x', labs: [{ code: '2339-0', value: 5, unit: 'furlongs' }] })).status, 400);
  assert.equal((await save({ kind: 'lab', title: 'x', date: '2026-02-30' })).status, 400);
  assert.equal((await save({ kind: 'lab', title: 'x', date: '2999-01-01' })).status, 400);
  const odd = await save({ kind: 'nonsense', title: '<img src=x onerror=alert(1)>' });
  assert.equal(odd.json.saved.kind, 'document', 'an unknown type is stored as a plain document');
});

// ---- bugs fixed alongside the scan feature ----

test('regression: impossible dates are rejected, real ones accepted', async () => {
  const hosp = (await s.call('POST', '/api/login', { role: 'hospital', hospital: demo.hospitals[0] })).json.token;
  const share = (await s.call('POST', '/api/me/shares', { scope: 'full', duration: '1h' }, tok)).json;
  await s.call('POST', '/api/h/open', { code: share.code }, hosp);
  const add = (date) => s.call('POST', `/api/h/${share.code}/records`, { type: 'note', title: 'x', date }, hosp);
  assert.equal((await add('2026-02-30')).status, 400);
  assert.equal((await add('2026-13-01')).status, 400);
  assert.equal((await add('2024-02-29')).status, 201, 'a real leap day');
});

test('regression: malformed JSON is a 400, not a 500', async () => {
  const r = await s.call('POST', '/api/login', '{bad json');
  assert.equal(r.status, 400);
});

test('regression: a brand we do not know says so, and US brands are recognised', async () => {
  const hosp = (await s.call('POST', '/api/login', { role: 'hospital', hospital: demo.hospitals[0] })).json.token;
  const share = (await s.call('POST', '/api/me/shares', { scope: 'full', duration: '1h' }, tok)).json;
  await s.call('POST', '/api/h/open', { code: share.code }, hosp);
  const check = async (name) => (await s.call('POST', `/api/h/${share.code}/records`, { type: 'prescription', name, check: true }, hosp)).json.warnings.map((w) => w.type);
  assert.ok((await check('Zyxolin 10 mg')).includes('unknown'));
  assert.ok((await check('Tylenol')).includes('same-ingredient'), 'Tylenol is paracetamol, which this patient already takes');
});
