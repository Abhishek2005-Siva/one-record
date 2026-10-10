// "Scan a report": the patient picks a photo or PDF, the server reads it, and this panel shows what
// it found so the patient can correct it before anything is saved. Reading a photo gets digits wrong
// now and then, so nothing is stored until the patient presses Save.
import { el, fmtDate } from './dom.js';

const MAX_BYTES = 3 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.readAsDataURL(file);
});

const note = (text, warn = false) => el('p', { class: `notice${warn ? ' warn' : ''}`, role: warn ? 'alert' : null }, text);
const small = (text) => el('small', { class: 'meta' }, text);

/**
 * @param {{ api: Function, onSaved: Function }} deps api(path, {method, body}) from the app shell
 * @returns {HTMLElement}
 */
export function scanPanel({ api, onSaved }) {
  const root = el('div', { class: 'scan' });
  const draw = (...nodes) => root.replaceChildren(...nodes.flat().filter(Boolean));

  // ---------- step 1: choose a file ----------
  function pick(error) {
    const input = el('input', { type: 'file', name: 'scanfile', accept: ACCEPT, id: 'scanfile' });
    const status = el('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const go = el('button', { class: 'btn', type: 'button' }, 'Read it');
    if (error) status.append(note(error, true));

    const form = el('div', null,
      el('label', { class: 'field' },
        el('span', null, 'Photo or PDF of a report or prescription'),
        input,
        el('small', null, 'Up to 3 MB. We read the text on it and sort it for you. You check it before anything is saved.')),
      status,
      el('div', { class: 'actions' }, go));

    go.addEventListener('click', async () => {
      const file = input.files?.[0];
      if (!file) { status.replaceChildren(note('Choose a photo or a PDF first.', true)); input.focus(); return; }
      if (file.size > MAX_BYTES) { status.replaceChildren(note('That file is over 3 MB. Take the photo at a lower resolution, or pick a smaller PDF.', true)); return; }
      go.disabled = true;
      input.disabled = true;
      status.replaceChildren(el('p', { class: 'notice' }, 'Reading your file. This can take up to 20 seconds.'));
      try {
        const payload = { mime: file.type, name: file.name, base64: await toBase64(file) };
        const found = await api('/api/me/scan', { method: 'POST', body: { file: payload } });
        review(payload, found);
      } catch (e) {
        go.disabled = false;
        input.disabled = false;
        status.replaceChildren(note(e.message, true));
      }
    });
    draw(form);
  }

  // ---------- step 2: check what was found ----------
  function review(file, found) {
    const s = {
      kind: found.kind, title: found.title ?? '', date: found.date ?? '', source: found.source ?? '', detail: found.detail ?? '',
      stay: found.stay ?? { from: '', to: '' },
      labs: found.labs.map((l) => ({ ...l })), medicines: found.medicines.map((m) => ({ ...m })),
    };
    const kinds = found.kinds;
    const msg = el('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const body = el('div');

    const text = (label, key, opts = {}) => {
      const input = el(opts.rows ? 'textarea' : 'input', { type: opts.rows ? null : opts.type ?? 'text', rows: opts.rows, value: opts.rows ? null : s[key], maxlength: opts.max, required: opts.required });
      if (opts.rows) input.textContent = s[key];
      input.addEventListener('input', () => { s[key] = input.value; });
      return el('label', { class: 'field' }, el('span', null, label), input, opts.hint ? el('small', null, opts.hint) : null);
    };

    const typeSel = el('select', { name: 'kind' }, Object.entries(kinds).map(([k, label]) => el('option', { value: k, selected: k === s.kind }, label)));
    typeSel.addEventListener('change', () => { s.kind = typeSel.value; drawBody(); });

    // a result or medicine row: tick to keep, edit anything that was misread
    const labRow = (l) => {
      const inc = el('input', { type: 'checkbox', checked: l.include !== false, 'aria-label': `Keep ${l.name}` });
      inc.addEventListener('change', () => { l.include = inc.checked; });
      const val = el('input', { type: 'number', step: 'any', value: l.value, 'aria-label': `${l.name} result`, inputmode: 'decimal' });
      val.addEventListener('input', () => { l.value = val.value; });
      const unit = el('input', { type: 'text', value: l.unit ?? '', 'aria-label': `${l.name} unit`, maxlength: 20 });
      unit.addEventListener('input', () => { l.unit = unit.value; });
      const flag = l.flag ? `${{ H: 'High', L: 'Low', HH: 'Very high', LL: 'Very low' }[l.flag] ?? l.flag}${l.range ? `. The report gives ${l.range} as normal.` : ''}` : null;
      return el('li', { class: l.include === false ? 'scan-item doubt' : 'scan-item' },
        el('div', { class: 'scan-line' }, inc, el('span', { class: 'scan-name' }, l.name)),
        el('div', { class: 'scan-line sub' }, val, unit),
        flag ? el('p', { class: 'scan-note' }, flag) : null,
        ...(l.notes ?? []).map((n) => el('p', { class: 'scan-note' }, n)));
    };

    const medRow = (m) => {
      const inc = el('input', { type: 'checkbox', checked: m.include !== false, 'aria-label': `Keep ${m.name}` });
      inc.addEventListener('change', () => { m.include = inc.checked; });
      const name = el('input', { type: 'text', class: 'grow', value: m.name, 'aria-label': 'Medicine name', maxlength: 120 });
      name.addEventListener('input', () => { m.name = name.value; });
      const freq = el('input', { type: 'text', class: 'grow', value: m.frequency ?? '', 'aria-label': `How often for ${m.name}`, placeholder: 'How often', maxlength: 60 });
      freq.addEventListener('input', () => { m.frequency = freq.value; });
      const days = el('input', { type: 'number', min: 1, max: 365, value: m.days ?? '', 'aria-label': `Days for ${m.name}`, placeholder: 'Days', inputmode: 'numeric' });
      days.addEventListener('input', () => { m.days = days.value; });
      return el('li', { class: 'scan-item' },
        el('div', { class: 'scan-line' }, inc, name),
        el('div', { class: 'scan-line sub' }, freq, days),
        ...(m.checks ?? []).map((c) => el('p', { class: `scan-note${c.type === 'same-family' ? '' : ' alert'}` }, c.text)),
        ...(m.notes ?? []).map((n) => el('p', { class: 'scan-note' }, n)));
    };

    function drawBody() {
      const parts = [];
      if (s.kind === 'lab') {
        parts.push(el('h3', { class: 'section-title' }, `Results we read (${s.labs.length})`));
        parts.push(s.labs.length
          ? el('ul', { class: 'scan-list' }, s.labs.map(labRow))
          : el('p', { class: 'meta' }, 'No results could be read. The file will be saved as a document.'));
        if (s.labs.some((l) => l.include === false)) parts.push(small('Unticked lines look doubtful. Fix the number or unit, then tick them, or leave them out.'));
      } else if (s.kind === 'prescription') {
        parts.push(el('h3', { class: 'section-title' }, `Medicines we read (${s.medicines.length})`));
        parts.push(s.medicines.length
          ? el('ul', { class: 'scan-list' }, s.medicines.map(medRow))
          : el('p', { class: 'meta' }, 'No medicines could be read. The file will be saved as a document.'));
      } else if (s.kind === 'discharge') {
        const from = el('input', { type: 'date', value: s.stay.from ?? '' }); from.addEventListener('input', () => { s.stay.from = from.value; });
        const to = el('input', { type: 'date', value: s.stay.to ?? '' }); to.addEventListener('input', () => { s.stay.to = to.value; });
        parts.push(el('div', { class: 'row2' },
          el('label', { class: 'field' }, el('span', null, 'Admitted'), from),
          el('label', { class: 'field' }, el('span', null, 'Discharged'), to)));
        parts.push(text('Diagnosis or summary', 'detail', { rows: 3, max: 1500 }));
      } else if (s.kind === 'scan') {
        parts.push(text('Result in short', 'detail', { rows: 3, max: 1500, hint: 'For example the "Impression" line of the report.' }));
      } else {
        parts.push(text('Note (optional)', 'detail', { rows: 2, max: 300 }));
      }
      body.replaceChildren(...parts);
    }

    const save = el('button', { class: 'btn', type: 'button' }, 'Save to my records');
    const again = el('button', { class: 'btn quiet', type: 'button' }, 'Start over');
    again.addEventListener('click', () => pick());
    save.addEventListener('click', async () => {
      save.disabled = true;
      msg.replaceChildren();
      try {
        const labs = s.labs.map((l) => ({ code: l.code, name: l.name, value: l.value, unit: l.unit, flag: l.flag, include: l.include !== false }));
        const medicines = s.medicines.map((m) => ({ name: m.name, dose: m.dose, frequency: m.frequency, days: m.days || null, include: m.include !== false }));
        await api('/api/me/scan/save', { method: 'POST', body: { file, review: { kind: s.kind, title: s.title, date: s.date, source: s.source, detail: s.detail, stay: s.stay, labs, medicines, method: found.method } } });
        onSaved();
      } catch (e) {
        save.disabled = false;
        msg.replaceChildren(note(e.message, true));
        msg.scrollIntoView({ block: 'nearest' });
      }
    });

    const how = found.method === 'pdf-text' ? 'Read from the text inside the PDF.' : `Read from the picture${found.confidence != null ? ` (${found.confidence}% sure)` : ''}.`;
    draw(
      el('h3', null, 'Here is what we found'),
      el('p', { class: 'meta' }, `${how} Reading can make mistakes, so check each line against your paper. Nothing is saved until you press Save.`),
      ...found.warnings.map((w) => note(w, true)),
      el('label', { class: 'field' }, el('span', null, 'What is this?'), typeSel),
      text('Name', 'title', { max: 120, required: true }),
      el('div', { class: 'row2' },
        text('Date', 'date', { type: 'date', hint: s.date ? fmtDate(s.date) : 'Not found. Add the date on the paper.' }),
        text('From', 'source', { max: 120, hint: 'Lab, clinic or hospital' })),
      body,
      found.text ? el('details', null, el('summary', null, 'The text we read from your file'), el('pre', { class: 'scan-text' }, found.text)) : null,
      msg,
      el('div', { class: 'actions' }, save, again));
    drawBody();
  }

  pick();
  return root;
}
