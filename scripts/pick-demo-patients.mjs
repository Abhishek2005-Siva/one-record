// Copies a hand-picked set of Synthea patients into data/bundles/.
//
//   java -jar synthea-with-dependencies.jar -p 30 -s 2026 -cs 2026 -a 30-80 \
//     --exporter.fhir.export=true --exporter.years_of_history=5 \
//     --generate.only_alive_patients=true --exporter.baseDirectory=./synthea-out
//   node scripts/pick-demo-patients.mjs ./synthea-out/fhir
//
// Billing resources (Claim, ExplanationOfBenefit) are dropped: nothing here uses
// them and they are most of the file size. Clinical resources are copied untouched.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PICKS = ['Andy346', 'Hank686', 'Ilse197', 'Jesus702', 'Manuel446', 'Oliva247', 'Rosanna866', 'Terrell212'];
const DROP = new Set(['Claim', 'ExplanationOfBenefit']);

const [src] = process.argv.slice(2);
if (!src) {
  console.error('usage: node scripts/pick-demo-patients.mjs <synthea fhir output dir>');
  process.exit(1);
}

const out = fileURLToPath(new URL('../data/bundles/', import.meta.url)); // not .pathname: it %-encodes spaces
mkdirSync(out, { recursive: true });

for (const prefix of PICKS) {
  const file = readdirSync(src).find((f) => f.startsWith(`${prefix}_`));
  if (!file) {
    console.error(`no bundle starting with ${prefix}, skipping`);
    continue;
  }
  const bundle = JSON.parse(readFileSync(join(src, file), 'utf8'));
  const before = bundle.entry.length;
  bundle.entry = bundle.entry.filter((e) => !DROP.has(e.resource?.resourceType));
  const dest = file.replace(/[^\w.-]+/g, '_');
  writeFileSync(join(out, dest), JSON.stringify(bundle));
  console.log(`${dest}: kept ${bundle.entry.length} of ${before} resources`);
}
