// App shell: routing, sign-in, share screen, hospital pages, add-record forms.
// The timeline and medicines lists live in views/. All data reaches the DOM through el()
// (textContent), never innerHTML.
import { el, fmtDate, plural, upperFirst } from './views/dom.js';
import { renderTimeline } from './views/timeline.js';
import { renderMedicines } from './views/medicines.js';
import { scanPanel } from './views/scan.js';

const main = document.getElementById('main');

// replaceChildren() renders null/undefined as the literal text "null", so every swap goes through here.
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

// ---------- session + api --------------------------------------------------------
// Proof that this hospital opened a code. Kept per tab, like the sign-in.
const grants = (() => { try { return JSON.parse(sessionStorage.getItem('grants')) ?? {}; } catch { return {}; } })();
const keepGrant = (code, grant) => { grants[code.replace(/[^A-Z0-9]/gi, '').toUpperCase()] = grant; try { sessionStorage.setItem('grants', JSON.stringify(grants)); } catch { /* ignore */ } };
const grantFor = (path) => grants[(/^\/api\/h\/([A-Za-z0-9-]+)\//.exec(path)?.[1] ?? '').replace(/-/g, '').toUpperCase()];

const store = {
  get: () => { try { return JSON.parse(sessionStorage.getItem('session')); } catch { return null; } },
  set: (v) => { try { sessionStorage.setItem('session', JSON.stringify(v)); } catch { /* private mode: stay signed in for this page only */ memory = v; } },
  clear: () => { memory = null; try { sessionStorage.removeItem('session'); } catch { /* ignore */ } },
};
let memory = null;
const session = () => store.get() ?? memory;

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

async function api(path, { method = 'GET', body } = {}) {
  const s = session();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(s ? { Authorization: `Bearer ${s.token}` } : {}), ...(grantFor(path) ? { 'X-Grant': grantFor(path) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong.', res.status);
  return data;
}

function signOut(note) {
  store.clear();
  go('/', note);
}

let flash = null;
function go(path, note) {
  flash = note ?? null;
  if (location.hash === `#${path}`) render();
  else location.hash = path;
}

async function openFile(base, id) {
  const s = session();
  try {
    const res = await fetch(`${base}/${id}`, { headers: { Authorization: `Bearer ${s.token}`, ...(grantFor(`${base}/`) ? { 'X-Grant': grantFor(`${base}/`) } : {}) } });
    if (!res.ok) throw new Error();
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    alert('Could not open that file.');
  }
}

// ---------- small ui helpers ------------------------------------------------------
let msgSeq = 0;
const msgBox = () => el('div', { class: 'msg', id: `msg-${++msgSeq}`, role: 'status', 'aria-live': 'polite' });

// After a failed save, point at the required fields that are still empty and link them to the message.
function markInvalid(form, box) {
  for (const input of form.querySelectorAll('[required]')) {
    const empty = !input.value.trim();
    input.setAttribute('aria-invalid', String(empty));
    if (empty) {
      input.setAttribute('aria-describedby', box.id);
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'), { once: true });
    }
  }
  form.querySelector('[aria-invalid="true"]')?.focus();
}
function say(box, text, kind = 'info') {
  fill(box, text ? el('p', { class: `notice${kind === 'warn' ? ' warn' : ''}`, role: kind === 'warn' ? 'alert' : null }, text) : '');
}

function field({ name, label, type = 'text', options, hint, value, placeholder, required, rows, list, max }) {
  let input;
  if (options) {
    input = el('select', { name, required }, options.map((o) => el('option', { value: o.value ?? o }, o.label ?? o)));
    if (value != null) input.value = value;
  } else if (rows) {
    input = el('textarea', { name, rows, placeholder, maxlength: max });
  } else {
    input = el('input', { name, type, value, placeholder, required, list, maxlength: max, autocomplete: 'off', inputmode: type === 'number' ? 'decimal' : null, step: type === 'number' ? 'any' : null });
  }
  return el('label', { class: 'field' }, el('span', null, label), input, hint ? el('small', null, hint) : null);
}

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);

function ago(days) {
  if (days == null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function page(title, nodes, { wide = false } = {}) {
  document.title = `${title} · One Record`;
  main.className = `page${wide ? ' wide' : ''}`;
  fill(main, ...nodes);
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// Shown wherever invented values appear, so nobody mistakes them for record data.
const demoNote = () => el('p', { class: 'fine-print' }, 'Demo values: blood group is made up for this demo, and the high/low labels on tests come from a short built-in range table, not from the hospital. Real ranges differ by lab.');

const loading = () => el('p', { class: 'meta' }, 'Loading…');

function failure(err, retry) {
  if (err.status === 401) return signOut('Please sign in again.');
  return el('div', { class: 'empty' },
    el('strong', null, 'That did not work.'), err.message, ' ',
    retry ? el('button', { class: 'linkbtn', type: 'button', onclick: retry }, 'Try again') : null);
}

// Wire an onclick given as attribute-less handler
function btn(label, onClick, cls = 'btn') {
  const b = el('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', onClick);
  return b;
}
function linkbtn(label, onClick) { return btn(label, onClick, 'linkbtn'); }

// ---------- landing -------------------------------------------------------------------
async function landing() {
  const patientMsg = msgBox();
  const hospitalMsg = msgBox();
  const patientSel = el('select', { name: 'patient', 'aria-label': 'Choose a sample patient' }, el('option', { value: '' }, 'Loading…'));
  const hospitalSel = el('select', { name: 'hospital', 'aria-label': 'Choose a hospital' });

  page('Welcome', [
    el('div', { class: 'landing' },
      el('h1', null, 'One Record'),
      el('p', { class: 'lede' }, 'Prescriptions, test results and hospital visits are scattered across clinics and labs. Here they sit on one timeline, and you decide which hospital gets to see them.'),
      flash ? el('p', { class: 'notice' }, flash) : null,
      el('section', null,
        el('h2', null, "I'm a patient"),
        el('label', { class: 'field' }, el('span', null, 'Sample patient'), patientSel),
        patientMsg,
        btn('Open my records', async () => {
          if (!patientSel.value) return say(patientMsg, 'Choose a sample patient first.', 'warn');
          try {
            const r = await api('/api/login', { method: 'POST', body: { role: 'patient', patientId: patientSel.value } });
            store.set({ token: r.token, role: 'patient' });
            go('/p/timeline');
          } catch (e) { say(patientMsg, e.message, 'warn'); }
        })),
      el('section', null,
        el('h2', null, "I'm at a hospital"),
        el('label', { class: 'field' }, el('span', null, 'Hospital'), hospitalSel),
        hospitalMsg,
        btn('Continue', async () => {
          try {
            const r = await api('/api/login', { method: 'POST', body: { role: 'hospital', hospital: hospitalSel.value } });
            store.set({ token: r.token, role: 'hospital', hospital: hospitalSel.value });
            go('/h');
          } catch (e) { say(hospitalMsg, e.message, 'warn'); }
        })),
      el('p', { class: 'fine' }, 'This is a hackathon demo. Every person here is synthetic, generated with Synthea, so no real patient data is involved. The sign-in above is a picker, not a password; a real deployment would use proper identity.')),
  ]);
  flash = null;

  try {
    const demo = await api('/api/demo');
    fill(patientSel, 
      el('option', { value: '' }, 'Choose…'),
      ...demo.patients.map((p) => el('option', { value: p.id }, `${p.name} (${p.age}, ${p.gender})`)),
    );
    fill(hospitalSel, ...demo.hospitals.map((h) => el('option', { value: h }, h)));
  } catch (e) {
    say(patientMsg, e.message, 'warn');
  }
}

// ---------- patient ---------------------------------------------------------------------
function patientTop(ov, tab) {
  const p = ov.patient;
  const tabs = [['timeline', 'Timeline'], ['medicines', 'Medicines'], ['share', 'Share']];
  return el('header', { class: 'top' },
    el('div', { class: 'who' }, p.name, el('small', null, [p.age != null ? `${p.age}` : null, p.bloodGroup ? `${p.bloodGroup} (demo)` : null].filter(Boolean).join(' · '))),
    el('div', { class: 'right' },
      el('nav', { class: 'tabs', 'aria-label': 'Sections' }, tabs.map(([k, label]) => el('a', { href: `#/p/${k}`, 'aria-current': k === tab ? 'page' : null }, label))),
      linkbtn('Sign out', () => signOut())));
}

async function patientView(tab) {
  page('Your records', [loading()]);
  let ov;
  try { ov = await api('/api/me/overview'); } catch (e) { return page('Error', [failure(e, render)]); }
  const body = el('div', null, loading());
  page(upperFirst(tab), [patientTop(ov, tab), body]);

  try {
    if (tab === 'timeline') await patientTimeline(body, ov);
    else if (tab === 'medicines') await patientMedicines(body);
    else await patientShare(body);
  } catch (e) { fill(body, failure(e, render)); }
}

function allergyLine(allergies) {
  if (!allergies.length) return el('p', { class: 'allergy-line none' }, 'No allergies on file.');
  return el('p', { class: 'allergy-line' }, 'Allergies: ', allergies.map((a) => a.substance + (a.reaction ? ` (${a.reaction})` : '')).join(', '));
}

function filesList(events, base) {
  const files = events.filter((e) => e.fileId);
  if (!files.length) return null;
  return el('details', { class: 'no-print' },
    el('summary', null, `Files (${files.length})`),
    el('ul', { class: 'plain' }, files.map((f) => el('li', null,
      el('span', null, f.title, el('span', { class: 'meta' }, f.date ? ` · ${fmtDate(f.date)}` : '')),
      linkbtn('Open', () => openFile(base, f.fileId))))));
}

async function patientTimeline(body, ov) {
  const events = await api('/api/me/timeline');
  const list = el('div');
  fill(body, 
    el('div', { class: 'intro' }, el('h1', null, 'Your records'), el('p', null, `${plural(events.length, 'record')} from every place you have been seen.`)),
    allergyLine(ov.allergies),
    addPatientForm(render),
    filesList(events, '/api/me/files'),
    list,
    demoNote(),
  );
  renderTimeline(list, events);
}

function addPatientForm(onSaved) {
  const msg = msgBox();
  const kind = field({
    name: 'kind', label: 'What are you adding?',
    options: [{ value: 'scan', label: 'Scan a report or prescription (we read it for you)' }, { value: 'document', label: 'A document, stored as it is' }, { value: 'allergy', label: 'An allergy' }],
  });
  const holder = el('div');
  const form = el('form', { novalidate: true }, kind, holder, msg);
  const submit = el('button', { class: 'btn', type: 'submit' }, 'Save');
  const draw = () => {
    const k = kind.querySelector('select').value;
    say(msg, '');
    if (k === 'scan') return fill(holder, scanPanel({ api, onSaved }));
    fill(holder, 
      ...(k === 'document'
        ? [field({ name: 'title', label: 'Name', placeholder: 'Blood test from Metro Lab', required: true, max: 120 }),
          el('div', { class: 'row2' }, field({ name: 'date', label: 'Date', type: 'date', value: today() }), field({ name: 'source', label: 'From (optional)', placeholder: 'Clinic or lab', max: 120 })),
          el('label', { class: 'field' }, el('span', null, 'Photo or PDF (optional)'), el('input', { type: 'file', name: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp' }), el('small', null, 'Up to 3 MB.')),
          field({ name: 'detail', label: 'Note (optional)', rows: 2, max: 300 })]
        : [field({ name: 'substance', label: 'Allergic to', placeholder: 'Penicillin', required: true, max: 80 }), field({ name: 'reaction', label: 'What happens (optional)', placeholder: 'Rash', max: 120 })]),
      el('div', { class: 'actions' }, submit));
  };
  kind.querySelector('select').addEventListener('change', draw);
  draw();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(form);
    submit.disabled = true;
    try {
      if (v.kind === 'allergy') await api('/api/me/allergies', { method: 'POST', body: { substance: v.substance, reaction: v.reaction } });
      else {
        const body = { title: v.title, date: v.date, source: v.source, detail: v.detail };
        const f = v.file;
        if (f && f.size) {
          if (f.size > 3 * 1024 * 1024) throw new ApiError('Files can be up to 3 MB.', 400);
          body.file = { mime: f.type, name: f.name, base64: await toBase64(f) };
        }
        await api('/api/me/documents', { method: 'POST', body });
      }
      onSaved();
    } catch (e) { say(msg, e.message, 'warn'); markInvalid(form, msg); submit.disabled = false; }
  });
  return el('details', { class: 'add no-print' }, el('summary', null, 'Add something or scan a report'), form);
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(new ApiError('Could not read that file.', 400));
  r.readAsDataURL(file);
});

async function patientMedicines(body) {
  const meds = await api('/api/me/medicines');
  const list = el('div');
  fill(body, 
    el('div', { class: 'intro' }, el('h1', null, 'Medicines'), el('p', null, 'Everything you are taking, from every doctor, in one list.')),
    list);
  renderMedicines(list, meds);
}

async function patientShare(body) {
  const [shares, log] = await Promise.all([api('/api/me/shares'), api('/api/me/log')]);
  const msg = msgBox();
  const result = el('div', { role: 'status' });

  const scope = el('fieldset', { style: 'border:0;padding:0;margin:0 0 1rem' },
    el('legend', { style: 'font-weight:600;margin-bottom:.25rem' }, 'What can they see?'),
    el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'scope', value: 'emergency', checked: true }), el('span', null, 'Emergency summary only', el('small', null, 'Allergies, current medicines, conditions and the last few visits.'))),
    el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'scope', value: 'full' }), el('span', null, 'Everything', el('small', null, 'The full timeline and test history, so they can avoid repeating tests.'))));
  const duration = field({ name: 'duration', label: 'For how long?', options: [{ value: '1h', label: '1 hour' }, { value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }], value: '24h' });
  const form = el('form', null, scope, duration, msg, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'submit' }, 'Make a code')));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(form);
    try {
      const s = await api('/api/me/shares', { method: 'POST', body: { scope: v.scope, duration: v.duration } });
      fill(result, el('div', { class: 'codebox' },
        el('p', { class: 'meta' }, 'Tell the hospital this code'),
        el('p', { class: 'code', 'aria-label': s.code.split('').join(' ') }, s.code),
        el('p', { class: 'meta' }, `${s.scope === 'full' ? 'Everything' : 'Emergency summary'} · works until ${when(s.expiresAt)}`)));
      say(msg, '');
      patientShareLists(listsBox, await api('/api/me/shares'), await api('/api/me/log'));
    } catch (e) { say(msg, e.message, 'warn'); }
  });

  const listsBox = el('div');
  fill(body, 
    el('div', { class: 'intro' }, el('h1', null, 'Show a hospital your records'), el('p', null, 'Make a short code and read it out. They can see only what you choose, only until it runs out, and you can stop it at any time.')),
    form, result, listsBox);
  patientShareLists(listsBox, shares, log);
}

function patientShareLists(box, shares, log) {
  const rerun = async () => patientShareLists(box, await api('/api/me/shares'), await api('/api/me/log'));
  fill(box, 
    el('h2', { class: 'section-title' }, 'Your codes'),
    shares.length
      ? el('ul', { class: 'plain' }, shares.map((s) => el('li', null,
        el('span', null, el('strong', null, s.code), ' ', el('span', { class: 'meta' }, `${s.scope === 'full' ? 'everything' : 'emergency summary'} · ${s.state === 'active' ? timeLeft(s.expiresAt) : s.state}`)),
        s.state === 'active' ? linkbtn('Stop sharing', async () => { await api(`/api/me/shares/${s.id}/revoke`, { method: 'POST' }); rerun(); }) : el('span', { class: 'state ended' }, s.state))))
      : el('p', { class: 'meta' }, 'You have not made any codes yet.'),
    el('h2', { class: 'section-title' }, 'Who has looked'),
    log.length
      ? el('ul', { class: 'plain stack' }, log.map((l) => el('li', null, el('span', null, el('strong', null, l.who), ` · ${l.action}`), el('span', { class: 'meta' }, `${when(l.at)} · code ${l.code}`))))
      : el('p', { class: 'meta' }, 'Nobody has opened your record.'));
}

// ---------- hospital ---------------------------------------------------------------------------
function hospitalTop(extra) {
  return el('header', { class: 'top' },
    el('div', { class: 'who' }, session().hospital, el('small', null, 'Hospital view')),
    el('div', { class: 'right' }, extra, linkbtn('Sign out', () => signOut())));
}

function hospitalHome() {
  const msg = msgBox();
  const input = el('input', { class: 'codeinput', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 8, 'aria-label': "Patient's code", placeholder: 'K7M-2QX' });
  const form = el('form', null, el('label', { class: 'field' }, el('span', null, "Patient's code"), input, el('small', null, 'The patient reads this out from their phone.')), msg, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'submit' }, 'Open record')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/h/open', { method: 'POST', body: { code: input.value } });
      keepGrant(r.code, r.grant);
      go(`/h/${r.code.replace('-', '')}`);
    } catch (e) {
      if (e.status === 401) return signOut('Please sign in again.');
      say(msg, e.message, 'warn');
    }
  });
  page('Find a patient', [hospitalTop(), el('div', { class: 'intro' }, el('h1', null, 'Open a patient record'), el('p', null, 'You will see only what the patient has agreed to share. Every time you open a record, they can see that you did.')), form]);
  input.focus();
}

let pageNote = null; // shown once on the patient page after a save, e.g. a unit conversion

async function hospitalPatient(code) {
  page('Patient', [hospitalTop(), loading()], { wide: true });
  let ov;
  try { ov = await api(`/api/h/${code}/overview`); } catch (e) {
    if (e.status === 403) return go('/h', e.message);
    return page('Error', [hospitalTop(), failure(e, render)], { wide: true });
  }
  const full = ov.share.scope === 'full';
  const p = ov.patient;
  const base = `/api/h/${code}`;

  const medsBox = el('div');
  const visits = ov.recentVisits.length
    ? el('ul', { class: 'plain-list' }, ov.recentVisits.map((v) => el('li', null, el('div', null, el('strong', null, v.title)), el('div', { class: 'meta' }, [fmtDate(v.date), v.place].filter(Boolean).join(' · ')))))
    : el('p', { class: 'meta' }, 'No visits on file.');
  const activeConditions = ov.conditions.filter((c) => c.active);
  const conditions = activeConditions.length
    ? el('ul', { class: 'plain-list' }, activeConditions.slice(0, 12).map((c) => el('li', null, c.name, c.since ? el('span', { class: 'meta' }, ` · since ${fmtDate(c.since, { year: true })}`) : null)))
    : el('p', { class: 'meta' }, 'None recorded.');

  const refreshable = el('div');
  const searchBox = full ? testSearch(base) : null;
  const timelineBox = el('div');

  page(p.name, [
    hospitalTop(el('span', { class: 'meta no-print' }, `Code ${ov.share.code} · ${timeLeft(ov.share.expiresAt)}`)),
    el('div', { class: 'patient-head' },
      el('h1', null, p.name),
      el('div', { class: 'facts' }, [p.age != null ? `${p.age} years` : null, p.gender, p.bloodGroup ? `Blood group ${p.bloodGroup} (demo value)` : null].filter(Boolean).join(' · '))),
    allergyLine(ov.allergies),
    savedNote(),
    el('div', { class: 'actions no-print' }, btn('Print this summary', () => window.print(), 'btn quiet'), linkbtn('Close record', () => go('/h'))),
    el('div', { class: 'cols' },
      el('div', null, el('h2', { class: 'section-title' }, 'Medicines'), medsBox),
      el('div', null, el('h2', { class: 'section-title' }, 'Recent visits'), visits, el('h2', { class: 'section-title' }, 'Ongoing conditions'), conditions)),
    full ? null : el('p', { class: 'notice no-print' }, 'The patient shared the emergency summary only. Ask them for a full code if you need their test history.'),
    searchBox,
    el('div', { class: 'no-print' }, addRecordForm(code, render)),
    refreshable,
    el('div', { class: 'no-print' }, timelineBox),
    demoNote(),
  ], { wide: true });

  renderMedicines(medsBox, ov.medicines);
  if (full) {
    try {
      const events = await api(`${base}/timeline`);
      fill(timelineBox, el('h2', { class: 'section-title' }, `Full timeline (${events.length})`), filesList(events, `${base}/files`), el('div', { id: 'tl' }));
      renderTimeline(timelineBox.querySelector('#tl'), events);
    } catch (e) { fill(timelineBox, failure(e, render)); }
  }
}

function savedNote() {
  const text = pageNote;
  pageNote = null;
  return text ? el('p', { class: 'notice no-print', role: 'status' }, `Saved. ${text}.`) : null;
}

// "Before you order a test": has this patient already had it?
function testSearch(base) {
  const out = el('div', { 'aria-live': 'polite' });
  const input = el('input', { type: 'search', placeholder: 'e.g. cholesterol, sugar, kidney, thyroid', 'aria-label': 'Search tests already done', autocomplete: 'off' });
  let timer; let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { fill(out, ); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const hits = await api(`${base}/tests?q=${encodeURIComponent(term)}`);
        if (mine !== seq) return;
        fill(out, ...(hits.length
          ? hits.map(testHit)
          : [el('p', { class: 'meta' }, `Nothing matching "${term}" on file. This patient has not had it done, as far as these records show.`)]));
      } catch (e) { fill(out, failure(e)); }
    }, 250);
  });
  return el('section', { class: 'no-print' },
    el('h2', { class: 'section-title' }, 'Before you order a test'),
    el('label', { class: 'field', style: 'margin-top:.75rem' }, el('span', null, 'Has the patient had this already?'), input),
    out);
}

const FLAG = { H: 'high', HH: 'very high', L: 'low', LL: 'very low' };
function testHit(h) {
  const L = h.latest;
  const value = h.isPanel ? `${L.count} results` : (L.value != null ? `${L.value} ${(L.unit ?? '').replace(/[{}]/g, '')}`.trim() : L.text);
  const flag = FLAG[L.flag];
  const lines = [
    `Last done ${ago(L.daysAgo)} (${fmtDate(L.date)})${L.place ? ` at ${L.place}` : ''}`,
    [value, flag ? `(${flag})` : null].filter(Boolean).join(' '),
    h.times > 1 ? `On file ${h.times} times` : null,
  ].filter(Boolean);
  return el('div', { class: `found${L.daysAgo <= 30 ? ' recent' : ''}` },
    el('div', { class: 'name' }, h.name),
    lines.map((t) => el('div', { class: 'meta' }, t)),
    sparkline(h.trend));
}

function sparkline(points) {
  if (points.length < 2) return null;
  const W = 120; const H = 28; const pad = 3;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals); const hi = Math.max(...vals); const span = hi - lo || 1;
  const xy = points.map((p, i) => [pad + (i * (W - 2 * pad)) / (points.length - 1), H - pad - ((p.value - lo) / span) * (H - 2 * pad)]);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Trend over ${points.length} results, from ${vals[0]} to ${vals[vals.length - 1]}`);
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('class', 'spark'); line.setAttribute('points', xy.map((p) => p.join(',')).join(' '));
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', 'spark-dot'); dot.setAttribute('r', 2.6); dot.setAttribute('cx', xy.at(-1)[0]); dot.setAttribute('cy', xy.at(-1)[1]);
  svg.append(line, dot);
  return svg;
}

// ---------- hospital: add to the record -----------------------------------------------------------
function addRecordForm(code, onSaved) {
  const base = `/api/h/${code}`;
  const msg = msgBox();
  const holder = el('div');
  const type = field({
    name: 'type', label: 'What are you adding?',
    options: [{ value: 'prescription', label: 'A prescription' }, { value: 'lab', label: 'A test result' }, { value: 'note', label: 'A visit note' }, { value: 'discharge', label: 'A discharge summary' }, { value: 'allergy', label: 'An allergy' }],
  });
  const form = el('form', { novalidate: true }, type, holder, msg);
  let confirmed = false;
  let catalog = null;

  const submit = el('button', { class: 'btn', type: 'submit' }, 'Save');
  const draw = async () => {
    confirmed = false; say(msg, ''); submit.textContent = 'Save';
    const t = type.querySelector('select').value;
    const nodes = [];
    const date = field({ name: 'date', label: 'Date', type: 'date', value: today() });
    if (t === 'prescription') {
      nodes.push(
        field({ name: 'name', label: 'Medicine', placeholder: 'Dolo 650, or paracetamol', required: true, hint: 'Brand or generic name. We check it against what the patient already takes.', max: 120 }),
        el('div', { class: 'row2' }, field({ name: 'dose', label: 'Dose', placeholder: '650 mg', max: 60 }), field({ name: 'frequency', label: 'How often', placeholder: 'Three times a day', max: 60 })),
        el('div', { class: 'row2' }, field({ name: 'days', label: 'For how many days', type: 'number', placeholder: '5' }), date));
    } else if (t === 'lab') {
      catalog ??= await api('/api/h/labs/catalog').catch(() => []);
      const sel = field({ name: 'code', label: 'Test', options: catalog.map((c) => ({ value: c.code, label: c.name })) });
      const unit = field({ name: 'unit', label: 'Unit', placeholder: catalog[0]?.unit, hint: 'Leave it as is, or type another unit such as mmol/L. We convert when we can.' });
      const sync = () => { unit.querySelector('input').placeholder = catalog.find((c) => c.code === sel.querySelector('select').value)?.unit ?? ''; };
      sel.querySelector('select').addEventListener('change', sync);
      nodes.push(sel, el('div', { class: 'row2' }, field({ name: 'value', label: 'Result', type: 'number', required: true }), unit), date);
    } else if (t === 'allergy') {
      nodes.push(field({ name: 'substance', label: 'Allergic to', placeholder: 'Penicillin', required: true, max: 80 }), field({ name: 'reaction', label: 'Reaction (optional)', placeholder: 'Rash', max: 120 }));
    } else {
      nodes.push(field({ name: 'title', label: 'Title', placeholder: t === 'discharge' ? 'Discharge after appendectomy' : 'Chest pain, ECG normal', required: true, max: 120 }), field({ name: 'detail', label: 'Details', rows: 4, max: 1500 }), date);
    }
    fill(holder, ...nodes, el('div', { class: 'actions' }, submit));
  };
  type.querySelector('select').addEventListener('change', draw);
  draw();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = formValues(form);
    submit.disabled = true;
    try {
      if (v.type === 'prescription') {
        if (!confirmed) {
          const { warnings } = await api(`${base}/records`, { method: 'POST', body: { ...v, check: true } });
          if (warnings.length) {
            confirmed = true;
            fill(msg, ...warnings.map((w) => el('p', { class: `notice${w.type === 'same-family' || w.type === 'unknown' ? '' : ' warn'}`, role: 'alert' }, w.text)));
            submit.textContent = 'Add anyway';
            submit.disabled = false;
            return;
          }
        }
        await api(`${base}/records`, { method: 'POST', body: { ...v, confirmed } });
      } else {
        const r = await api(`${base}/records`, { method: 'POST', body: v });
        if (r.converted) pageNote = r.converted;
      }
      onSaved();
    } catch (e) {
      if (e.status === 401) return signOut('Please sign in again.');
      say(msg, e.message, 'warn'); markInvalid(form, msg); submit.disabled = false;
    }
  });
  return el('details', { class: 'add' }, el('summary', null, 'Add to this record'), form);
}

// ---------- routing -----------------------------------------------------------------------------------
async function render() {
  const [, area, rest] = location.hash.replace(/^#/, '').split('/');
  const s = session();

  if (area === 'p') {
    if (s?.role !== 'patient') return go('/');
    return patientView(['timeline', 'medicines', 'share'].includes(rest) ? rest : 'timeline');
  }
  if (area === 'h') {
    if (s?.role !== 'hospital') return go('/');
    if (!rest) { const note = flash; flash = null; hospitalHome(); if (note) main.querySelector('.intro')?.after(el('p', { class: 'notice warn', role: 'alert' }, note)); return; }
    return hospitalPatient(rest.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  }
  return landing();
}

window.addEventListener('hashchange', render);
render();
