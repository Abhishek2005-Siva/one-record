// Loads parsed FHIR bundles (see src/fhir.js) into SQLite.
//
// The whole parsed event is kept in `records.data`, so the API can hand the timeline
// back in the same shape parseBundle produced. A few columns are copied out for querying.
//
// Two things are added that Synthea does not provide, both for the demo only:
//   - a blood group per patient, picked from a hash of the patient id
//   - lab flags (high/low) from a small hand-written range table when the bundle has none
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db, q, tx } from './db.js';
import { parseBundle } from '../src/fhir.js';
import { localBlood, LABS } from './catalog.js';
import { ingredientsOf, tidyDrugName, flagFor } from './meds.js';

const shortLab = (t) => (t ?? '').split(/ \[| in | by | - /)[0].replace(/\s2000\b/, '').trim();

function collapseMedicines(events) {
  const groups = new Map();
  const rest = [];
  for (const e of events) {
    if (e.kind !== 'medicine') { rest.push(e); continue; }
    const name = tidyDrugName(e.title);
    const k = name.toLowerCase();
    const g = groups.get(k) ?? { ...e, title: name, times: 0, since: e.date, active: false };
    g.times++;
    if (e.date && (!g.date || e.date > g.date)) { g.date = e.date; g.place = e.place; g.clinician = e.clinician; g.detail = e.detail; }
    if (e.date && (!g.since || e.date < g.since)) g.since = e.date;
    if (e.status === 'active') g.active = true;
    groups.set(k, g);
  }
  const meds = [...groups.values()].map((g) => ({
    ...g, id: `med-${g.id}`, status: g.active ? 'active' : 'stopped',
    detail: g.times > 1 ? `Prescribed ${g.times} times since ${g.since}` : g.detail,
    dose: g.detail, ingredients: ingredientsOf(g.title),
  }));
  return [...rest, ...meds];
}

export function importBundle(bundle) {
  const { patient, events, allergies, conditions } = parseBundle(bundle);
  if (patient.deceased) return null;

  const evs = collapseMedicines(events).map((e) => {
    if (e.kind === 'lab') {
      e.title = LABS[e.loinc]?.name ?? shortLab(e.title);
      e.results = e.results.map((r) => ({ ...r, name: LABS[r.loinc]?.name ?? shortLab(r.name), flag: r.flag ?? flagFor(r.loinc, r.value) }));
    }
    return e;
  });

  tx(() => {
    db.prepare('INSERT OR REPLACE INTO patients (id, name, sex, dob, blood_group, city) VALUES (?, ?, ?, ?, ?, NULL)').run(
      patient.id, patient.name, patient.gender, patient.birthDate, localBlood(patient.id),
    );
    for (const e of evs) {
      q.insertRecord({
        id: randomUUID(), patient_id: patient.id, kind: e.kind, date: e.date, title: e.title,
        detail: e.detail, source: e.place, source_kind: 'imported', data: e,
      });
    }
    for (const a of allergies.filter((x) => x.status === 'active' || !x.status)) {
      q.insertRecord({
        id: randomUUID(), patient_id: patient.id, kind: 'allergy', date: a.since, title: a.substance ?? 'Allergy',
        detail: a.reaction, source_kind: 'imported', data: { reaction: a.reaction, criticality: a.criticality },
      });
    }
    for (const c of conditions) {
      q.insertRecord({
        id: randomUUID(), patient_id: patient.id, kind: 'condition', date: c.since, title: c.name ?? 'Condition',
        source_kind: 'imported', data: { active: c.active },
      });
    }
  });
  return { id: patient.id, name: patient.name, events: evs.length };
}

export function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM patients').get().n > 0) return [];
  const dir = new URL('../data/bundles/', import.meta.url);
  const done = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const r = importBundle(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
    if (r) done.push(r);
  }
  return done;
}
