// Turns a FHIR R4 bundle (Synthea output or a $everything export) into the small
// internal model the rest of the app uses. Nothing here invents data: if a bundle
// doesn't say something, the field stays null.

const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

const clean = (s) => (s ? s.replace(/\s*\((disorder|finding|procedure|situation|morphologic abnormality|person|environment|substance|medication|qualifier value|organism|product|medicinal product|observable entity|regime\/therapy|body structure|physical object|event|attribute)\)\s*$/i, '').trim() : s);

const conceptText = (cc) => clean(cc?.text || cc?.coding?.find((c) => c.display)?.display || null);

// Synthea appends digits to every name ("Uribe503"), and writes facility names in capitals.
const tidyName = (s) => (s ? s.replace(/(?<=\p{L})\d+/gu, '').replace(/\s+/g, ' ').trim() : s);
const tidyPlace = (s) =>
  s && s === s.toUpperCase()
    ? s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).replace(/\b(Llc|Md|Pc|Ent)\b/g, (w) => w.toUpperCase())
    : s;

const codeOf = (cc, system) => cc?.coding?.find((c) => !system || c.system?.includes(system)) ?? null;

export function parseBundle(bundle) {
  // A record marked "entered in error" was withdrawn by whoever wrote it. Showing it would be worse than a gap.
  const withdrawn = (r) => r.status === 'entered-in-error' || r.verificationStatus?.coding?.some((c) => c.code === 'entered-in-error');
  const entries = (bundle.entry ?? []).filter((e) => e.resource && !withdrawn(e.resource));

  // References come as "Type/id" or, in transaction bundles, "urn:uuid:...".
  const byRef = new Map();
  for (const { fullUrl, resource: r } of entries) {
    if (fullUrl) byRef.set(fullUrl, r);
    if (r.id) byRef.set(`${r.resourceType}/${r.id}`, r);
  }
  const deref = (ref) => (ref?.reference ? byRef.get(ref.reference) ?? null : null);

  const ofType = (t) => entries.map((e) => e.resource).filter((r) => r.resourceType === t);

  const patientRes = ofType('Patient')[0];
  if (!patientRes) throw new Error('Bundle has no Patient resource');

  const orgName = (ref) => tidyPlace(deref(ref)?.name ?? ref?.display ?? null);
  const doctorName = (ref) => {
    const p = deref(ref);
    const n = p?.name?.[0];
    if (n) return tidyName([n.prefix?.[0], n.given?.join(' '), n.family].filter(Boolean).join(' '));
    return tidyName(ref?.display ?? null);
  };

  const encounters = new Map(ofType('Encounter').map((e) => [`Encounter/${e.id}`, e]));
  const encounterOf = (r) => {
    const ref = r.encounter?.reference;
    return ref ? deref(r.encounter) ?? encounters.get(ref) ?? null : null;
  };
  const placeOf = (r) => {
    const enc = encounterOf(r);
    return enc ? orgName(enc.serviceProvider) : null;
  };
  const clinicianOf = (r) => {
    if (r.requester) return doctorName(r.requester);
    const enc = encounterOf(r);
    return enc?.participant?.[0]?.individual ? doctorName(enc.participant[0].individual) : null;
  };

  const events = [];
  const add = (e) => events.push({ patientId: patientRes.id, detail: null, place: null, clinician: null, ...e });

  // Medicines handed out during an inpatient stay belong to that stay, not to the
  // patient's own medicine list. Without this a chemotherapy course buries the timeline.
  const medName = (m) => conceptText(m.medicationCodeableConcept ?? deref(m.medicationReference)?.code);
  const isInpatient = (m) =>
    (m.category ?? []).some((c) => c.coding?.some((x) => x.code === 'inpatient')) && encounterOf(m)?.class?.code === 'IMP';
  const givenInStay = new Map();
  for (const m of ofType('MedicationRequest')) {
    if (!isInpatient(m)) continue;
    const id = encounterOf(m).id;
    if (!givenInStay.has(id)) givenInStay.set(id, new Set());
    givenInStay.get(id).add(medName(m) ?? 'Medicine');
  }

  // ---- visits and hospital stays -------------------------------------------
  for (const enc of encounters.values()) {
    const reason = conceptText(enc.reasonCode?.[0]) ?? conceptText(enc.type?.[0]);
    const classCode = enc.class?.code;
    const start = day(enc.period?.start);
    const end = day(enc.period?.end);
    const base = {
      place: orgName(enc.serviceProvider),
      clinician: enc.participant?.[0]?.individual ? doctorName(enc.participant[0].individual) : null,
    };
    if (classCode === 'IMP') {
      add({
        ...base, id: `enc-${enc.id}`, kind: 'discharge', date: end ?? start,
        title: reason ? `Hospital stay: ${reason}` : 'Hospital stay',
        stay: { from: start, to: end, given: [...(givenInStay.get(enc.id) ?? [])] },
      });
    } else if (classCode === 'EMER') {
      add({ ...base, id: `enc-${enc.id}`, kind: 'visit', date: start, title: reason ? `Emergency visit: ${reason}` : 'Emergency visit' });
    } else {
      add({ ...base, id: `enc-${enc.id}`, kind: 'visit', date: start, title: reason ?? 'Visit' });
    }
  }

  // ---- lab results, grouped the way a lab report is ----------------------------
  const resultOf = (obs) => {
    const q = obs.valueQuantity;
    const value = q ? q.value : obs.valueCodeableConcept ? conceptText(obs.valueCodeableConcept) : obs.valueString ?? null;
    return {
      name: conceptText(obs.code),
      loinc: codeOf(obs.code, 'loinc')?.code ?? null,
      value: typeof value === 'number' ? Math.round(value * 100) / 100 : value,
      unit: q?.unit ?? null,
      flag: obs.interpretation?.[0]?.coding?.[0]?.code ?? null,
    };
  };
  const isLab = (cc) => (cc ?? []).some((c) => c.coding?.some((x) => x.code === 'laboratory' || x.code === 'LAB'));

  const usedObservations = new Set();
  for (const dr of ofType('DiagnosticReport')) {
    const radiology = (dr.category ?? []).some((c) => c.coding?.some((x) => ['RAD', 'IMG'].includes(x.code)));
    const lab = isLab(dr.category);
    if (!lab && !radiology) continue; // clinical notes etc. are not "reports" a patient carries around
    const date = day(dr.effectiveDateTime ?? dr.issued);
    const base = { id: `dr-${dr.id}`, date, place: placeOf(dr), clinician: clinicianOf(dr), title: conceptText(dr.code) ?? 'Report' };
    if (radiology) {
      add({ ...base, kind: 'scan' });
      continue;
    }
    const results = (dr.result ?? []).map((ref) => deref(ref)).filter(Boolean).map((o) => (usedObservations.add(o.id), resultOf(o)));
    add({ ...base, kind: 'lab', loinc: codeOf(dr.code, 'loinc')?.code ?? null, results });
  }
  for (const obs of ofType('Observation')) {
    if (!isLab(obs.category) || usedObservations.has(obs.id)) continue;
    const r = resultOf(obs);
    add({ id: `obs-${obs.id}`, kind: 'lab', date: day(obs.effectiveDateTime ?? obs.issued), place: placeOf(obs), title: r.name ?? 'Lab result', loinc: r.loinc, results: [r] });
  }

  // ---- scans ---------------------------------------------------------------------
  for (const img of ofType('ImagingStudy')) {
    const series = img.series?.[0];
    const title = conceptText(img.procedureCode?.[0]) ?? ([series?.modality?.display, series?.bodySite?.display].filter(Boolean).join(', ') || 'Scan');
    add({ id: `img-${img.id}`, kind: 'scan', date: day(img.started), place: placeOf(img), title });
  }

  // ---- medicines -------------------------------------------------------------------
  for (const m of [...ofType('MedicationRequest'), ...ofType('MedicationStatement')]) {
    if (m.resourceType === 'MedicationRequest' && isInpatient(m)) continue;
    const med = m.medicationCodeableConcept ?? deref(m.medicationReference)?.code;
    const rx = codeOf(med, 'rxnorm');
    const dosage = clean((m.dosageInstruction ?? m.dosage ?? [])[0]?.text ?? null);
    add({
      id: `med-${m.id}`, kind: 'medicine', date: day(m.authoredOn ?? m.dateAsserted ?? m.effectiveDateTime),
      title: conceptText(med) ?? 'Medicine', detail: dosage, place: placeOf(m), clinician: clinicianOf(m),
      status: m.status ?? null, rxnorm: rx?.code ?? null,
    });
  }

  // ---- vaccines --------------------------------------------------------------------
  for (const imm of ofType('Immunization')) {
    add({ id: `imm-${imm.id}`, kind: 'vaccine', date: day(imm.occurrenceDateTime), title: conceptText(imm.vaccineCode) ?? 'Vaccine', place: placeOf(imm) });
  }

  // ---- things the emergency summary will need -------------------------------------
  const allergies = ofType('AllergyIntolerance').map((a) => ({
    id: a.id,
    // Synthea's non-specific "Allergic disposition" says there is an allergy but not to what; say that plainly
    substance: /^allergic disposition/i.test(conceptText(a.code) ?? '') ? 'Allergy (substance not recorded)' : conceptText(a.code),
    type: a.type ?? null, // 'allergy' | 'intolerance'
    category: a.category?.[0] ?? null, // food | medication | environment | biologic
    reaction: a.reaction?.flatMap((x) => x.manifestation ?? []).map(conceptText).filter(Boolean).join(', ') || null,
    criticality: a.criticality ?? null,
    status: codeOf(a.clinicalStatus)?.code ?? null,
    since: day(a.recordedDate ?? a.onsetDateTime),
  }));
  const conditions = ofType('Condition')
    .map((c) => ({ id: c.id, name: conceptText(c.code), active: codeOf(c.clinicalStatus)?.code === 'active', since: day(c.onsetDateTime ?? c.recordedDate) }));

  const n = patientRes.name?.find((x) => x.use === 'official') ?? patientRes.name?.[0] ?? {};
  const patient = {
    id: patientRes.id,
    name: tidyName([n.given?.join(' '), n.family].filter(Boolean).join(' ')) || 'Unnamed patient',
    gender: patientRes.gender ?? null,
    birthDate: day(patientRes.birthDate),
    deceased: Boolean(patientRes.deceasedDateTime || patientRes.deceasedBoolean),
  };

  return { patient, events, allergies, conditions };
}
