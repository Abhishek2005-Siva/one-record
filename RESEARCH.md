# HealthTech: Medical Records Fragmentation. Research notes

## 1. What the brief actually asks for

Source: the hackathon doc (IIITDM Kancheepuram, 24h, remote).

> Prescriptions, lab reports, scans and discharge summaries sit in different places and formats. This causes **repeated diagnostic tests**, **medication errors**, and **broken continuity** when patients change providers or visit emergency rooms.

So there are three harms, and every feature should map to one of them:

| Harm | What we must show working |
|---|---|
| Repeated tests | Warn "this test was done N days ago at X" |
| Medication errors | One reconciled medicine list; flag duplicates/conflicts across sources |
| Broken continuity / ER | One-screen emergency summary a new hospital can open in seconds |

### Rules that shape the build
- Code must be written **during** the event (8:30 PM Fri to 8:30 PM Sat). Open-source libraries are allowed but must be **disclosed** in the README.
- **Mandatory public deployment.** No deployed link means a weak score on 10% plus risk on everything else.
- **Fake or non-functional demo = disqualification.** Every number on screen has to come from real data flowing through real code. Say plainly that the data is synthetic. Don't pretend it's real patients.
- Submission: GitHub repo + 2–5 min video embedded + README (problem, solution, setup). Team leader submits via the Google Form by 9:00 PM.
- Scoring: Technical 35, Innovation 20, Feasibility 20, Video 15, Deployment 10.
  Technical is the biggest and explicitly mentions **edge cases**, so duplicates, unit mismatches and expired consent are worth real effort.

> **Time check:** the folder was created at 16:21 today, which leaves roughly 4 hours before 8:30 PM. That affects scope, so see section 5.

## 2. Public data I found (and verified)

| Source | What it gives us | Status |
|---|---|---|
| [Synthea](https://github.com/synthetichealth/synthea) (Apache-2.0, 3.4k stars, pushed Aug 2026) | Generates realistic **synthetic** patients as FHIR R4 bundles: encounters, observations (labs), medications, conditions, allergies, immunizations, diagnostic reports | Verified. Runs locally: `./run_synthea -p 10 --exporter.fhir.export true`. Names and places are US, so we relabel them. |
| [SMART on FHIR public R4 server](https://r4.smarthealthit.org) | Live, no-auth FHIR API with Synthea patients | Verified today: **621 patients**. One sample patient returned 90 observations, 27 encounters, 12 immunizations, 5 diagnostic reports, 4 medication requests, 2 allergies. It's a shared server, so **snapshot a handful of bundles into the repo** instead of depending on it live during the demo. |
| [HAPI FHIR](https://github.com/hapifhir/hapi-fhir) (Apache-2.0) | Java FHIR library and server. Only needed if we want our own FHIR endpoint | Optional. Probably overkill for 24h. |
| [ABDM FHIR Implementation Guide](https://nrces.in/ndhm/fhir/r4/) (India, NRCeS) | Official Indian record categories: **Prescription, DiagnosticReport, DischargeSummary, OPConsult, Immunization, Wellness, HealthDocument** | Verified. Use these as our timeline categories. This is a spec, not a dataset. |
| A–Z Medicine Dataset of India (Kaggle, ~250k brands with salt composition, manufacturer) | Maps Indian brand names to generic salts, which powers duplicate-medicine detection | Found via search. **Not on GitHub and I haven't checked the license.** Check before using, and ship only a trimmed subset. |

### Things I checked that we should NOT rely on
- **RxNav drug-interaction API: [discontinued by NIH](https://blog.drugbank.com/nih-discontinues-their-drug-interaction-api/).** Don't build on it.
- **LOINC full tables:** need registration and are 200+ MB. Skip. Synthea observations already carry LOINC codes and units.
- **Real ABDM/ABHA integration:** needs sandbox onboarding. Not possible in 24h. We can say our records follow ABDM categories, but we must **not** claim ABDM integration.
- Synthea's own downloads page: I couldn't load it (certificate error), so I can't confirm the license on the pre-generated files. Generating our own with the Apache-2.0 tool avoids the question.

## 3. Features: keep vs. cut

### Keep (each one maps to a harm above)
1. **One timeline per patient.** Everything in date order, filterable by type (Visits, Labs, Medicines, Scans, Discharge). This is the core of the product.
2. **Bring records in.**
   - (a) Import a FHIR bundle or pull from a FHIR source. This is the reliable path.
   - (b) Upload a PDF or photo, stored as a "document" entry that the patient or hospital labels with a date and type. No OCR promises. If we add extraction, the user confirms every field.
3. **Current medicines, reconciled.** One list merged from all sources. Flag the **same salt under different brand names** (e.g. two paracetamol brands), which is a very real Indian-context error. This needs only the salt table, no interaction database.
4. **"Already tested" nudge.** Hospital picks a test and sees the last result, date and where it was done. This directly targets repeated diagnostics and is the strongest demo moment.
5. **Emergency summary.** Allergies, current medicines, chronic conditions, blood group, last 3 visits, on one printable screen.
6. **Consent-based sharing.** Patient generates a short code or QR with an expiry (e.g. 24h) and a scope. The hospital enters it and gets a read-only view. Patient can revoke.
7. **Access log.** Who opened the record and when. It's cheap to build and it is what makes the sharing credible.
8. **Hospital can add a record** to the patient's timeline, so the loop closes: records flow in, not just out.

### Cut (don't build)
- AI chatbot / "ask your records". Easy to demo, easy to get wrong, adds nothing to the three harms, and it's what every other team will do.
- Appointment booking, telemedicine, payments, insurance claims, pharmacy ordering. Different problem.
- Wearables / step counts / health scores. Not fragmentation.
- Blockchain. It adds complexity and no value here.
- Drug-interaction engine. No reliable free data source now. A tiny hand-written rule list is fine if time allows, labelled "demo rules, not medical advice".
- Analytics dashboards and charts everywhere. One lab trend sparkline is enough.
- Multi-language. Good for real life, but cut it for now. Mention it as a next step.
- Real login system. Use a simple demo sign-in with two roles (Patient / Hospital) and say so honestly.

### Edge cases worth building (this is where the 35% is)
- Same test reported in different units or names → normalise by LOINC code.
- Same medicine from two sources with different dates → merge, show both sources.
- Conflicting allergy entries → show all, never silently drop one.
- Expired or revoked share code → clear message, nothing leaks.
- Patient has zero records → a helpful empty state, not a blank page.
- Record with missing date → place in an "undated" group at the end.

## 4. Design: minimal, human-made, usable by patients and hospitals

Two audiences with different needs, **one codebase, two layouts**:

| | Patient | Hospital staff |
|---|---|---|
| Device | Mostly a phone, often low-end, often an older adult | Desktop in a busy ward or ER |
| Wants | "Where are my reports? Let me show the doctor" | "Who is this person, what are they allergic to, what's already been done?" |
| Screens | **3 only:** Timeline · Medicines · Share | **2 only:** Find patient (code entry) · Patient page |

### Principles
- **One main action per screen.** Patient home is the timeline plus a single "Share with a hospital" button. Hospital landing is a single code field.
- **Lists, not card grids.** Plain rows with thin dividers. No icon-in-circle cards, no stat-tile rows, no dashboards.
- **Plain words.** "Medicines", "Blood tests", "Hospital stay". Never "MedicationRequest" or "Observation".
- **Big, calm type.** 17–18px body, high contrast, 44px minimum tap targets. Readable by someone's grandmother.
- **One accent colour** (a muted teal or green) on a warm off-white. Nothing else is coloured, except red used sparingly for allergies and warnings, because there it carries meaning.
- **Look hand-made, not generated:**
  - No purple/blue gradients, glassmorphism, emoji as icons, or centered hero blocks.
  - Left-aligned text; a real serif or humanist font for headings paired with a system sans for body.
  - Dates written like people write them: "12 Mar 2025", not ISO strings.
  - Specific copy, e.g. "Last done 12 days ago at Apollo Greams Road. Repeat?" rather than "Seamlessly manage your health".
  - Sensible empty states and error messages written like a person would say them.
- **Print works.** The emergency summary should print cleanly on one A4 page. Hospitals still print.
- **Warnings should be calm but unmissable.** A single line above the content, not a modal.

### Hospital patient page (rough layout)
```
Name, age, blood group                     [Code expires in 23h]
ALLERGIES: Penicillin (rash) · Peanuts
-------------------------------------------------------------
Current medicines (3)          | Recent visits
 Metformin 500mg, twice daily  |  12 Mar  Apollo, Chest pain
 Amlodipine 5mg, once daily    |  02 Jan  Dr Rao, OP visit
 ...                           |  ...
-------------------------------------------------------------
Full timeline  [All] [Labs] [Medicines] [Scans] [Discharge]
```

## 5. Suggested build order (given about 4 hours)

1. Load 5–10 Synthea bundles → parse to a simple internal model (timeline events, medicines, labs, allergies).
2. Patient: timeline + medicines list (with the duplicate-salt flag).
3. Share code with expiry/revoke + access log.
4. Hospital: code entry → patient page + "already tested" nudge + emergency summary + add record.
5. Deploy early (before polishing) and record the demo video last, with ~30 min buffer before 9:00 PM.
6. README: problem, solution, setup, **list of libraries and data sources used**, and a plain statement that the data is synthetic.

If time runs short, drop in this order: add-record by hospital → document upload → duplicate-salt flag. Keep timeline, share code and the "already tested" nudge. Those are what sell the story.

## 6. Open questions for the team
- Which stack are you comfortable shipping fast in? (My default would be Next.js + SQLite/Postgres on Vercel or similar.)
- Do you want the India framing (ABDM categories, Indian brand/salt matching)? It's a stronger story for judges at an Indian institute, but it costs a bit more time.
