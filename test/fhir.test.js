import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBundle } from '../src/fhir.js';

const u = (id) => `urn:uuid:${id}`;
const entry = (id, resource) => ({ fullUrl: u(id), resource: { id, ...resource } });
const ref = (id) => ({ reference: u(id) });

// one small patient that hits every branch of the parser
function fixture() {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      entry('pat', { resourceType: 'Patient', name: [{ use: 'official', given: ['Ana1'], family: 'Rao22' }], gender: 'female', birthDate: '1980-02-03' }),
      entry('org', { resourceType: 'Organization', name: 'CAMBRIDGE PUBLIC HEALTH COMMISSION' }),
      entry('org2', { resourceType: 'Organization', name: 'WHITLEY WELLNESS LLC' }),
      entry('doc', { resourceType: 'Practitioner', name: [{ prefix: ['Dr.'], given: ['Elmer371'], family: 'Gusikowski974' }] }),

      entry('visit', { resourceType: 'Encounter', class: { code: 'AMB' }, type: [{ text: 'Encounter for symptom' }], reasonCode: [{ coding: [{ display: 'Viral sinusitis (disorder)' }] }], period: { start: '2026-03-12T09:00:00+05:30' }, serviceProvider: ref('org'), participant: [{ individual: ref('doc') }] }),
      entry('stay', { resourceType: 'Encounter', class: { code: 'IMP' }, reasonCode: [{ coding: [{ display: 'Pneumonia (disorder)' }] }], period: { start: '2026-01-02T08:00:00+05:30', end: '2026-01-09T11:00:00+05:30' }, serviceProvider: ref('org') }),

      entry('medA', { resourceType: 'Medication', code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1', display: 'Ceftriaxone 1 GM Injection' }] } }),
      entry('rxStay', { resourceType: 'MedicationRequest', status: 'completed', category: [{ coding: [{ code: 'inpatient' }] }], medicationReference: ref('medA'), encounter: ref('stay'), authoredOn: '2026-01-02T08:30:00+05:30' }),
      entry('rxHome', { resourceType: 'MedicationRequest', status: 'active', medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '2', display: 'Paracetamol 500 MG Oral Tablet' }] }, dosageInstruction: [{ text: 'One tablet twice a day (qualifier value)' }], encounter: ref('visit'), authoredOn: '2026-03-12T09:30:00+05:30' }),
      entry('rxBad', { resourceType: 'MedicationRequest', status: 'entered-in-error', medicationCodeableConcept: { text: 'Warfarin 5 MG' }, authoredOn: '2026-03-12' }),

      entry('o1', { resourceType: 'Observation', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }] }, valueQuantity: { value: 6.23456, unit: '%' }, effectiveDateTime: '2026-02-01T10:00:00+05:30', interpretation: [{ coding: [{ code: 'H' }] }] }),
      entry('o2', { resourceType: 'Observation', category: [{ coding: [{ code: 'laboratory' }] }], code: { text: 'Glucose' }, valueQuantity: { value: 99, unit: 'mg/dL' }, effectiveDateTime: '2026-02-01T10:00:00+05:30' }),
      entry('o3', { resourceType: 'Observation', category: [{ coding: [{ code: 'laboratory' }] }], code: { text: 'Ferritin' }, valueQuantity: { value: 40, unit: 'ng/mL' } }), // no date, not in a panel
      entry('o4', { resourceType: 'Observation', category: [{ coding: [{ code: 'vital-signs' }] }], code: { text: 'Heart rate' }, valueQuantity: { value: 70, unit: '/min' }, effectiveDateTime: '2026-02-01' }),
      entry('panel', { resourceType: 'DiagnosticReport', category: [{ coding: [{ code: 'LAB' }] }], code: { text: 'Diabetes panel' }, effectiveDateTime: '2026-02-01T10:00:00+05:30', encounter: ref('visit'), result: [ref('o1'), ref('o2')] }),
      entry('note', { resourceType: 'DiagnosticReport', category: [{ coding: [{ code: '34117-2' }] }], code: { text: 'History and physical note' }, effectiveDateTime: '2026-03-12' }),

      entry('ct', { resourceType: 'ImagingStudy', started: '2026-01-04T12:00:00+05:30', procedureCode: [{ text: 'CT of chest without contrast (procedure)' }], encounter: ref('stay') }),
      entry('flu', { resourceType: 'Immunization', vaccineCode: { text: 'Influenza, seasonal' }, occurrenceDateTime: '2025-11-10T10:00:00+05:30' }),
      entry('al', { resourceType: 'AllergyIntolerance', code: { text: 'Penicillin' }, clinicalStatus: { coding: [{ code: 'active' }] }, criticality: 'high', reaction: [{ manifestation: [{ text: 'Rash' }, { text: 'Hives' }] }] }),
    ],
  };
}

const parsed = () => parseBundle(fixture());
const byId = (m, id) => m.events.find((e) => e.id === id);

test('patient name loses Synthea digits', () => {
  assert.equal(parsed().patient.name, 'Ana Rao');
  assert.equal(parsed().patient.birthDate, '1980-02-03');
});

test('visit gets plain reason, tidy facility and clinician, and the date as written (no timezone shift)', () => {
  const v = byId(parsed(), 'enc-visit');
  assert.equal(v.kind, 'visit');
  assert.equal(v.title, 'Viral sinusitis');
  assert.equal(v.date, '2026-03-12');
  assert.equal(v.place, 'Cambridge Public Health Commission');
  assert.equal(v.clinician, 'Dr. Elmer Gusikowski');
});

test('facility acronyms stay capitalised', () => {
  const m = parseBundle({ resourceType: 'Bundle', entry: [entry('p', { resourceType: 'Patient' }), entry('o', { resourceType: 'Organization', name: 'WHITLEY WELLNESS LLC' }), entry('e', { resourceType: 'Encounter', class: { code: 'AMB' }, period: { start: '2026-01-01' }, serviceProvider: ref('o') })] });
  assert.equal(m.events[0].place, 'Whitley Wellness LLC');
});

test('inpatient doses are folded into the hospital stay, not listed as the patient\'s medicines', () => {
  const m = parsed();
  const stay = byId(m, 'enc-stay');
  assert.equal(stay.kind, 'discharge');
  assert.equal(stay.date, '2026-01-09'); // dated by discharge
  assert.deepEqual(stay.stay, { from: '2026-01-02', to: '2026-01-09', given: ['Ceftriaxone 1 GM Injection'] });
  assert.equal(byId(m, 'med-rxStay'), undefined);
  assert.equal(byId(m, 'med-rxHome').title, 'Paracetamol 500 MG Oral Tablet');
  assert.equal(byId(m, 'med-rxHome').detail, 'One tablet twice a day');
  assert.equal(byId(m, 'med-rxHome').rxnorm, '2');
});

test('records marked entered-in-error never reach the timeline', () => {
  assert.equal(byId(parsed(), 'med-rxBad'), undefined);
});

test('a lab panel is one event with its results; those results are not repeated as separate events', () => {
  const m = parsed();
  const panel = byId(m, 'dr-panel');
  assert.equal(panel.kind, 'lab');
  assert.deepEqual(panel.results.map((r) => r.name), ['Hemoglobin A1c', 'Glucose']);
  assert.deepEqual(panel.results[0], { name: 'Hemoglobin A1c', loinc: '4548-4', value: 6.23, unit: '%', flag: 'H' });
  assert.equal(byId(m, 'obs-o1'), undefined);
  assert.equal(byId(m, 'obs-o2'), undefined);
});

test('a lab with no date is kept with date: null instead of being dropped or guessed', () => {
  const e = byId(parsed(), 'obs-o3');
  assert.equal(e.date, null);
  assert.equal(e.title, 'Ferritin');
});

test('vital signs and clinical notes are not timeline records', () => {
  const m = parsed();
  assert.equal(byId(m, 'obs-o4'), undefined);
  assert.equal(byId(m, 'dr-note'), undefined);
});

test('scans, vaccines and allergies', () => {
  const m = parsed();
  assert.equal(byId(m, 'img-ct').title, 'CT of chest without contrast');
  assert.equal(byId(m, 'img-ct').place, 'Cambridge Public Health Commission'); // via the stay
  assert.equal(byId(m, 'imm-flu').kind, 'vaccine');
  assert.deepEqual(m.allergies[0], { id: 'al', substance: 'Penicillin', type: null, category: null, reaction: 'Rash, Hives', criticality: 'high', status: 'active', since: null });
});

test('allergy wording: SNOMED tags stripped, the non-specific "allergic disposition" said plainly, type and category kept', () => {
  const bundle = fixture();
  bundle.entry.push(
    entry('al2', { resourceType: 'AllergyIntolerance', type: 'allergy', category: ['environment'], code: { text: 'Allergic disposition (finding)' } }),
    entry('al3', { resourceType: 'AllergyIntolerance', type: 'allergy', category: ['environment'], code: { text: 'Mold (organism)' } }),
    entry('al4', { resourceType: 'AllergyIntolerance', type: 'intolerance', category: ['medication'], code: { text: 'Lisinopril' }, reaction: [{ manifestation: [{ text: 'Cough (finding)' }] }] }),
  );
  const a = Object.fromEntries(parseBundle(bundle).allergies.map((x) => [x.id, x]));
  assert.equal(a.al2.substance, 'Allergy (substance not recorded)');
  assert.equal(a.al3.substance, 'Mold');
  assert.deepEqual([a.al4.substance, a.al4.type, a.al4.category, a.al4.reaction], ['Lisinopril', 'intolerance', 'medication', 'Cough']);
});

test('a bundle with no patient is rejected loudly', () => {
  assert.throws(() => parseBundle({ resourceType: 'Bundle', entry: [] }), /no Patient/);
});

test('an empty patient parses to an empty timeline', () => {
  const m = parseBundle({ resourceType: 'Bundle', entry: [entry('p', { resourceType: 'Patient' })] });
  assert.deepEqual(m.events, []);
  assert.equal(m.patient.name, 'Unnamed patient');
});

test('every shipped demo bundle parses into clean events', () => {
  const dir = fileURLToPath(new URL('../data/bundles/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no demo bundles found');
  const kinds = new Set(['visit', 'discharge', 'lab', 'scan', 'medicine', 'vaccine']);
  for (const f of files) {
    const m = parseBundle(JSON.parse(readFileSync(dir + f, 'utf8')));
    assert.ok(m.events.length > 0, `${f}: no events`);
    const ids = new Set();
    for (const e of m.events) {
      assert.ok(kinds.has(e.kind), `${f}: odd kind ${e.kind}`);
      assert.ok(e.title, `${f}: ${e.id} has no title`);
      assert.ok(e.date === null || /^\d{4}-\d{2}-\d{2}$/.test(e.date), `${f}: ${e.id} bad date ${e.date}`);
      assert.ok(!ids.has(e.id), `${f}: duplicate id ${e.id}`);
      ids.add(e.id);
      assert.ok(!/\d{3}\b/.test(e.clinician ?? ''), `${f}: Synthea digits left in ${e.clinician}`);
    }
  }
});
