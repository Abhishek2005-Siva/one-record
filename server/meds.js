import { BRANDS, INGREDIENTS, FAMILIES, ALLERGY_CROSS, LABS } from './catalog.js';

const words = (s) => s.toLowerCase().replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter(Boolean);

const NOISE = /^([\d.]+|hr|mg|ml|mcg|g|actuat|abuse-deterrent|extended|release|oral|nda\d+)$/;
const FORMS = /^(oral|tablet|capsule|injection|injectable|solution|cream|gel|spray|patch|syringe|prefilled|topical|ophthalmic|mucosal|transdermal|auto-injector|drug|implant|pack|suspension|inhaler|extended|release|day)$/;
const SALTS = new Set(['hydrochloride', 'sodium', 'bitartrate', 'acetate', 'sulfate', 'succinate', 'hyclate', 'hydrobromide', 'potassium', 'maleate', 'tartrate', 'citrate', 'phosphate', 'propionate']);

/**
 * "Dolo 650", "Crocin Advance", "Acetaminophen 325 MG Oral Tablet",
 * "Abuse-Deterrent 12 HR Oxycodone Hydrochloride 10 MG Extended Release Oral Tablet [Oxycontin]",
 * "Acetaminophen 325 MG / Oxycodone Hydrochloride 10 MG Oral Tablet [Percocet]"
 *   -> sorted list of canonical ingredients
 */
export function ingredientsOf(name) {
  const found = new Set();
  const all = words(name);
  for (const w of all) if (BRANDS[w]) BRANDS[w].forEach((i) => found.add(i));
  if (found.size) return [...found].sort();

  const bare = name.replace(/\[[^\]]*\]/g, ' ');
  for (const part of bare.split(/\s\/\s/)) {
    const ws = words(part);
    let i = 0;
    while (i < ws.length && NOISE.test(ws[i])) i++;
    const picked = [];
    for (; i < ws.length; i++) {
      const w = ws[i];
      if (/^[\d.]/.test(w) || FORMS.test(w)) break;
      if (!SALTS.has(w)) picked.push(w);
    }
    if (!picked.length) continue;
    const lead = INGREDIENTS[picked[0]];
    found.add(lead ?? picked.join(' '));
  }
  return [...found].sort();
}

const upper = (t) => t[0].toUpperCase() + t.slice(1);

export const familyOf = (ing) => Object.entries(FAMILIES).find(([, list]) => list.includes(ing))?.[0] ?? null;

export const tidyDrugName = (s) =>
  s.replace(/\b(\d+(?:\.\d+)?)\s*(MG|ML|MCG|G)\b/g, (_, n, u) => `${n} ${u.toLowerCase()}`).replace(/\s+/g, ' ').trim();

function isActive(rec, today) {
  if (rec.data.status && rec.data.status !== 'active') return false;
  if (rec.data.endDate && rec.data.endDate < today) return false;
  return true;
}

/**
 * Merge every medicine record into one picture:
 *  - active vs. past
 *  - same ingredient listed more than once (different brand or different place) is flagged
 *  - different ingredients from one family (two painkillers of the NSAID kind) get a softer note
 */
export function reconcile(records, today = new Date().toISOString().slice(0, 10)) {
  const meds = records.filter((r) => r.kind === 'medicine');
  const active = [];
  const past = [];
  for (const m of meds) (isActive(m, today) ? active : past).push(m);
  for (const m of active) m._ing = m.data.ingredients ?? ingredientsOf(m.title);

  // Medicines that share any ingredient end up in one group (Tylenol + Percocet both contain paracetamol).
  const parent = active.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  active.forEach((m, i) => {
    for (const ing of m._ing) {
      if (owner.has(ing)) parent[find(i)] = find(owner.get(ing));
      else owner.set(ing, i);
    }
  });
  const groups = new Map();
  active.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });

  const items = [];
  for (const entries of groups.values()) {
    const ingredients = [...new Set(entries.flatMap((e) => e._ing))].sort();
    let flag = null;
    if (entries.length > 1) {
      const shared = ingredients.filter((ing) => entries.filter((e) => e._ing.includes(ing)).length > 1);
      const list = shared.length > 1 ? `${shared.slice(0, -1).join(', ')} and ${shared.at(-1)}` : shared[0];
      flag = {
        type: 'same-ingredient',
        text: `${upper(list)} appear${shared.length > 1 ? '' : 's'} in ${entries.length} active medicines. Check none is taken twice.`,
      };
    }
    items.push({ ingredient: ingredients.join(' + '), ingredients, entries: entries.map(slim), flag });
  }

  // softer note: different ingredients, same family
  const famMap = new Map();
  for (const it of items) {
    for (const fam of new Set(it.ingredients.map(familyOf).filter(Boolean))) famMap.set(fam, [...(famMap.get(fam) ?? []), it]);
  }
  for (const [fam, its] of famMap) {
    if (its.length > 1) {
      for (const it of its) {
        if (!it.flag) it.flag = { type: 'same-family', text: `More than one medicine for ${fam} is active. Worth a look.` };
      }
    }
  }

  items.sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || a.ingredient.localeCompare(b.ingredient));
  return { active: items, past: past.map(slim).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')) };
}

const slim = (r) => ({
  id: r.id, name: r.title, date: r.date, place: r.source,
  dose: r.data.dose ?? null, frequency: r.data.frequency ?? null,
  times: r.data.times ?? 1, since: r.data.since ?? r.date, byHospital: r.source_kind === 'hospital',
});

/** Warnings for a medicine about to be added. */
export function checkNewMedicine(name, existingRecords, allergies, today) {
  const warnings = [];
  const ings = ingredientsOf(name);
  const { active } = reconcile(existingRecords, today);

  for (const it of active) {
    const shared = it.ingredients.filter((i) => ings.includes(i));
    if (shared.length) {
      const e = it.entries[0];
      warnings.push({
        type: 'same-ingredient',
        text: `${shared.join(', ')} is already active as "${e.name}"${e.place ? ` (${e.place})` : ''}. Adding "${name}" would double it.`,
      });
    } else {
      for (const ing of ings) {
        const fam = familyOf(ing);
        if (fam && it.ingredients.some((x) => familyOf(x) === fam)) {
          warnings.push({ type: 'same-family', text: `Already on ${it.ingredient}, which is also for ${fam}.` });
        }
      }
    }
  }
  for (const a of allergies) {
    const label = a.title.toLowerCase();
    const hit = ings.find(
      (ing) => label.includes(ing) ||
        Object.entries(ALLERGY_CROSS).some(([k, list]) => label.includes(k) && list.includes(ing)),
    );
    if (hit) warnings.push({ type: 'allergy', text: `Recorded allergy "${a.title}" may apply to ${hit}.` });
  }
  return warnings;
}

/** Convert a typed lab value to the canonical unit for its code, when we know how. */
export function normaliseLab(code, value, unit) {
  const def = LABS[code];
  if (!def) return { value, unit, converted: false };
  const u = (unit ?? '').trim().toLowerCase();
  if (!u || u === def.unit.toLowerCase()) return { value, unit: def.unit, converted: false };
  const f = def.conv?.[u];
  if (f) return { value: Math.round(value * f * 100) / 100, unit: def.unit, converted: true, original: `${value} ${unit}` };
  return { value, unit, converted: false, unknownUnit: true };
}

export function flagFor(code, value) {
  const d = LABS[code];
  if (!d || typeof value !== 'number') return null;
  if (value < d.low) return 'L';
  if (value > d.high) return 'H';
  return null;
}
