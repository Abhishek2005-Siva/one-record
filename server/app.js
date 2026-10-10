import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { sign, verify } from './auth.js';
import { fileURLToPath } from 'node:url';
import { q, db } from './db.js';
import { seedIfEmpty } from './import.js';
import { reconcile, checkNewMedicine, ingredientsOf, normaliseLab, flagFor, tidyDrugName } from './meds.js';
import { LABS, HOSPITALS } from './catalog.js';

const app = express();
app.disable('x-powered-by');
if (process.env.VERCEL) app.set('trust proxy', 1); // so rate limiting sees the visitor, not the proxy
app.use(express.json({ limit: '6mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
});

const seeded = seedIfEmpty();
if (seeded.length) console.log(`Loaded ${seeded.length} sample patients:`, seeded.map((s) => s.name).join(', '));

// ---------- small helpers ----------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const fail = (res, code, message) => res.status(code).json({ error: message });
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const age = (dob) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / 31557600000) : null);
const daysAgo = (d) => (d ? Math.max(0, Math.round((Date.parse(today()) - Date.parse(d)) / 86400000)) : null);

const SESSION_MS = 12 * 3600e3;
const auth = (role) => (req, res, next) => {
  const s = verify((req.get('authorization') ?? '').replace(/^Bearer /, ''));
  if (!s || s.role !== role) return fail(res, 401, 'Please sign in again.');
  req.session = s;
  next();
};

// ---------- shaping records for the screens ------------------------------------
const NOT_ON_TIMELINE = new Set(['allergy', 'condition']);

// Synthea files social and administrative findings as Conditions. They are not clinical, and some
// (interpersonal violence, housing) are sensitive enough that they should not appear in a summary shared by
// code. Clinical entries, including substance dependence, stay visible because an ER needs them.
const NON_CLINICAL = /employ|education|victim of|intimate partner|violence|housing|homeless|labor force|transport|income|refugee|social contact|social isolation|review due|medication review/i;

const asEvent = (r) => ({
  ...r.data, id: r.id, kind: r.kind, date: r.date, title: r.title, detail: r.detail,
  place: r.source, byHospital: r.source_kind === 'hospital', byPatient: r.source_kind === 'patient',
});

const timelineOf = (pid) => q.records(pid).filter((r) => !NOT_ON_TIMELINE.has(r.kind)).map(asEvent);

function overviewOf(pid) {
  const p = q.patient(pid);
  const recs = q.records(pid);
  const visits = recs.filter((r) => r.kind === 'visit' || r.kind === 'discharge').filter((r) => r.date).slice(0, 3).map(asEvent);
  return {
    patient: { id: p.id, name: p.name, gender: p.sex, birthDate: p.dob, age: age(p.dob), bloodGroup: p.blood_group },
    allergies: recs.filter((r) => r.kind === 'allergy').map((r) => ({ id: r.id, substance: r.title, reaction: r.detail, criticality: r.data.criticality ?? null })),
    conditions: recs.filter((r) => r.kind === 'condition' && !NON_CLINICAL.test(r.title)).map((r) => ({ name: r.title, active: r.data.active !== false, since: r.date }))
      .sort((a, b) => Number(b.active) - Number(a.active)),
    medicines: reconcile(recs, today()),
    recentVisits: visits,
    counts: { records: recs.filter((r) => !NOT_ON_TIMELINE.has(r.kind)).length },
  };
}

// "Have they had this test already?"  Looks at every lab result and every lab panel.
function findTests(pid, query) {
  const tokens = text(query, 60).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const labs = q.records(pid).filter((r) => r.kind === 'lab' && r.date);
  const groups = new Map();
  const put = (key, name, extra, row) => {
    const g = groups.get(key) ?? { key, name, alias: extra, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  };
  for (const r of labs) {
    // the panel itself ("Lipid panel")
    put(`panel:${r.title.toLowerCase()}`, r.title, '', { date: r.date, place: r.source, count: r.data.results?.length ?? 0, panel: true });
    for (const res of r.data.results ?? []) {
      const key = res.loinc ?? `n:${res.name}`;
      put(key, res.name, LABS[res.loinc]?.alias ?? '', { date: r.date, place: r.source, value: res.value, text: res.text, unit: res.unit, flag: res.flag, panel: false, inPanel: r.title });
    }
  }
  const hits = [];
  for (const g of groups.values()) {
    const hay = `${g.name} ${g.alias}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    const rows = g.rows.sort((a, b) => b.date.localeCompare(a.date));
    const latest = rows[0];
    hits.push({
      key: g.key, name: g.name, isPanel: g.key.startsWith('panel:'), times: rows.length,
      latest: { ...latest, daysAgo: daysAgo(latest.date) },
      trend: rows.filter((x) => typeof x.value === 'number').slice(0, 8).reverse().map((x) => ({ date: x.date, value: x.value })),
      range: LABS[g.key] ? { low: LABS[g.key].low, high: LABS[g.key].high, unit: LABS[g.key].unit } : null,
    });
  }
  hits.sort((a, b) => Number(a.isPanel) - Number(b.isPanel) || a.latest.daysAgo - b.latest.daysAgo);
  return hits.slice(0, 8);
}

// ---------- share codes ------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => {
  for (;;) {
    const bytes = randomBytes(6);
    const c = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!q.share(c)) return c;
  }
};
const normaliseCode = (c) => text(c, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
const prettyCode = (c) => `${c.slice(0, 3)}-${c.slice(3)}`;
const DURATIONS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

function shareState(s) {
  if (s.revoked_at) return 'revoked';
  if (Date.parse(s.expires_at) <= Date.now()) return 'expired';
  return 'active';
}
const shareOut = (s) => ({ id: s.id, code: prettyCode(s.code), scope: s.scope, expiresAt: s.expires_at, createdAt: s.created_at, state: shareState(s) });

// crude brute-force guard: 10 wrong codes per minute per address
const misses = new Map();
const tooMany = (ip) => (misses.get(ip) ?? []).filter((t) => t > Date.now() - 60000).length >= 10;
const miss = (ip) => misses.set(ip, [...(misses.get(ip) ?? []).filter((t) => t > Date.now() - 60000), Date.now()]);

// ---------- sign-in (demo) -----------------------------------------------------
app.get('/api/demo', (req, res) => {
  res.json({
    patients: q.patients().map((p) => ({ id: p.id, name: p.name, age: age(p.dob), gender: p.sex })),
    hospitals: HOSPITALS,
  });
});

app.post('/api/login', (req, res) => {
  let token;
  if (req.body?.role === 'patient') {
    if (!q.patient(req.body.patientId)) return fail(res, 404, 'No such patient.');
    token = sign({ role: 'patient', patientId: req.body.patientId }, SESSION_MS);
  } else if (req.body?.role === 'hospital') {
    if (!HOSPITALS.includes(req.body.hospital)) return fail(res, 400, 'Choose a hospital from the list.');
    token = sign({ role: 'hospital', hospital: req.body.hospital }, SESSION_MS);
  } else return fail(res, 400, 'Unknown role.');
  res.json({ token, role: req.body.role });
});

// ---------- patient side ---------------------------------------------------------
const me = express.Router();
me.use(auth('patient'));

me.get('/overview', (req, res) => res.json(overviewOf(req.session.patientId)));
me.get('/timeline', (req, res) => res.json(timelineOf(req.session.patientId)));
me.get('/medicines', (req, res) => res.json(reconcile(q.records(req.session.patientId), today())));

me.get('/shares', (req, res) => res.json(q.sharesFor(req.session.patientId).map(shareOut)));
me.post('/shares', (req, res) => {
  const scope = req.body?.scope === 'full' ? 'full' : 'emergency';
  const ms = DURATIONS[req.body?.duration];
  if (!ms) return fail(res, 400, 'Choose how long the code should work.');
  const s = { id: randomUUID(), code: newCode(), patient_id: req.session.patientId, scope, expires_at: new Date(Date.now() + ms).toISOString() };
  db.prepare('INSERT INTO shares (id, code, patient_id, scope, expires_at) VALUES (@id, @code, @patient_id, @scope, @expires_at)').run(s);
  res.status(201).json(shareOut(q.shareById(s.id)));
});
me.post('/shares/:id/revoke', (req, res) => {
  const s = q.shareById(req.params.id);
  if (!s || s.patient_id !== req.session.patientId) return fail(res, 404, 'Not found.');
  db.prepare("UPDATE shares SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(s.id);
  res.json(shareOut(q.shareById(s.id)));
});
me.get('/log', (req, res) => res.json(q.logFor(req.session.patientId).map((l) => ({ ...l, code: prettyCode(l.code), at: l.at.replace(' ', 'T') + 'Z' }))));

const FILE_TYPES = { 'application/pdf': 'PDF', 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image' };
me.post('/documents', (req, res) => {
  const title = text(req.body?.title, 120);
  if (!title) return fail(res, 400, 'Give the document a name, like "Blood test from Metro Lab".');
  const date = req.body?.date ? (isDate(req.body.date) ? req.body.date : null) : today();
  if (req.body?.date && !date) return fail(res, 400, 'That date does not look right.');
  const id = randomUUID();
  let fileId = null;
  if (req.body?.file) {
    const { mime, name, base64 } = req.body.file;
    if (!FILE_TYPES[mime]) return fail(res, 400, 'Only PDF, PNG, JPG or WebP files can be added.');
    const body = Buffer.from(String(base64 ?? ''), 'base64');
    if (!body.length) return fail(res, 400, 'The file looks empty.');
    if (body.length > 3 * 1024 * 1024) return fail(res, 400, 'Files can be up to 3 MB.');
    fileId = randomUUID();
    q.insertRecord({
      id, patient_id: req.session.patientId, kind: 'document', date, title, detail: text(req.body.detail, 300) || null,
      source: text(req.body.source, 120) || 'Added by patient', source_kind: 'patient', data: { fileId, fileName: text(name, 100), mime },
    });
    db.prepare('INSERT INTO files (id, record_id, mime, name, body) VALUES (?, ?, ?, ?, ?)').run(fileId, id, mime, text(name, 100) || 'file', body);
  } else {
    q.insertRecord({
      id, patient_id: req.session.patientId, kind: 'document', date, title, detail: text(req.body.detail, 300) || null,
      source: text(req.body?.source, 120) || 'Added by patient', source_kind: 'patient', data: {},
    });
  }
  res.status(201).json({ id });
});
me.post('/allergies', (req, res) => {
  const substance = text(req.body?.substance, 80);
  if (!substance) return fail(res, 400, 'What is the allergy to?');
  q.insertRecord({
    id: randomUUID(), patient_id: req.session.patientId, kind: 'allergy', date: today(), title: substance,
    detail: text(req.body?.reaction, 120) || null, source: 'Added by patient', source_kind: 'patient', data: {},
  });
  res.status(201).json({ ok: true });
});

function sendFile(res, pid, fileId) {
  const f = db.prepare('SELECT f.*, r.patient_id FROM files f JOIN records r ON r.id = f.record_id WHERE f.id = ?').get(fileId);
  if (!f || f.patient_id !== pid) return fail(res, 404, 'File not found.');
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `inline; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`, 'Content-Security-Policy': 'sandbox' });
  res.send(Buffer.from(f.body));
}
me.get('/files/:id', (req, res) => sendFile(res, req.session.patientId, req.params.id));
app.use('/api/me', me);

// ---------- hospital side ----------------------------------------------------------
const hosp = express.Router();
hosp.use(auth('hospital'));

hosp.post('/open', (req, res) => {
  if (tooMany(req.ip)) return fail(res, 429, 'Too many wrong codes. Wait a minute and try again.');
  const code = normaliseCode(req.body?.code);
  const s = code.length === 6 ? q.share(code) : null;
  if (!s) { miss(req.ip); return fail(res, 404, 'That code does not match any record. Check it with the patient.'); }
  const st = shareState(s);
  if (st === 'revoked') return fail(res, 403, 'The patient has stopped sharing with this code.');
  if (st === 'expired') return fail(res, 403, 'This code has expired. Ask the patient for a new one.');
  // log an open once per 10 minutes per hospital, so refreshing the page does not spam the patient's log
  const recent = db.prepare(
    "SELECT 1 FROM access_log WHERE share_id = ? AND who = ? AND action = 'Opened the record' AND at > datetime('now', '-10 minutes')",
  ).get(s.id, req.session.hospital);
  if (!recent) q.log(s.id, req.session.hospital, 'Opened the record');
  // The grant proves this hospital opened this code, and works on any server instance.
  const grant = sign({ shareId: s.id, hospital: req.session.hospital }, Math.min(Date.parse(s.expires_at) - Date.now(), SESSION_MS));
  res.json({ code: prettyCode(s.code), scope: s.scope, expiresAt: s.expires_at, grant });
});

// Every call under /:code re-checks the share, so revoking or expiry takes effect immediately.
const withShare = (needFull) => (req, res, next) => {
  const s = q.share(normaliseCode(req.params.code));
  const grant = verify(req.get('x-grant'));
  if (!s || !grant || grant.shareId !== s.id || grant.hospital !== req.session.hospital) return fail(res, 403, 'Open the record with a code first.');
  const st = shareState(s);
  if (st !== 'active') return fail(res, 403, st === 'revoked' ? 'The patient has stopped sharing.' : 'This code has expired.');
  if (needFull && s.scope !== 'full') return fail(res, 403, 'This code shares the emergency summary only.');
  req.share = s;
  next();
};

hosp.get('/:code/overview', withShare(false), (req, res) => res.json({ ...overviewOf(req.share.patient_id), share: shareOut(req.share) }));
hosp.get('/:code/timeline', withShare(true), (req, res) => res.json(timelineOf(req.share.patient_id)));
hosp.get('/:code/medicines', withShare(false), (req, res) => res.json(reconcile(q.records(req.share.patient_id), today())));
hosp.get('/:code/tests', withShare(true), (req, res) => res.json(findTests(req.share.patient_id, req.query.q)));
hosp.get('/:code/files/:id', withShare(true), (req, res) => sendFile(res, req.share.patient_id, req.params.id));
hosp.get('/labs/catalog', (req, res) => res.json(Object.entries(LABS).map(([code, d]) => ({ code, name: d.name, unit: d.unit, low: d.low, high: d.high }))));

hosp.post('/:code/records', withShare(false), (req, res) => {
  const pid = req.share.patient_id;
  const b = req.body ?? {};
  const hospital = req.session.hospital;
  const date = b.date ? (isDate(b.date) ? b.date : null) : today();
  if (!date) return fail(res, 400, 'That date does not look right.');
  if (date > today()) return fail(res, 400, 'The date cannot be in the future.');
  const base = { id: randomUUID(), patient_id: pid, date, source: hospital, source_kind: 'hospital' };
  const log = (what) => q.log(req.share.id, hospital, what);

  if (b.type === 'prescription') {
    const name = tidyDrugName(text(b.name, 120));
    if (!name) return fail(res, 400, 'Which medicine?');
    const days = b.days ? Math.round(Number(b.days)) : null;
    if (b.days && !(days > 0 && days <= 365)) return fail(res, 400, 'Days should be between 1 and 365.');
    const all = q.records(pid);
    const warnings = checkNewMedicine(name, all, all.filter((r) => r.kind === 'allergy'), today());
    if (b.check) return res.json({ warnings });
    if (warnings.length && !b.confirmed) return fail(res, 409, 'Please confirm you have seen the warnings.');
    const dose = text(b.dose, 60) || null;
    const frequency = text(b.frequency, 60) || null;
    const end = days ? new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10) : null;
    q.insertRecord({
      ...base, kind: 'medicine', title: name, detail: [dose, frequency, days && `${days} days`].filter(Boolean).join(' · ') || null,
      data: { status: 'active', dose, frequency, endDate: end, times: 1, since: date, ingredients: ingredientsOf(name), warnings: warnings.map((w) => w.text) },
    });
    log(`Added a prescription: ${name}${warnings.length ? ' (warnings acknowledged)' : ''}`);
    return res.status(201).json({ ok: true, warnings });
  }

  if (b.type === 'lab') {
    const code = text(b.code, 20);
    const def = LABS[code];
    const raw = Number(b.value);
    if (!def) return fail(res, 400, 'Choose a test from the list.');
    if (b.value === '' || b.value == null || !Number.isFinite(raw)) return fail(res, 400, 'Enter the result as a number.');
    const n = normaliseLab(code, raw, text(b.unit, 20) || def.unit);
    if (n.unknownUnit) return fail(res, 400, `We cannot convert "${b.unit}" for ${def.name}. Use ${def.unit}.`);
    q.insertRecord({
      ...base, kind: 'lab', title: def.name, detail: n.converted ? `Entered as ${n.original}` : null,
      data: { loinc: code, results: [{ name: def.name, loinc: code, value: n.value, unit: n.unit, flag: flagFor(code, n.value) }] },
    });
    log(`Added a test result: ${def.name}`);
    return res.status(201).json({ ok: true, converted: n.converted ? `${n.original} saved as ${n.value} ${n.unit}` : null });
  }

  if (b.type === 'note' || b.type === 'discharge') {
    const title = text(b.title, 120);
    if (!title) return fail(res, 400, 'Add a short title.');
    q.insertRecord({ ...base, kind: b.type === 'discharge' ? 'discharge' : 'visit', title, detail: text(b.detail, 1500) || null, data: {} });
    log(`Added a ${b.type === 'discharge' ? 'discharge summary' : 'visit note'}`);
    return res.status(201).json({ ok: true });
  }

  if (b.type === 'allergy') {
    const substance = text(b.substance, 80);
    if (!substance) return fail(res, 400, 'What is the allergy to?');
    q.insertRecord({ ...base, kind: 'allergy', title: substance, detail: text(b.reaction, 120) || null, data: {} });
    log(`Added an allergy: ${substance}`);
    return res.status(201).json({ ok: true });
  }
  fail(res, 400, 'Unknown record type.');
});
app.use('/api/h', hosp);

app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, 'That file is too large.');
  console.error(err);
  fail(res, 500, 'Something went wrong on our side.');
});

export default app;
