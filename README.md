# One Record

One timeline for a patient's scattered medical records, shared with a hospital only by the patient's say-so.

This is a hackathon project (HealthTech track). **Every person in it is synthetic.** There is no real patient data anywhere in the repository or the running app. See [Disclosures](#disclosures) for exactly what is real, what is generated and what is made up for the demo.

## The problem

Prescriptions, lab reports, scans and discharge summaries sit in different places and formats. That causes three harms:

| Harm | What One Record does about it |
|---|---|
| Repeated tests | A hospital types a test name and sees when and where the patient last had it, with the result and a small trend line |
| Medication errors | One merged medicine list. The same ingredient under two brand names is flagged, and a new prescription is checked against the current list and recorded allergies before it is saved |
| Broken continuity (ER, new provider) | A patient makes a short code. The hospital enters it and gets an emergency summary, or the full timeline if the patient chose that |

## What it does

**Patient (phone-first, three screens)**
- **Timeline**: visits, hospital stays, tests, scans, medicines, vaccines and documents in date order, grouped by year, with filters. Lab results expand in place. Records with no date are listed at the end, not dropped.
- **Medicines**: one list built from every source, split into "taking now" and "earlier". An ingredient that appears in more than one active medicine gets a single warning line above it.
- **Share**: make a six-character code, choose *emergency summary only* or *everything*, and choose 1 hour, 24 hours or 7 days. Stop sharing at any time. The same screen shows an access log.
- **Add something**: a document (PDF, PNG, JPG or WebP up to 3 MB, with a name, date and note) or an allergy. A document is stored as a labelled entry; nothing is read out of it (there is no OCR).

**Hospital (desktop-first, two screens)**
- **Open a record** by entering the patient's code. A wrong, expired or revoked code gets a plain message and no data. After 10 wrong codes in a minute from one address, further attempts are refused until the minute is up.
- **Patient page**: allergies, current medicines, active conditions and the last three visits. With an *everything* code it also shows the full timeline and the test search below.
- **Before you order a test**: search by test name or common alias (for example "cholesterol", "sugar", "kidney"). Results show the last date, place and value, how many times it is on file, and a trend line. A result from the last 30 days is marked "done recently". This needs an *everything* code.
- **Add to this record**: a prescription, a test result, a visit note, a discharge summary or an allergy. A prescription is checked first for the same ingredient already being taken, for another medicine of the same type, and for a recorded allergy. The hospital sees the warnings and must confirm to save anyway. Test results can be typed in a different unit (for example mmol/L); known units are converted and the result shows what was done.
- **Print**: the patient page has print styles that put the summary in two columns. Most records fit on one A4 page; a patient with many current medicines can need a second.

**What the access log shows.** It records when a hospital opened a record with a code (at most once per 10 minutes for the same hospital and code, so refreshing the page does not fill the log), and each thing that hospital then added. It does not record which screens were viewed.

**How a hospital's access is checked.** Opening a code returns a signed grant tied to that hospital and that code. Every later read or write must present it, and the server also re-checks the code each time. A grant for one code does not open another, and stopping a share or reaching its expiry cuts access on the next request.

## What it does not do

No chatbot, booking, payments, wearables or blockchain. No drug-interaction database (see below). No multi-language support. No real login. No upload screen for FHIR bundles: the sample bundles are loaded once, at first start. No OCR of uploaded documents. No ABDM integration.

## Run it

You need Node.js 22, version 22.13 or newer (`package.json` allows `22.x`).

```
npm install
npm start
```

Open http://localhost:3000. On first start the app creates `data/app.db` (git-ignored) and fills it from the FHIR bundles in `data/bundles/`. Delete `data/app.db*` to reset it. Node prints a warning that `node:sqlite` is experimental; that is expected.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `data/app.db` (`/tmp/one-record.db` when the `VERCEL` variable is set) | Where the SQLite file lives |
| `SESSION_SECRET` | random per process | Signs sign-in tokens and hospital grants. Set it in any real deployment. Without it, everyone is signed out whenever the process restarts, and two instances cannot accept each other's tokens |

Run the tests with `npm test`. They use Node's built-in test runner, start the real server on a throwaway database and drive it over HTTP.

### Docker

```
docker build -t one-record .
docker run -p 3000:3000 -e SESSION_SECRET=change-me -v onerecord-data:/app/data one-record
```

Anything written while the app runs (share codes, the access log, added records and uploaded files) lives in `/app/data`. Without a volume it is lost when the container is replaced, and the sample patients are loaded again on the next start.

### Vercel

The repository includes a Vercel setup (`api/index.js`, `vercel.json`, `.vercelignore`) that runs the same Express app as a serverless function. **It has not been deployed**, and `SESSION_SECRET` must be set in the project before it would work properly. Be aware of what that setup means for the data:

- The filesystem is read-only except `/tmp`, so the database lives in `/tmp`. Everything written while the app runs (share codes, the access log, added records, uploaded files) is lost when the instance restarts.
- Each instance builds its own database from `data/bundles/`. If a request lands on a different instance, a code the patient just made may not exist there. A patient-then-hospital walkthrough can therefore fail intermittently.

For a reliable demo, run it with `npm start` or Docker on one instance.

## How the data gets in

`data/bundles/` holds eight patients as FHIR R4 bundles. `src/fhir.js` turns a bundle into timeline events, allergies and conditions, and `server/import.js` stores them. The parser keeps what the bundle says and leaves a field empty when the bundle is silent; it does not fill gaps. It also:

- drops records marked "entered in error"
- puts medicines given during a hospital stay inside that stay, so a chemotherapy course does not bury the timeline
- groups lab results the way a lab report does
- tidies the digits Synthea adds to names, the capital letters in facility names and the clinical-code tags such as "(disorder)"
- reads the non-specific "allergic disposition" as "Allergy (substance not recorded)"

Conditions that Synthea files as social or administrative findings (employment, education, housing, social isolation, being a victim of violence, "medication review due" and similar) are left out of the conditions list a hospital sees, using a keyword list in `server/app.js`. Clinical entries, including substance dependence, are kept, and visits are not filtered.

## Disclosures

**Libraries.** The only runtime dependency is [Express](https://expressjs.com/) 4. Everything else is built into Node: `node:sqlite` for storage, `node:crypto` for codes and signed tokens, `node:test` for tests. The front end is plain HTML, CSS and JavaScript with no framework, no build step, no CDN and no web fonts (system fonts only).

**Patient data: Synthea.** The people are generated with [Synthea](https://github.com/synthetichealth/synthea) (Apache-2.0), using its prebuilt `synthea-with-dependencies.jar` (build d9d07a6, 18 Aug 2026), on 10 Oct 2026:

```
java -jar synthea-with-dependencies.jar -p 30 -s 2026 -cs 2026 -a 30-80 \
  --exporter.fhir.export=true --exporter.years_of_history=5 \
  --generate.only_alive_patients=true
node scripts/pick-demo-patients.mjs <synthea output>/fhir
```

Thirty patients were generated and eight were chosen by hand to cover different cases (allergies, hospital stays, many medicines, few records). The script drops billing resources (Claim, ExplanationOfBenefit) and copies the rest unchanged. Names, places and facilities are the ones Synthea generates for Massachusetts, so they are American. Dates run up to the day of generation. "Last done 12 months ago" is calculated against today's date, so the data ages unless it is regenerated.

**Made up for the demo.** These values do not come from any record:
- **Blood group** is picked from a fixed list using a hash of the patient's id. The app labels it "(demo value)".
- **High/low labels on test results** come from a short hand-written table of typical adult ranges in `server/catalog.js`, used when the bundle carries no flag. Real ranges differ by lab. The app says so.
- **The four hospitals in the sign-in list** are fictional names. Records inside a patient's timeline carry the Synthea facility names.

**Hand-written reference tables** (`server/catalog.js`). Brand name to ingredient (a few dozen brands, mostly sold in India, deliberately incomplete), ingredient families used for the softer "more than one medicine of this type" note, the allergy-to-ingredient relationships (four groups), and the lab table with unit conversions. These are for orientation in a demo. **This is not a drug-interaction database and not clinical decision support.** A missing warning does not mean a combination is safe.

**Sign-in is a demo picker.** You choose a sample patient or a hospital; there are no passwords and no identity checks. Sessions are signed, stateless tokens that expire after 12 hours (`server/auth.js`), so they only prove the browser got them from this server. A real deployment would need real identity, which this does not provide.

**ABDM.** Record types and wording were guided by the categories in India's ABDM FHIR implementation guide. There is no integration with ABDM, ABHA or any national system, and nothing here should be read as compliance with them.

## Layout

```
server/      app.js (the Express app), index.js (starts it), auth.js (signed tokens), db.js (SQLite),
             import.js, meds.js (medicine reconciliation), catalog.js (hand-written reference tables)
src/fhir.js  FHIR bundle -> timeline events, allergies, conditions
public/      the app: index.html, app.js (screens), views/ (timeline, medicines), styles.css, app.css
api/         Vercel entry point (not deployed)
data/bundles the eight synthetic patients
scripts/     picks demo patients out of a Synthea run
test/        parser, medicine and API tests
Dockerfile, vercel.json, .vercelignore, .dockerignore   packaging
```
