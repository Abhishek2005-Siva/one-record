import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { sign, verify } from './auth.js';
import { fileURLToPath } from 'node:url';
import { q, db, tx } from './db.js';
import { seedIfEmpty } from './import.js';
import { reconcile, checkNewMedicine, ingredientsOf, normaliseLab, flagFor, tidyDrugName } from './meds.js';
import { LABS, HOSPITALS } from './catalog.js';
import { decodeUpload, UploadError } from './files.js';
import { extractText } from './ocr.js';
import { interpret, KINDS } from './scan.js';

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
// a real calendar day: Date rolls 2026-02-30 over to March, so check that it round-trips
const isDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
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

me.post('/documents', (req, res) => {
  const title = text(req.body?.title, 120);
  if (!title) return fail(res, 400, 'Give the document a name, like "Blood test from Metro Lab".');
  const date = req.body?.date ? (isDate(req.body.date) ? req.body.date : null) : today();
  if (req.body?.date && !date) return fail(res, 400, 'That date does not look right.');
  const id = randomUUID();
  let file = null;
  if (req.body?.file) {
    try { file = decodeUpload(req.body.file); } catch (e) { if (e instanceof UploadError) return fail(res, e.status, e.message); throw e; }
  }
  const fileId = file ? randomUUID() : null;
  q.insertRecord({
    id, patient_id: req.session.patientId, kind: 'document', date, title, detail: text(req.body?.detail, 300) || null,
    source: text(req.body?.source, 120) || 'Added by patient', source_kind: 'patient',
    data: file ? { fileId, fileName: file.name, mime: file.mime } : {},
  });
  if (file) db.prepare('INSERT INTO files (id, record_id, mime, name, body) VALUES (?, ?, ?, ?, ?)').run(fileId, id, file.mime, file.name, file.buf);
  res.status(201).json({ id });
});

// ---------- scan a report: read it, show what was found, save only after the patient checks it ----------
// Reading is slow and uses a lot of memory, so only a couple of files are read at once.
let reading = 0;
const MAX_READING = 2;
const READ_TIMEOUT_MS = 45000;

me.post('/scan', async (req, res) => {
  let file;
  try { file = decodeUpload(req.body?.file); } catch (e) { if (e instanceof UploadError) return fail(res, e.status, e.message); throw e; }
  if (reading >= MAX_READING) return fail(res, 503, 'Other files are being read right now. Try again in a few seconds.');
  reading++;
  try {
    let timer;
    const read = await Promise.race([
      extractText(file.buf, file.mime),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new UploadError('Reading took too long. Try a smaller or clearer photo.', 504)), READ_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const p = q.patient(req.session.patientId);
    const found = interpret(read.text, { patientName: p?.name });
    const all = q.records(req.session.patientId);
    const allergies = all.filter((r) => r.kind === 'allergy');
    // tell the patient now if a medicine on the page repeats something they already take
    for (const m of found.medicines) {
      m.checks = checkNewMedicine(m.name, all, allergies, today()).filter((w) => w.type !== 'unknown');
    }
    if (read.truncated) found.warnings.push(`Only the first pages of this file were read (it has ${read.pages}).`);
    if (read.method !== 'pdf-text' && read.confidence != null && read.confidence < 60) {
      found.warnings.push('This was hard to read, so some of it may be wrong. Check every line against your paper.');
    }
    res.json({ ...found, method: read.method, confidence: read.confidence, pages: read.pages, text: read.text.trim().slice(0, 4000), kinds: KINDS });
  } catch (e) {
    if (e instanceof UploadError) return fail(res, e.status, e.message);
    console.error('scan failed:', e?.message ?? e);
    return fail(res, 422, 'We could not read that file. Try a clearer photo, or save it as a document and fill in the details yourself.');
  } finally { reading--; }
});

const FLAGS = new Set(['H', 'HH', 'L', 'LL']);
const finite = (v) => Number.isFinite(v) && Math.abs(v) < 1e7;

me.post('/scan/save', (req, res) => {
  let file;
  try { file = decodeUpload(req.body?.file); } catch (e) { if (e instanceof UploadError) return fail(res, e.status, e.message); throw e; }
  const r = req.body?.review ?? {};
  const kind = Object.hasOwn(KINDS, r.kind) ? r.kind : 'other';
  const date = r.date ? (isDate(r.date) && r.date <= today() ? r.date : null) : null;
  if (r.date && !date) return fail(res, 400, 'That date does not look right.');
  const title = text(r.title, 120) || KINDS[kind];
  const source = text(r.source, 120) || null;

  const results = [];
  for (const l of (Array.isArray(r.labs) ? r.labs : []).slice(0, 60)) {
    if (l?.include === false) continue;
    const value = Number(l?.value);
    const def = LABS[text(l?.code, 20)];
    const label = def?.name ?? text(l?.name, 80);
    if (!label) return fail(res, 400, 'One of the results has no name.');
    if (l?.value === '' || l?.value == null || !finite(value)) return fail(res, 400, `The result for ${label} should be a number.`);
    if (def) {
      const n = normaliseLab(text(l.code, 20), value, text(l.unit, 20) || def.unit);
      if (n.unknownUnit) return fail(res, 400, `We cannot convert "${text(l.unit, 20)}" for ${def.name}. Use ${def.unit}.`);
      results.push({ name: def.name, loinc: text(l.code, 20), value: n.value, unit: n.unit, flag: FLAGS.has(l.flag) ? l.flag : flagFor(text(l.code, 20), n.value) });
    } else {
      results.push({ name: label, value, unit: text(l?.unit, 20) || null, flag: FLAGS.has(l?.flag) ? l.flag : null });
    }
  }

  const meds = [];
  for (const m of (Array.isArray(r.medicines) ? r.medicines : []).slice(0, 30)) {
    if (m?.include === false) continue;
    const name = tidyDrugName(text(m?.name, 120));
    if (!name) return fail(res, 400, 'One of the medicines has no name.');
    const days = m?.days ? Math.round(Number(m.days)) : null;
    if (m?.days && !(days > 0 && days <= 365)) return fail(res, 400, `Days for ${name} should be between 1 and 365.`);
    meds.push({ name, dose: text(m?.dose, 60) || null, frequency: text(m?.frequency, 60) || null, days });
  }
  if (kind === 'prescription' && meds.length && !date) return fail(res, 400, 'Add the date of the prescription so we know how long each medicine lasts.');

  let stay = null;
  if (kind === 'discharge' && (r.stay?.from || r.stay?.to)) {
    const from = isDate(r.stay.from) ? r.stay.from : null;
    const to = isDate(r.stay.to) ? r.stay.to : null;
    if (from || to) stay = { from: from ?? to, to: to ?? from };
  }

  const pid = req.session.patientId;
  const primaryId = randomUUID();
  const fileId = randomUUID();
  const common = {
    fileId, fileName: file.name, mime: file.mime,
    scan: { method: ['pdf-text', 'ocr', 'mixed'].includes(r.method) ? r.method : null, reviewed: true },
  };
  const base = { patient_id: pid, date, source: source ?? 'Added by patient', source_kind: 'patient' };
  const detail = text(r.detail, 1500) || null;

  // the primary record holds the original file; a prescription also gets one record per medicine
  let primary;
  if (kind === 'lab' && results.length) primary = { kind: 'lab', title, detail: null, data: { ...common, results } };
  else if (kind === 'discharge') primary = { kind: 'discharge', title, detail, data: { ...common, ...(stay ? { stay } : {}) } };
  else if (kind === 'scan') primary = { kind: 'scan', title, detail, data: common };
  else if (kind === 'prescription' && meds.length) primary = { kind: 'document', title, detail: `${meds.length} medicine${meds.length === 1 ? '' : 's'} read from this prescription`, data: common };
  else primary = { kind: 'document', title, detail, data: common };

  tx(() => {
    q.insertRecord({ id: primaryId, ...base, ...primary });
    db.prepare('INSERT INTO files (id, record_id, mime, name, body) VALUES (?, ?, ?, ?, ?)').run(fileId, primaryId, file.mime, file.name, file.buf);
    if (kind === 'prescription') {
      for (const m of meds) {
        const end = m.days ? new Date(Date.parse(date) + m.days * 86400000).toISOString().slice(0, 10) : null;
        q.insertRecord({
          id: randomUUID(), ...base, kind: 'medicine', title: m.name,
          detail: [m.dose, m.frequency, m.days && `${m.days} days`].filter(Boolean).join(' · ') || null,
          data: { status: 'active', dose: m.dose, frequency: m.frequency, endDate: end, times: 1, since: date, ingredients: ingredientsOf(m.name), fromDocument: primaryId },
        });
      }
    }
  });
  res.status(201).json({ ok: true, saved: { kind: primary.kind, results: kind === 'lab' ? results.length : 0, medicines: kind === 'prescription' ? meds.length : 0 } });
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
  if (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') return fail(res, 400, 'That request could not be read.');
  console.error(err);
  fail(res, 500, 'Something went wrong on our side.');
});

export default app;
