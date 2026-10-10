// Reads what OCR found in a patient's document and sorts it into something the app can store:
//   a lab report, a prescription, a discharge summary, a scan report, or "other".
//
// Nothing here is saved. The patient reviews the result first, because OCR gets digits wrong
// and a wrong lab value on a medical record is worse than a missing one. Anything the reader
// is unsure about comes back with `include: false` and a note saying why.
import { LABS, BRANDS, INGREDIENTS } from './catalog.js';
import { normaliseLab, flagFor, tidyDrugName } from './meds.js';

// ---------- small helpers -----------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);
const clean = (s) => s.replace(/[|_~]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const num = (s) => Number(String(s).replace(',', '.').replace(/\s/g, ''));

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ---------- dates --------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y, m, d) {
  if (y < 100) y += y <= Number(today().slice(2, 4)) + 1 ? 2000 : 1900;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== s) return null;
  if (s > today() || s < '1990-01-01') return null;
  return s;
}

/** Every plausible date in a line, as YYYY-MM-DD. Day comes first in numeric dates, as in India. */
export function datesIn(line) {
  const out = [];
  for (const m of line.matchAll(/\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/g)) out.push(iso(+m[1], +m[2], +m[3]));
  for (const m of line.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/g)) {
    let [d, mo] = [+m[1], +m[2]];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // written month-first
    out.push(iso(+m[3], mo, d));
  }
  for (const m of line.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4}|\d{2})\b/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) out.push(iso(+m[3], mo, +m[1]));
  }
  for (const m of line.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) out.push(iso(+m[3], mo, +m[2]));
  }
  return out.filter(Boolean);
}

function pickDate(lines, prefer) {
  const usable = lines.filter((l) => !/\b(dob|d\.o\.b|birth|born|age)\b/i.test(l));
  // a line can carry several labelled dates ("Collected: 14/09  Report date: 15/09"), so take the one right after the label
  for (const re of prefer) {
    for (const line of usable) {
      const m = re.exec(line);
      if (!m) continue;
      const after = datesIn(line.slice(m.index + m[0].length))[0];
      if (after) return after;
    }
  }
  for (const line of usable) {
    const d = datesIn(line)[0];
    if (d) return d;
  }
  return null;
}

// ---------- who issued it -------------------------------------------------------------

const PLACE = /\b(hospital|clinic|laborator(?:y|ies)|diagnostic|diagnostics|medical cent(?:re|er)|health ?care|pathology|nursing home|polyclinic|institute|imaging|radiology)\b/i;

function pickSource(lines) {
  const head = lines.slice(0, 14);
  const place = head.find((l) => PLACE.test(l) && l.length <= 90 && !/\b(patient|name|sample|collected|referred)\b/i.test(l));
  const raw = place ?? head.find((l) => /^dr\.?\s+[a-z]/i.test(l));
  if (!raw) return null;
  // "Apollo Clinic, Greams Road, Chennai" -> keep the name and drop the address
  const name = raw.split(/\s*[|,]\s*|\s{2,}/)[0].replace(/^[^A-Za-z]+|[\s.,;:-]+$/g, '');
  return name.length >= 3 ? titleCase(name).replace(/\bNabl\b/, 'NABL') : null;
}

const doctorOf = (lines) => {
  const l = lines.slice(0, 14).find((x) => /^\s*dr\.?\s+[a-z]/i.test(x));
  return l ? clean(l.split(/[,|]/)[0]).replace(/\s+(MBBS|MD|MS|DNB).*$/i, '') : null;
};

// ---------- lab results -----------------------------------------------------------------

const NAMES = {
  '2339-0': ['fasting blood sugar', 'fasting plasma glucose', 'fasting glucose', 'random blood sugar', 'postprandial blood sugar', 'blood sugar', 'blood glucose', 'plasma glucose', 'glucose', 'fbs', 'rbs'],
  '4548-4': ['hba1c', 'hb a1c', 'glycated hemoglobin', 'glycated haemoglobin', 'glycosylated hemoglobin', 'glycosylated haemoglobin', 'a1c'],
  '2093-3': ['total cholesterol', 'cholesterol total', 'serum cholesterol', 'cholesterol'],
  '2085-9': ['hdl cholesterol', 'hdl-cholesterol', 'hdl'],
  '18262-6': ['ldl cholesterol', 'ldl-cholesterol', 'ldl'],
  '2571-8': ['triglycerides', 'triglyceride'],
  '38483-4': ['serum creatinine', 'creatinine'],
  '6299-2': ['blood urea nitrogen', 'bun'],
  '33914-3': ['egfr', 'estimated gfr', 'gfr'],
  '718-7': ['haemoglobin', 'hemoglobin', 'hgb', 'hb'],
  '6690-2': ['total leucocyte count', 'total leukocyte count', 'white blood cell count', 'white blood cells', 'wbc count', 'wbc', 'tlc'],
  '789-8': ['red blood cell count', 'red blood cells', 'rbc count', 'rbc'],
  '777-3': ['platelet count', 'platelets', 'plt'],
  '4544-3': ['hematocrit', 'haematocrit', 'packed cell volume', 'pcv'],
  '2947-0': ['sodium', 'serum sodium'],
  '6298-4': ['potassium', 'serum potassium'],
  '2069-3': ['chloride', 'serum chloride'],
  '20565-8': ['bicarbonate', 'serum bicarbonate'],
  '49765-1': ['calcium', 'serum calcium'],
  '1742-6': ['sgpt', 'alanine aminotransferase', 'alanine transaminase', 'alt'],
  '6768-6': ['alkaline phosphatase', 'alp'],
  '2885-2': ['total protein', 'serum protein'],
  '11580-8': ['tsh', 'thyroid stimulating hormone'],
  '62292-8': ['vitamin d', '25-oh vitamin d', '25 hydroxy vitamin d'],
  '3084-1': ['uric acid', 'serum uric acid'],
};
const SYNONYMS = Object.entries(NAMES).flatMap(([code, list]) => list.map((name) => ({ code, name }))).sort((a, b) => b.name.length - a.name.length);

function labCode(rawName) {
  const n = rawName.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9\- ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  for (const s of SYNONYMS) {
    if (n === s.name) return s.code;
    if (s.name.length >= 5 && (n.startsWith(`${s.name} `) || n.endsWith(` ${s.name}`))) return s.code;
    // one misread letter in a long name ("Haemogiobin")
    if (s.name.length >= 8 && distance(n, s.name) === 1) return s.code;
  }
  return null;
}

// "mg/dl", "mg / dL", "mgidl", "mg/d1" -> mg/dl
function unitKey(raw) {
  if (!raw) return '';
  let u = raw.toLowerCase().replace(/\s+/g, '').replace(/[µμ]/g, 'u').replace(/[^a-z0-9%/^*.]/g, (c) => (c === '|' || c === '!' ? '/' : ''));
  u = u.replace(/^(mg|g|ng|pg|u|iu|miu|mmol|umol|mol)[i|!]([a-z0-9]+)$/, '$1/$2');
  u = u.replace(/^(mg|g)\/d[1i]$/, '$1/dl').replace(/^(mg|g)d[l1i]$/, '$1/dl');
  u = u.replace(/^mmol[1i]?l$/, 'mmol/l').replace(/^mmoll$/, 'mmol/l');
  return u;
}
// "mmol/l" -> "mmol/L" for anything shown to people
const prettyUnit = (k) => k.replace(/dl$/, 'dL').replace(/\/l$/, '/L').replace(/^miu/, 'mIU').replace(/^iu/, 'IU').replace(/^umol/, 'µmol').replace(/ul$/, 'uL');
const UNIT_LOOKS_REAL = /^(mg\/dl|g\/dl|g\/l|mmol\/l|umol\/l|miu\/l|iu\/l|u\/l|ng\/ml|pg\/ml|ng\/dl|meq\/l|%|fl|pg|\/cumm|cells\/cumm|\/ul|10\^[0-9]+\/ul|x10\^[0-9]+\/ul|10\*[0-9]+\/ul|lakhs?\/cumm|million\/cumm|mill\/cumm|thou\/ul|k\/ul|mm\/hr|mm\/h|ml\/min|sec|seconds)$/;

const NOT_A_TEST = /\b(age|date|phone|mobile|pin|page|sample|bill|invoice|room|bed|ward|time|year|years|reg|id|no)\b/i;

const ROW = /^\s*(?:\d{1,2}\s*[.)]\s+)?(?<name>[A-Za-z][A-Za-z0-9 ,()/\-.%+&']{1,50}?)\s+(?<value>[<>]?\s?\d{1,6}(?:[.,]\d{1,3})?)\s*(?<unit>[A-Za-zµμ%][A-Za-z0-9µμ%/^*.|!\-]{0,13}(?:\s?[/|]\s?[A-Za-z0-9µμ]{1,6})?)?(?<rest>.*)$/;

function rangeIn(rest) {
  const m = rest.match(/(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:[.,]\d+)?)/i);
  if (m) return { low: num(m[1]), high: num(m[2]), text: `${m[1]} - ${m[2]}` };
  const lt = rest.match(/(?:<|upto|up to|less than)\s*=?\s*(\d+(?:[.,]\d+)?)/i);
  if (lt) return { low: null, high: num(lt[1]), text: `< ${lt[1]}` };
  const gt = rest.match(/(?:>|more than)\s*=?\s*(\d+(?:[.,]\d+)?)/i);
  if (gt) return { low: num(gt[1]), high: null, text: `> ${gt[1]}` };
  return null;
}

function labRow(line) {
  const m = ROW.exec(line);
  if (!m) return null;
  const rawName = clean(m.groups.name);
  if (NOT_A_TEST.test(rawName) || rawName.length < 2) return null;
  const value = num(m.groups.value.replace(/[<>]/g, ''));
  if (!Number.isFinite(value)) return null;
  const range = rangeIn(m.groups.rest ?? '');
  const code = labCode(rawName);
  const unitRaw = m.groups.unit ? clean(m.groups.unit) : '';
  const unit = unitKey(unitRaw);
  const unitOk = UNIT_LOOKS_REAL.test(unit);

  if (!code) {
    // not a test we know: keep it only if it looks like a real result row (a unit and a reference range)
    if (!(unitOk && range)) return null;
    const flag = range.high != null && value > range.high ? 'H' : range.low != null && value < range.low ? 'L' : null;
    return { code: null, name: titleCase(rawName), value, unit: unitRaw, original: null, flag, range: range.text, include: true, notes: ['Not in our short list of tests, so it is saved as written.'] };
  }

  const def = LABS[code];
  const notes = [];
  let include = true;
  let out = { value, unit: def.unit, converted: false };
  if (!unit) {
    notes.push(`No unit was read, so ${def.unit} is assumed. Check it against your paper.`);
  } else {
    const n = normaliseLab(code, value, prettyUnit(unit));
    if (n.unknownUnit) {
      include = false;
      out = { value, unit: unitRaw, converted: false };
      notes.push(`Could not read the unit "${unitRaw}" for ${def.name}. Expected ${def.unit}. Fix it or leave this one out.`);
    } else out = n;
  }
  // OCR often drops or adds a digit or a decimal point. A value far outside what a person could have is probably a misread.
  if (def.high > 0 && out.value > def.high * 5) { include = false; notes.push('This looks too high to be right. Check the number against your paper.'); }
  if (def.low > 0 && out.value < def.low / 5) { include = false; notes.push('This looks too low to be right. Check the number against your paper.'); }
  const flag = range ? (range.high != null && value > range.high ? 'H' : range.low != null && value < range.low ? 'L' : null) : flagFor(code, out.value);
  if (out.converted) notes.push(`Written as ${out.original}, saved as ${out.value} ${out.unit}.`);
  return { code, name: def.name, value: out.value, unit: out.unit, original: out.converted ? out.original : null, flag, range: range?.text ?? null, include, notes };
}

// ---------- medicines ---------------------------------------------------------------------

const FORM = /^(?:tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|inj(?:ection)?|oint(?:ment)?|drops?|susp(?:ension)?|cream|gel|inhaler|sachet)\b\.?\s*/i;
const DOSE = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|ml|iu|%)(?![a-z])/i;
const DAYS = /(?:\bfor\b|\bx\b|×)\s*(\d{1,3})\s*(days?|d|weeks?|wks?|months?)\b/i;
const FREQ_CODE = /\b([0-3])\s*[-–—]\s*([0-3])\s*[-–—]\s*([0-3])(?:\s*[-–—]\s*([0-3]))?\b/;
const FREQ_WORD = /\b(od|bd|bid|tds|tid|qid|hs|sos|prn|once (?:a |per )?day|once daily|twice (?:a |per )?day|twice daily|thrice (?:a |per )?day|three times (?:a )?day|at night|at bedtime|in the morning)\b/i;

const WORD_FREQ = { od: 'Once a day', bd: 'Twice a day', bid: 'Twice a day', tds: 'Three times a day', tid: 'Three times a day', qid: 'Four times a day', hs: 'At bedtime', sos: 'Only when needed', prn: 'Only when needed' };

function frequencyOf(text) {
  const parts = [];
  const c = FREQ_CODE.exec(text);
  if (c) {
    const slots = [c[1], c[2], c[3], c[4]].filter((x) => x != null);
    const n = slots.reduce((a, b) => a + Number(b), 0);
    const names = slots.length === 3 ? ['morning', 'afternoon', 'night'] : ['morning', 'afternoon', 'evening', 'night'];
    const when = slots.map((x, i) => (Number(x) ? names[i] : null)).filter(Boolean);
    parts.push(n === 1 && when.length === 1 ? `Once a day, ${when[0]}` : `${n === 2 ? 'Twice' : n === 3 ? 'Three times' : `${n} times`} a day${when.length ? ` (${when.join(', ')})` : ''}`);
  } else {
    const w = FREQ_WORD.exec(text);
    if (w) parts.push(WORD_FREQ[w[1].toLowerCase()] ?? upperFirst(w[1].toLowerCase()));
  }
  const food = /\b(after|before|with)\s+(?:food|meals?)\b/i.exec(text);
  if (food) parts.push(`${food[1].toLowerCase()} food`);
  return parts.join(', ') || null;
}
const upperFirst = (s) => s[0].toUpperCase() + s.slice(1);

function recognised(word) { return Boolean(BRANDS[word] || INGREDIENTS[word]); }

function medRow(line) {
  const stripped = line.replace(/^\s*(?:\d{1,2}\s*[.)]\s*)/, '');
  const form = FORM.exec(stripped);
  const rest = form ? stripped.slice(form[0].length) : stripped;
  const tokens = rest.toLowerCase().replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter(Boolean);
  const known = tokens.some(recognised);
  if (!form && !known) return null;
  if (!form && (labRowLooksLikeTest(line) || /^(date|patient|review|follow|advice|signature|diagnosis|name)\b/i.test(stripped))) return null;

  const dose = DOSE.exec(rest);
  const head = rest.slice(0, dose ? dose.index : rest.length).replace(FREQ_CODE, '').replace(FREQ_WORD, '').split(/\b(?:for|after|before|with)\b/i)[0];
  let name = clean(head).replace(/[,;:.\-\s]+$/, '');
  if (!name) return null;
  name = name.replace(/\s+\d+$/, (m) => (known && tokens.some((t) => BRANDS[t]) ? m : '')); // "Dolo 650" keeps its number; "Pantoprazole 40" does not need it twice
  const title = tidyDrugName(`${titleCase(name)}${dose ? ` ${dose[1]} ${dose[2].toLowerCase()}` : ''}`);
  const d = DAYS.exec(rest);
  let days = null;
  if (d) {
    const n = Number(d[1]);
    const unit = d[2].toLowerCase();
    days = unit.startsWith('w') ? n * 7 : unit.startsWith('m') ? n * 30 : n;
    if (days < 1 || days > 365) days = null;
  }
  const notes = [];
  if (!known) notes.push('This medicine is not in our short list, so it could not be checked against your other medicines.');
  return { name: title, dose: dose ? `${dose[1]} ${dose[2].toLowerCase()}` : null, frequency: frequencyOf(rest), days, include: true, notes };
}

const labRowLooksLikeTest = (line) => {
  const m = ROW.exec(line);
  return Boolean(m && labCode(clean(m.groups.name)));
};

// ---------- kinds ---------------------------------------------------------------------------

const KIND_LABEL = { lab: 'Blood or lab test report', prescription: 'Prescription', discharge: 'Hospital discharge summary', scan: 'Scan or X-ray report', other: 'Other document' };

function modality(text) {
  const t = text.toLowerCase();
  const chest = /chest/.test(t);
  if (/x-?ray|radiograph/.test(t)) return chest ? 'Chest X-ray report' : 'X-ray report';
  if (/ultrasound|sonograph|\busg\b/.test(t)) return 'Ultrasound report';
  if (/\bmri\b/.test(t)) return 'MRI report';
  if (/\bct\b.{0,6}scan|computed tomography/.test(t)) return 'CT scan report';
  if (/mammogra/.test(t)) return 'Mammogram report';
  if (/echocardio|\b2d echo\b/.test(t)) return 'Echocardiogram report';
  if (/\becg\b|electrocardio/.test(t)) return 'ECG report';
  return 'Scan report';
}

/**
 * @param {string} rawText OCR or PDF text
 * @param {{patientName?:string}} [who] the signed-in patient, to catch a report that names someone else
 */
export function interpret(rawText, who = {}) {
  const text = String(rawText ?? '').replace(/\r/g, '');
  const lines = text.split('\n').map(clean).filter(Boolean);
  const warnings = [];
  if (lines.join('').length < 20) {
    return { kind: 'other', kindLabel: KIND_LABEL.other, title: 'Scanned document', date: null, source: null, labs: [], medicines: [], stay: null, detail: null, warnings: ['We could not read any text in this file. You can still save it as a document and fill in the details yourself.'] };
  }

  const labs = [];
  const seen = new Set();
  for (const l of lines) {
    const r = labRow(l);
    if (!r) continue;
    const key = `${r.code ?? r.name}|${r.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labs.push(r);
  }
  const medicines = lines.map(medRow).filter(Boolean);
  // a lab row can also look like a medicine ("Calcium 9.1 mg/dL"): when the page is a lab report, the lab reading wins
  const labNames = new Set(labs.map((l) => l.name.toLowerCase()));
  const meds = medicines.filter((m) => !labNames.has(m.name.toLowerCase().replace(/\s+\d.*$/, '')));

  const hit = (re) => (text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) ?? []).length;
  const score = {
    lab: Math.min(labs.length, 4) + (hit(/reference (?:range|value|interval)|\bresults?\b|pathology|laborator|diagnostic|biochem|haematolog|hematolog|investigation|specimen/i) ? 2 : 0),
    prescription: Math.min(meds.length, 4) * 1.5 + (/\brx\b|℞|prescription|\bsig\b/i.test(text) ? 2 : 0) + (FREQ_CODE.test(text) ? 1 : 0),
    discharge: Math.min(hit(/discharge summary|date of discharge|discharged on|date of admission|admitted on|hospital course|condition at discharge|discharge medications?/i), 3) * 2.5,
    scan: Math.min(hit(/x-?ray|radiograph|ultrasound|sonograph|\bmri\b|\bct\b.{0,6}scan|mammogra|echocardio|\becg\b|impression|findings|radiolog/i), 3) * 1.6,
  };
  // a discharge summary lists tests and medicines too; the heading decides
  const [kind, top] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const chosen = top >= 2 ? kind : 'other';

  let date = null;
  let stay = null;
  if (chosen === 'discharge') {
    const from = pickDate(lines.filter((l) => /admi(?:ssion|tted)/i.test(l)), [/./]);
    const to = pickDate(lines.filter((l) => /discharge/i.test(l) && !/summary\s*$/i.test(l)), [/date of discharge|discharged on/i, /./]);
    if (from || to) stay = { from: from ?? to, to: to ?? from };
    date = to ?? from ?? pickDate(lines, [/./]);
  } else if (chosen === 'lab') {
    date = pickDate(lines, [/report(?:ed)?\s*(?:date|on)|date of report|reported|printed|issued/i, /collect|sample|drawn|received/i, /\bdate\b|dated/i]);
  } else {
    date = pickDate(lines, [/\bdate\b|dated|visit|consult|report|issued/i]);
  }
  if (!date) warnings.push('We could not find a date on this. Add one so it sits in the right place on your timeline.');

  const source = pickSource(lines);
  const doctor = doctorOf(lines);
  let title;
  let detail = null;
  if (chosen === 'lab') {
    const heading = lines.slice(0, 14).find((l) => l === l.toUpperCase() && /[A-Z]{4}/.test(l) && l.length >= 8 && l.length <= 70 && !PLACE.test(l) && !labCode(l));
    title = heading ? upperFirst(heading.toLowerCase()).replace(/\bcbc\b/i, 'CBC').replace(/&amp;/g, '&') : 'Lab report';
  } else if (chosen === 'prescription') {
    title = doctor ? `Prescription from ${doctor}` : source ? `Prescription from ${source}` : 'Prescription';
  } else if (chosen === 'discharge') {
    title = 'Hospital discharge summary';
    const dx = lines.find((l) => /^(?:final |principal |primary )?diagnosis\b\s*[:\-]/i.test(l));
    if (dx) detail = clean(dx.replace(/^[^:\-]*[:\-]\s*/, '')).slice(0, 300) || null;
  } else if (chosen === 'scan') {
    title = modality(text);
    const imp = lines.findIndex((l) => /^impression\b/i.test(l));
    if (imp >= 0) detail = clean(`${lines[imp].replace(/^impression\s*[:\-]?\s*/i, '')} ${lines[imp + 1] ?? ''}`).slice(0, 300) || null;
  } else {
    const first = lines.find((l) => l.length >= 4 && l.length <= 70 && /[A-Za-z]{3}/.test(l));
    title = first ? titleCase(first) : 'Scanned document';
  }

  // wrong-person guard: a report that names someone else is probably in the wrong account
  const named = /\b(?:patient(?:'s)?(?: name)?|name of patient|pt\.? name|name)\s*[:\-]\s*(?:(?:mr|mrs|ms|miss|master|smt|shri)\.?\s+)?([A-Za-z][A-Za-z .'-]{2,40}?)(?=\s{2,}|\s+(?:age|sex|gender|dob|date|\d)|\s*[,|(]|$)/i.exec(text);
  if (named && who.patientName) {
    const theirs = named[1].toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const ours = who.patientName.toLowerCase().replace(/\d/g, '').split(/\s+/);
    if (theirs.length && !theirs.some((w) => ours.includes(w))) {
      warnings.push(`This report names "${clean(named[1])}", but you are signed in as ${who.patientName}. Make sure it is yours before saving.`);
    }
  }
  if (chosen === 'lab' && !labs.length) warnings.push('This looks like a lab report, but we could not read any results from it. You can save it as a document.');
  if (chosen === 'prescription' && !meds.length) warnings.push('This looks like a prescription, but we could not read any medicines from it. You can save it as a document.');

  return {
    kind: chosen,
    kindLabel: KIND_LABEL[chosen],
    title,
    date,
    source,
    labs: chosen === 'lab' || labs.length >= 2 ? labs : [],
    medicines: chosen === 'prescription' || (chosen !== 'lab' && meds.length >= 1 && chosen !== 'other') ? meds : [],
    stay,
    detail,
    warnings,
  };
}

export const KINDS = KIND_LABEL;
