// What the reader makes of text that OCR or a PDF produced. No OCR runs here, so these are fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, datesIn } from '../server/scan.js';

const LAB = `Metro Diagnostics Laboratory
NABL accredited | 14 Anna Salai, Chennai

Patient: Hank Wolff    Age/Sex: 58 / M
Sample collected: 14/09/2026    Report date: 15/09/2026

COMPLETE BLOOD COUNT & BIOCHEMISTRY
Test        Result    Unit      Reference range
Haemoglobin    11.2    g/dL     12.0 - 17.5
Fasting Blood Sugar   132   mg/dL   70 - 100
Total Cholesterol   5.6   mmol/L   < 5.2
Platelet Count   1.5   lakhs/cumm   1.5 - 4.5
Serum Creatinine   1.1   mg/dL   0.6 - 1.3
`;

test('a lab report is recognised, with provider, report date and converted units', () => {
  const r = interpret(LAB, { patientName: 'Hank Gayle Wolff' });
  assert.equal(r.kind, 'lab');
  assert.equal(r.source, 'Metro Diagnostics Laboratory');
  assert.equal(r.date, '2026-09-15', 'the report date wins over the collection date');
  assert.equal(r.labs.length, 5);
  const chol = r.labs.find((l) => l.code === '2093-3');
  assert.equal(chol.unit, 'mg/dL');
  assert.ok(Math.abs(chol.value - 216.55) < 0.1, 'mmol/L converted to mg/dL');
  assert.equal(chol.flag, 'H', 'flag comes from the range printed on the report');
  assert.equal(r.labs.find((l) => l.code === '777-3').value, 150, 'lakhs/cumm converted');
  assert.deepEqual(r.warnings, [], 'name matches the signed-in patient');
});

test('a report that names someone else raises a warning', () => {
  const r = interpret(LAB, { patientName: 'Jane Doe' });
  assert.ok(r.warnings.some((w) => /Hank Wolff/.test(w) && /Jane Doe/.test(w)));
});

test('values that look like misreads are left unticked, not saved silently', () => {
  const r = interpret('Metro Diagnostics Laboratory\nResults\nHaemoglobin   112   g/dL   12.0 - 17.5\nHbA1c  71  %  4.0 - 5.6\nGlucose 5.5 furlongs 70 - 100', {});
  const hb = r.labs.find((l) => l.code === '718-7');
  assert.equal(hb.include, false);
  assert.match(hb.notes.join(' '), /too high/);
  const odd = r.labs.find((l) => l.code === '2339-0');
  assert.equal(odd.include, false);
  assert.match(odd.notes.join(' '), /unit/);
});

test('unknown tests are kept only when they look like real result rows', () => {
  const r = interpret('City Diagnostics\nReference range\nVitamin B12   250   pg/mL   200 - 900\nPhone 98400 12345\nPage 2 of 3\nHaemoglobin 13 g/dL 12 - 17', {});
  assert.ok(r.labs.some((l) => l.name === 'Vitamin B12' && l.code === null));
  assert.ok(!r.labs.some((l) => /phone|page/i.test(l.name)));
});

test('a prescription: names, doses, 1-0-1 style frequency and course length', () => {
  const r = interpret(`Dr. S. Rao, MBBS MD
Apollo Clinic, Greams Road, Chennai
Date: 02 Oct 2026   Patient: Sample, 58 F
Rx
1. Tab Dolo 650 mg  1-0-1  for 5 days
2. Tab Glycomet 500 mg 1-0-1 after food x 2 weeks
3. Cap Omez 20 mg  OD before food for 1 month
Review after 2 weeks.`, {});
  assert.equal(r.kind, 'prescription');
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.source, 'Apollo Clinic');
  assert.equal(r.title, 'Prescription from Dr. S. Rao');
  assert.equal(r.medicines.length, 3);
  const [dolo, glyco, omez] = r.medicines;
  assert.equal(dolo.name, 'Dolo 650 mg');
  assert.equal(dolo.days, 5);
  assert.match(dolo.frequency, /Twice a day/);
  assert.equal(glyco.days, 14);
  assert.match(glyco.frequency, /after food/);
  assert.equal(omez.days, 30);
  assert.match(omez.frequency, /Once a day/);
});

test('a medicine we do not know is kept, with a note that it cannot be cross-checked', () => {
  const r = interpret('Dr. A. Mehta\nRx\n1. Tab Zyxolin 10 mg 1-0-0 for 5 days\n2. Tab Dolo 650 1-0-1 for 3 days\nDate: 01/10/2026', {});
  const z = r.medicines.find((m) => /Zyxolin/.test(m.name));
  assert.match(z.notes.join(' '), /not in our short list/);
});

test('a discharge summary gets its stay dates and diagnosis', () => {
  const r = interpret(`Sunrise Hospital
DISCHARGE SUMMARY
Date of admission: 01/09/2026
Date of discharge: 05/09/2026
Diagnosis: Acute appendicitis, appendectomy done
Discharge medications: Tab Dolo 650 mg 1-0-1 for 3 days`, {});
  assert.equal(r.kind, 'discharge');
  assert.deepEqual(r.stay, { from: '2026-09-01', to: '2026-09-05' });
  assert.equal(r.date, '2026-09-05');
  assert.match(r.detail, /appendicitis/);
});

test('imaging reports are typed by modality', () => {
  const r = interpret('City Imaging Centre\nX-RAY CHEST PA VIEW\nDate: 03/08/2026\nFindings: Lung fields are clear.\nImpression: No active lung disease.', {});
  assert.equal(r.kind, 'scan');
  assert.equal(r.title, 'Chest X-ray report');
  assert.match(r.detail, /No active lung disease/);
});

test('dates: day first, month names, two-digit years; birth dates and future dates are ignored', () => {
  assert.deepEqual(datesIn('Reported 14/09/2026'), ['2026-09-14']);
  assert.deepEqual(datesIn('on 5 Mar 2025'), ['2025-03-05']);
  assert.deepEqual(datesIn('March 5, 2025'), ['2025-03-05']);
  assert.deepEqual(datesIn('dated 02-10-26'), ['2026-10-02']);
  assert.deepEqual(datesIn('31/02/2026'), [], 'not a real day');
  assert.deepEqual(datesIn('01/01/2999'), [], 'in the future');
  const r = interpret('Metro Laboratory\nDOB: 12/03/1980\nResults\nHaemoglobin 13 g/dL 12 - 17\nTSH 2.1 mIU/L 0.4 - 4.0\nReport date: 15/09/2026', {});
  assert.equal(r.date, '2026-09-15');
});

test('no date found: says so instead of guessing', () => {
  const r = interpret('Metro Laboratory\nResults\nHaemoglobin 13 g/dL 12 - 17\nTSH 2.1 mIU/L 0.4 - 4.0', {});
  assert.equal(r.date, null);
  assert.ok(r.warnings.some((w) => /could not find a date/i.test(w)));
});

test('unreadable or empty text falls back to a plain document with an explanation', () => {
  const r = interpret('  \n ~ \n', {});
  assert.equal(r.kind, 'other');
  assert.equal(r.labs.length + r.medicines.length, 0);
  assert.ok(r.warnings.length);
});

test('ordinary prose is not mistaken for results or medicines', () => {
  const r = interpret('Dear patient,\nPlease bring this letter to your appointment on 12 Oct 2026 at 10 AM.\nRoom 204, Ward 3. Phone 044 2345 6789.', {});
  assert.equal(r.labs.length, 0);
  assert.equal(r.medicines.length, 0);
  assert.equal(r.kind, 'other');
});
