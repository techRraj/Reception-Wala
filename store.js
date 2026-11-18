// Tiny JSON-file store. Zero dependencies, perfect for a solo-founder MVP.
// Swap for PostgreSQL later (you already know pgvector) when you cross ~50 clinics.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function nowIST() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function todayIST() { return nowIST().toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

const DEFAULT_SETTINGS = {
  clinicName: 'Sharma Dental Clinic',
  doctorName: 'Dr. Meena Sharma',
  doctorQual: 'BDS, MDS (12+ yrs experience)',
  tagline: 'Vijay Nagar, Indore',
  address: '2nd Floor, Vinay Nagar Complex, Scheme 54, Vijay Nagar, Indore (MP) — near C21 Mall',
  phoneDisplay: '+91 90000 12345',
  consultFee: 500,
  slotMinutes: 20,
  periods: [ { start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' } ],
  closedDays: [0], // Sunday
  services: [
    { name: 'Consultation / Check-up', fee: 500, keywords: ['consultation', 'checkup', 'check-up', 'dikhana', 'check'] },
    { name: 'Cleaning / Scaling', fee: 1500, keywords: ['cleaning', 'scaling', 'safai', 'clean'] },
    { name: 'Filling (Cavity)', fee: 1200, keywords: ['filling', 'cavity', 'keeda'] },
    { name: 'Root Canal (RCT)', fee: 4500, keywords: ['root canal', 'rct'] },
    { name: 'Braces / Aligners Consult', fee: 1000, keywords: ['braces', 'aligner', 'tedhe', 'wire'] },
    { name: 'Kids Dentistry', fee: 600, keywords: ['kids', 'bacche', 'child', 'bacha'] },
    { name: 'Tooth Removal (Extraction)', fee: 1000, keywords: ['extraction', 'nikalna', 'remove', 'todna'] }
  ],
  reminderTemplate: 'Namaste {name} ji! 🙏 Kal {time} par {clinic} me {doctor} ke saath aapka appointment hai. Pahunchna ho to CONFIRM likhein, badalna ho to CHANGE, cancel karna ho to CANCEL likhein. — {clinic}',
  recallTemplate: 'Namaste {name} ji! {clinic} ki taraf se yaad-dilaana: aapki last visit ko 6+ mahine ho gaye hain. Routine dental check-up (₹{fee}) se badi problems bachti hain. Appointment ke liye bas "BOOK" likhein. 🦷',
  llmEnabled: false,
  llmApiKey: '',
  llmModel: 'google/gemini-2.0-flash-001',
  plan: 'Growth — ₹1,999/mo (pilot)'
};

const SEED_KB = [
  { q: 'Clinic ki timing kya hai? Sunday khula hai?', a: 'Clinic Mon–Sat subah 10:00–2:00 aur shaam 5:00–9:00 khula rehta hai. Sunday closed. 🕐', tags: 'timing time hours open close sunday chutti kab' },
  { q: 'Payment kaise kar sakte hain? UPI chalega?', a: 'Cash, UPI (GPay/PhonePe/Paytm) aur card — sab chalta hai. Insurance/cashless abhi available nahi hai.', tags: 'payment upi gpay phonepe paytm cash card insurance cashless paisa' },
  { q: 'Root canal me kitna time lagta hai? Dard hoga?', a: 'RCT usually 1–3 sittings me complete hota hai (20–40 min per sitting). Local anesthesia me procedure painless hota hai — exact plan doctor check-up ke baad batayenge.', tags: 'root canal rct dard pain sitting time kitna' },
  { q: 'Braces ka kharcha kitna aata hai?', a: 'Braces consult ₹1,000 hai. Full treatment cost case par depend karti hai (metal/ceramic/aligners) — consult me doctor exact estimate de denge.', tags: 'braces aligners tedhe daant wire cost kharcha' },
  { q: 'Bacchon ka ilaj hota hai? Kitni age se?', a: 'Ji haan, Kids Dentistry available hai (1 saal ki age se). Pehli visit friendly hoti hai — bas dar mat bataiye, doctor handle kar lenge. 😊', tags: 'kids bacche bacha child baby age children' },
  { q: 'Parking hai? Clinic kaise pahunchu?', a: 'C21 Mall ke paas, Vinay Nagar Complex ki 2nd floor par. Building ke neeche free 2-wheeler parking, car parking mall me. Google Maps par "Sharma Dental Clinic Vijay Nagar" search karein.', tags: 'parking address location kahan pata map directions reach' },
  { q: 'Pehli visit me kya lana chahiye?', a: 'Bas aap aur purane dental reports/X-rays (agar hain). Baaki sab clinic me ho jayega. Pehli baar 10 min jaldi aayein taaki form bhar sakein.', tags: 'first visit pehli kya lana bring reports xray x-ray documents' },
  { q: 'Reports/X-ray kaise milte hain?', a: 'Digital X-ray same visit par WhatsApp par bhej diye jaate hain. Physical copy chahiye to reception se le sakte hain.', tags: 'report reports xray x-ray digital copy milte' }
];

function seed() {
  const t = todayIST();
  const tm = addDays(t, 1);
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const appts = [];
  const mk = (name, phone, date, time, service, status, source) => ({
    id: uid('apt'), name, phone, date, time, service, status, source,
    reminderSent: false, reminderConfirmed: false, createdAt: Date.now()
  });
  appts.push(mk('Rohit Malviya', '919812345001', t, '10:20', 'Cleaning / Scaling', 'completed', 'ai'));
  appts.push(mk('Sana Khan', '919812345002', t, '11:00', 'Consultation / Check-up', 'completed', 'ai'));
  appts.push(mk('Deepak Joshi', '919812345003', t, '12:00', 'Filling (Cavity)', 'confirmed', 'front-desk'));
  appts.push(mk('Priya Agrawal', '919812345004', t, '18:00', 'Braces / Aligners Consult', 'confirmed', 'ai'));
  appts.push(mk('Imran Sheikh', '919812345005', t, '18:40', 'Root Canal (RCT)', 'confirmed', 'ai'));
  appts.push(mk('Kavita Yadav', '919812345006', tm, '10:00', 'Consultation / Check-up', 'confirmed', 'ai'));
  appts.push(mk('Arjun Patel', '919812345007', tm, '17:20', 'Kids Dentistry', 'confirmed', 'ai'));
  appts.push(mk('Neha Jain', '919812345008', addDays(t, -1), '19:00', 'Consultation / Check-up', 'no-show', 'ai'));

  const convs = [
    {
      id: uid('conv'), phone: '919812345004', name: 'Priya Agrawal', flags: { urgent: false },
      state: { stage: 'idle', draft: {} },
      messages: [
        { id: uid('m'), dir: 'in', text: 'Hi, braces ka consult karwana hai. Kal evening mil sakta hai?', ts: Date.now() - 3600e3 * 5 },
        { id: uid('m'), dir: 'out', text: 'Namaste Priya ji! 🙏 Ji bilkul. Kal shaam 5:20 ya 6:00 — kaunsa time theek rahega? (Braces consult ₹1,000, 20 min)', ts: Date.now() - 3600e3 * 5 + 40e3 },
        { id: uid('m'), dir: 'in', text: '6 baje book kar do', ts: Date.now() - 3600e3 * 4 },
        { id: uid('m'), dir: 'out', text: 'Done! ✅ Aaj shaam 6:00 par Dr. Meena Sharma ke saath Braces Consult book ho gaya. Token #4. 10 min pehle aayein. Reminder kal aayega nahi — aaj hi hai 😄 Address: Vinay Nagar Complex, Scheme 54 (C21 Mall ke paas).', ts: Date.now() - 3600e3 * 4 + 30e3 }
      ],
      lastTs: Date.now() - 3600e3 * 4 + 30e3
    },
    {
      id: uid('conv'), phone: '919812345008', name: 'Neha Jain', flags: { urgent: false },
      state: { stage: 'idle', draft: {} },
      messages: [
        { id: uid('m'), dir: 'out', text: 'Namaste Neha ji! Kal 7:00 PM par aapka appointment tha, aap aa nahi paye. Koi baat nahi — naya time book karna ho to bas "BOOK" likhein. 🙏', ts: Date.now() - 3600e3 * 12 },
        { id: uid('m'), dir: 'in', text: 'Sorry, kaam aa gaya tha. Parso shaam ko dekh lo', ts: Date.now() - 3600e3 * 11 }
      ],
      lastTs: Date.now() - 3600e3 * 11
    }
  ];

  const recall = [
    { id: uid('rc'), name: 'Suresh Chouhan', phone: '919812345101', lastVisitMonths: 8, sent: false },
    { id: uid('rc'), name: 'Anita Bhargava', phone: '919812345102', lastVisitMonths: 7, sent: false },
    { id: uid('rc'), name: 'Farhan Ali', phone: '919812345103', lastVisitMonths: 11, sent: false }
  ];

  return {
    settings,
    kb: SEED_KB.map(k => ({ id: uid('kb'), ...k })),
    appointments: appts,
    conversations: convs,
    recallPatients: recall,
    meta: { seededAt: Date.now(), seedDate: t }
  };
}

let db;
function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = seed();
    save();
  }
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function reseedDemo() {
  // Mutate IN PLACE so every module holding the db reference stays in sync.
  const fresh = seed();
  fresh.settings = db.settings; // keep owner's settings
  fresh.kb = db.kb;
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, fresh);
  save();
  return db;
}

module.exports = { load, save, reseedDemo, uid, nowIST, todayIST, addDays };
