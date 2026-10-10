import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingredientsOf, reconcile, checkNewMedicine, normaliseLab, flagFor } from '../server/meds.js';

const med = (title, over = {}) => ({
  id: title, kind: 'medicine', title, date: '2026-09-01', source: 'Clinic A', source_kind: 'imported',
  data: { status: 'active', ...over.data }, ...over,
});

test('Indian brands resolve to their ingredients', () => {
  assert.deepEqual(ingredientsOf('Dolo 650'), ['paracetamol']);
  assert.deepEqual(ingredientsOf('Crocin Advance'), ['paracetamol']);
  assert.deepEqual(ingredientsOf('Augmentin 625'), ['amoxicillin', 'clavulanic acid']);
});

test('Synthea-style titles: brackets, prefixes and combinations', () => {
  assert.deepEqual(ingredientsOf('Acetaminophen 325 MG Oral Tablet [Tylenol]'), ['paracetamol']);
  assert.deepEqual(ingredientsOf('Acetaminophen 325 mg / Oxycodone Hydrochloride 10 mg Oral Tablet [Percocet]'), ['oxycodone', 'paracetamol']);
  assert.deepEqual(ingredientsOf('Abuse-Deterrent 12 HR Oxycodone Hydrochloride 10 mg Extended Release Oral Tablet'), ['oxycodone']);
  assert.deepEqual(ingredientsOf('NDA020800 0.3 ML Epinephrine 1 MG/ML Auto-Injector'), ['adrenaline']);
});

test('the same ingredient from two brands is flagged, one brand is not', () => {
  const two = reconcile([med('Crocin 500'), med('Dolo 650', { source: 'Clinic B' })]);
  assert.equal(two.active.length, 1);
  assert.equal(two.active[0].flag?.type, 'same-ingredient');

  const one = reconcile([med('Crocin 500'), med('Pantop 40')]);
  assert.equal(one.active.length, 2);
  assert.ok(one.active.every((g) => !g.flag));
});

test('overlap through a combination product is caught (Tylenol + Percocet)', () => {
  const r = reconcile([med('Acetaminophen 325 MG Oral Tablet [Tylenol]'), med('Acetaminophen 325 mg / Oxycodone 10 mg Oral Tablet [Percocet]')]);
  assert.equal(r.active.length, 1);
  assert.equal(r.active[0].flag.type, 'same-ingredient');
});

test('stopped or ended medicines do not count as active', () => {
  const r = reconcile([med('Crocin 500', { data: { status: 'stopped' } }), med('Dolo 650', { data: { status: 'active', endDate: '2020-01-01' } })], '2026-10-10');
  assert.equal(r.active.length, 0);
  assert.equal(r.past.length, 2);
});

test('same family, different ingredient gets the softer note', () => {
  const r = reconcile([med('Ibuprofen 200 MG'), med('Naproxen 500 MG')]);
  assert.ok(r.active.every((g) => g.flag?.type === 'same-family'));
});

test('new medicine: duplicate, family and allergy warnings', () => {
  const existing = [med('Crocin 500'), med('Ibuprofen 200 MG')];
  assert.ok(checkNewMedicine('Dolo 650', existing, [], '2026-10-10').some((w) => w.type === 'same-ingredient'));
  assert.ok(checkNewMedicine('Naproxen 250', existing, [], '2026-10-10').some((w) => w.type === 'same-family'));
  assert.ok(checkNewMedicine('Augmentin 625', [], [{ title: 'Penicillin' }], '2026-10-10').some((w) => w.type === 'allergy'));
  assert.deepEqual(checkNewMedicine('Pantop 40', existing, [], '2026-10-10'), []);
});

test('lab units convert to the canonical unit, unknown units are reported', () => {
  const g = normaliseLab('2339-0', 5.5, 'mmol/L');
  assert.equal(g.unit, 'mg/dL');
  assert.ok(g.converted && Math.abs(g.value - 99.09) < 0.1);
  assert.equal(normaliseLab('2339-0', 90, 'mg/dL').converted, false);
  assert.ok(normaliseLab('2339-0', 5, 'bananas').unknownUnit);
});

test('lab flags use H / L codes', () => {
  assert.equal(flagFor('2339-0', 250), 'H');
  assert.equal(flagFor('2339-0', 40), 'L');
  assert.equal(flagFor('2339-0', 90), null);
  assert.equal(flagFor('nope', 5), null);
});
