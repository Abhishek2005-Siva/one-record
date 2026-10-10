// Reference tables. Everything here is hand-written for this project and is
// deliberately small. It is for orientation in a demo, not clinical decision support.

// Typical adult ranges; real labs print their own. conv: other unit -> canonical unit.
export const LABS = {
  '2339-0': { name: 'Blood sugar (glucose)', unit: 'mg/dL', low: 70, high: 140, alias: 'sugar fasting random diabetes', conv: { 'mmol/l': 18.016 } },
  '4548-4': { name: 'HbA1c', unit: '%', low: 4, high: 5.6, alias: 'sugar diabetes 3 month', conv: { '%': 1 } },
  '2093-3': { name: 'Total cholesterol', unit: 'mg/dL', low: 0, high: 200, alias: 'lipid', conv: { 'mmol/l': 38.67 } },
  '2085-9': { name: 'HDL cholesterol', unit: 'mg/dL', low: 40, high: 100, alias: 'lipid good', conv: { 'mmol/l': 38.67 } },
  '18262-6': { name: 'LDL cholesterol', unit: 'mg/dL', low: 0, high: 100, alias: 'lipid bad', conv: { 'mmol/l': 38.67 } },
  '2571-8': { name: 'Triglycerides', unit: 'mg/dL', low: 0, high: 150, alias: 'lipid', conv: { 'mmol/l': 88.57 } },
  '38483-4': { name: 'Creatinine', unit: 'mg/dL', low: 0.6, high: 1.3, alias: 'kidney renal rft', conv: { 'umol/l': 1 / 88.4, 'µmol/l': 1 / 88.4 } },
  '6299-2': { name: 'Blood urea nitrogen', unit: 'mg/dL', low: 7, high: 20, alias: 'bun urea kidney renal rft' },
  '33914-3': { name: 'Kidney filtration rate (eGFR)', unit: 'mL/min', low: 60, high: 999, alias: 'egfr kidney renal rft' },
  '718-7': { name: 'Hemoglobin', unit: 'g/dL', low: 12, high: 17.5, alias: 'hb haemoglobin anaemia anemia cbc', conv: { 'g/l': 0.1 } },
  '6690-2': { name: 'White blood cells', unit: '10*3/uL', low: 4, high: 11, alias: 'wbc leukocytes tlc cbc', conv: { '/cumm': 0.001, 'cells/cumm': 0.001, '/ul': 0.001, '10^3/ul': 1, 'x10^3/ul': 1, 'thou/ul': 1, 'k/ul': 1, '10^9/l': 1 } },
  '789-8': { name: 'Red blood cells', unit: '10*6/uL', low: 4.2, high: 5.9, alias: 'rbc erythrocytes cbc', conv: { 'million/cumm': 1, 'mill/cumm': 1, '10^6/ul': 1, 'x10^6/ul': 1, 'm/ul': 1, '10^12/l': 1 } },
  '777-3': { name: 'Platelets', unit: '10*3/uL', low: 150, high: 450, alias: 'plt cbc', conv: { '/cumm': 0.001, 'cells/cumm': 0.001, 'lakh/cumm': 100, 'lakhs/cumm': 100, '/ul': 0.001, '10^3/ul': 1, 'x10^3/ul': 1, 'thou/ul': 1, 'k/ul': 1, '10^9/l': 1 } },
  '4544-3': { name: 'Hematocrit', unit: '%', low: 36, high: 52, alias: 'haematocrit pcv cbc' },
  '2947-0': { name: 'Sodium', unit: 'mmol/L', low: 135, high: 145, alias: 'electrolytes na' },
  '6298-4': { name: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.1, alias: 'electrolytes k' },
  '2069-3': { name: 'Chloride', unit: 'mmol/L', low: 98, high: 107, alias: 'electrolytes cl' },
  '20565-8': { name: 'Bicarbonate (CO2)', unit: 'mmol/L', low: 23, high: 29, alias: 'electrolytes' },
  '49765-1': { name: 'Calcium', unit: 'mg/dL', low: 8.5, high: 10.5, alias: 'ca' },
  '1742-6': { name: 'ALT (liver)', unit: 'U/L', low: 7, high: 56, alias: 'sgpt liver lft' },
  '6768-6': { name: 'ALP (liver)', unit: 'U/L', low: 44, high: 147, alias: 'alkaline phosphatase liver lft' },
  '2885-2': { name: 'Total protein', unit: 'g/dL', low: 6, high: 8.3, alias: 'serum protein' },
  '11580-8': { name: 'TSH (thyroid)', unit: 'mIU/L', low: 0.4, high: 4.0, alias: 'thyroid' },
  '62292-8': { name: 'Vitamin D', unit: 'ng/mL', low: 30, high: 100, alias: '25 hydroxy' },
  '3084-1': { name: 'Uric acid', unit: 'mg/dL', low: 3.5, high: 7.2, alias: 'gout' },
};

// Brand (as sold in India) -> ingredients. Illustrative and incomplete on purpose.
export const BRANDS = {
  crocin: ['paracetamol'], dolo: ['paracetamol'], calpol: ['paracetamol'],
  combiflam: ['ibuprofen', 'paracetamol'], brufen: ['ibuprofen'],
  voveran: ['diclofenac'], zerodol: ['aceclofenac'], naprosyn: ['naproxen'],
  glycomet: ['metformin'], janumet: ['sitagliptin', 'metformin'], amaryl: ['glimepiride'],
  amlokind: ['amlodipine'], amlong: ['amlodipine'], telma: ['telmisartan'], losar: ['losartan'],
  ecosprin: ['aspirin'], atorva: ['atorvastatin'], rosuvas: ['rosuvastatin'],
  pantop: ['pantoprazole'], omez: ['omeprazole'], 'pan-d': ['pantoprazole', 'domperidone'],
  azithral: ['azithromycin'], augmentin: ['amoxicillin', 'clavulanic acid'], mox: ['amoxicillin'],
  cetzine: ['cetirizine'], allegra: ['fexofenadine'], montair: ['montelukast'],
  thyronorm: ['levothyroxine'], eltroxin: ['levothyroxine'], zyloric: ['allopurinol'],
  lasix: ['furosemide'], shelcal: ['calcium'], neurobion: ['vitamin b12'],
  // brands common in the US, which is where the sample patients' records come from
  tylenol: ['paracetamol'], advil: ['ibuprofen'], motrin: ['ibuprofen'], aleve: ['naproxen'],
  percocet: ['paracetamol', 'oxycodone'], oxycontin: ['oxycodone'], vicodin: ['paracetamol', 'hydrocodone'], norco: ['paracetamol', 'hydrocodone'],
  zocor: ['simvastatin'], lipitor: ['atorvastatin'], crestor: ['rosuvastatin'], zyrtec: ['cetirizine'], claritin: ['loratadine'],
  benadryl: ['diphenhydramine'], prilosec: ['omeprazole'], nexium: ['esomeprazole'], zestril: ['lisinopril'], lopressor: ['metoprolol'],
  glucophage: ['metformin'], synthroid: ['levothyroxine'], zoloft: ['sertraline'], plavix: ['clopidogrel'], ventolin: ['salbutamol'],
  amoxil: ['amoxicillin'], zithromax: ['azithromycin'], coumadin: ['warfarin'],
};

// Generic names we recognise (value = canonical ingredient). Synthea misspells simvastatin.
export const INGREDIENTS = {
  paracetamol: 'paracetamol', acetaminophen: 'paracetamol',
  ibuprofen: 'ibuprofen', naproxen: 'naproxen', diclofenac: 'diclofenac', aceclofenac: 'aceclofenac', aspirin: 'aspirin',
  metformin: 'metformin', glimepiride: 'glimepiride', sitagliptin: 'sitagliptin',
  amlodipine: 'amlodipine', telmisartan: 'telmisartan', losartan: 'losartan', hydrochlorothiazide: 'hydrochlorothiazide', furosemide: 'furosemide',
  simvastatin: 'simvastatin', simvistatin: 'simvastatin', atorvastatin: 'atorvastatin', rosuvastatin: 'rosuvastatin',
  pantoprazole: 'pantoprazole', omeprazole: 'omeprazole', domperidone: 'domperidone',
  azithromycin: 'azithromycin', amoxicillin: 'amoxicillin', ampicillin: 'ampicillin', penicillin: 'penicillin', nitrofurantoin: 'nitrofurantoin',
  cetirizine: 'cetirizine', fexofenadine: 'fexofenadine', diphenhydramine: 'diphenhydramine', montelukast: 'montelukast',
  albuterol: 'salbutamol', salbutamol: 'salbutamol', fluticasone: 'fluticasone', epinephrine: 'adrenaline', adrenaline: 'adrenaline',
  levothyroxine: 'levothyroxine', allopurinol: 'allopurinol', colchicine: 'colchicine',
  clavulanate: 'clavulanic acid', loratadine: 'loratadine', astemizole: 'astemizole', terfenadine: 'terfenadine',
  hydrocodone: 'hydrocodone', oxycodone: 'oxycodone', fentanyl: 'fentanyl', morphine: 'morphine', tramadol: 'tramadol',
  sertraline: 'sertraline', clopidogrel: 'clopidogrel', lisinopril: 'lisinopril', metoprolol: 'metoprolol',
  esomeprazole: 'esomeprazole', warfarin: 'warfarin', prednisolone: 'prednisolone', prednisone: 'prednisone',
};

export const FAMILIES = {
  'pain/inflammation (NSAID)': ['ibuprofen', 'naproxen', 'diclofenac', 'aceclofenac', 'aspirin'],
  'cholesterol (statin)': ['simvastatin', 'atorvastatin', 'rosuvastatin'],
  'allergy (antihistamine)': ['cetirizine', 'fexofenadine', 'diphenhydramine', 'loratadine', 'astemizole', 'terfenadine'],
  'strong pain relief (opioid)': ['hydrocodone', 'oxycodone', 'fentanyl', 'morphine', 'tramadol'],
  'acid (PPI)': ['pantoprazole', 'omeprazole'],
  'blood pressure (ARB)': ['telmisartan', 'losartan'],
};

// allergy wording -> ingredients that should raise a warning
export const ALLERGY_CROSS = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'clavulanic acid'],
  sulfa: ['sulfamethoxazole'],
  nsaid: FAMILIES['pain/inflammation (NSAID)'],
  aspirin: ['aspirin'],
};

// A blood group is not in Synthea's records, so the demo assigns one per patient from a hash of the id.
const BLOOD = ['O+', 'A+', 'B+', 'AB+', 'O-', 'A-', 'B-', 'AB-'];

// All fictional.
export const HOSPITALS = ['Kaveri General Hospital', 'Lakeside Clinic', 'Northgate Medical Centre', 'Sunrise Emergency Centre'];

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

export const localBlood = (seed) => BLOOD[hash(`${seed}b`) % BLOOD.length];
