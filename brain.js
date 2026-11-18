// ReceptionWala Brain — Hinglish-first deterministic receptionist engine.
// Works 100% offline (no API key needed) so the demo never breaks.
// When the clinic owner adds an OpenRouter/Gemini key in Settings, free-text
// questions optionally go through the LLM with clinic KB context (see llm.js).
// Booking/cancel/reschedule ALWAYS run through this state machine = reliable.

const { load, save, uid, todayIST, addDays, nowIST } = require('./store');

const DAY_MAP = {
  sunday: 0, ravi: 0, itwar: 0, ravivar: 0,
  monday: 1, som: 1, somvar: 1, somvaar: 1,
  tuesday: 2, mangal: 2, mangalvar: 2,
  wednesday: 3, budh: 3, budhvar: 3,
  thursday: 4, guru: 4, guruvar: 4, brihaspati: 4,
  friday: 5, shukra: 5, shukravar: 5,
  saturday: 6, shani: 6, shanivar: 6
};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function norm(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s:/.-]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function has(t, words) { return words.some(w => t.includes(w)); }
function affirm(t) {
  return /\b(ha|han|haan|hanji|ji|yes|y|ok|okay|yep|ya|confirm|pakka|theek|thik|done|sahi)\b/.test(t) ||
    has(t, ['kar do', 'karo', 'bilkul', 'aaunga', 'aayenge', 'aa jaunga', 'book kar']);
}
function negate(t) {
  return /\b(no|nahi|nahin|nope|mat|cancel)\b/.test(t) || has(t, ['rehne do', 'mat karo', 'nahi chahiye']);
}
function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHHMM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function fmt12(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function fmtDate(dateStr) {
  const t = todayIST();
  if (dateStr === t) return 'aaj';
  if (dateStr === addDays(t, 1)) return 'kal';
  if (dateStr === addDays(t, 2)) return 'parso';
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
}

// ---------- date & time parsing (Hinglish) ----------
function parseDate(t) {
  const today = todayIST();
  if (has(t, ['aaj', 'today', 'abhi', 'ab '])) return today;
  if (has(t, ['parso', 'day after'])) return addDays(today, 2);
  if (has(t, ['kal', 'tomorrow', 'tmrw'])) return addDays(today, 1);
  const dm = t.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (dm) {
    const d = +dm[1], mo = +dm[2];
    let y = dm[3] ? +dm[3] : +today.slice(0, 4);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (s >= today) return s;
    }
  }
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mm = t.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (mm) {
    const s = `${today.slice(0, 4)}-${String(months[mm[2]]).padStart(2, '0')}-${String(+mm[1]).padStart(2, '0')}`;
    if (s >= today) return s;
  }
  for (const [name, idx] of Object.entries(DAY_MAP)) {
    if (new RegExp('\\b' + name + '\\b').test(t)) {
      const cur = new Date(today + 'T00:00:00Z').getUTCDay();
      let diff = (idx - cur + 7) % 7;
      if (diff === 0) diff = 7; // "monday" means next monday
      return addDays(today, diff);
    }
  }
  if (has(t, ['next week', 'agle hafte', 'agla week'])) return addDays(today, 7);
  return null;
}

function parseTime(t, settings) {
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(baje|bje|am|pm)?\b/);
  if (!m) return null;
  let h = +m[1]; const min = m[2] ? +m[2] : 0;
  if (min > 59) return null;
  const suffix = m[3] || '';
  const morning = has(t, ['subah', 'morning', 'savere']);
  const afternoon = has(t, ['dopahar', 'afternoon', 'lunch']);
  const evening = has(t, ['shaam', 'sham', 'evening', 'night', 'raat']);
  let candidates;
  if (suffix === 'pm' || evening || afternoon) candidates = [h < 12 ? h + 12 : h, h];
  else if (suffix === 'am' || morning) candidates = [h, h + 12];
  else candidates = h <= 9 ? [h + 12, h] : [h, h + 12]; // "6 baje" -> 18:00 for a clinic open till 9pm
  for (const ch of candidates) {
    if (ch > 23) continue;
    const mins = ch * 60 + min;
    if (settings.periods.some(p => mins >= toMin(p.start) && mins < toMin(p.end))) return toHHMM(mins);
  }
  return null;
}

// ---------- slots ----------
function openSlots(date, settings, appts) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (settings.closedDays.includes(dow)) return [];
  const taken = new Set(appts.filter(a => a.date === date && a.status !== 'cancelled').map(a => a.time));
  const out = [];
  const now = nowIST();
  const isToday = date === todayIST();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const p of settings.periods) {
    for (let m = toMin(p.start); m + settings.slotMinutes <= toMin(p.end); m += settings.slotMinutes) {
      const hhmm = toHHMM(m);
      if (taken.has(hhmm)) continue;
      if (isToday && m <= nowMin + 30) continue; // need 30 min lead time
      out.push(hhmm);
    }
  }
  return out;
}
function pickOffers(slots, prefTime, n = 3) {
  if (!prefTime) {
    // spread across the day
    if (slots.length <= n) return slots;
    const idx = [0, Math.floor(slots.length / 2), slots.length - 1];
    return [...new Set(idx.map(i => slots[i]))];
  }
  const pm = toMin(prefTime);
  return [...slots].sort((a, b) => Math.abs(toMin(a) - pm) - Math.abs(toMin(b) - pm)).slice(0, n);
}

// ---------- KB retrieval (mini-RAG, keyword scoring) ----------
const STOPWORDS = new Set(['kya', 'hai', 'hain', 'kaise', 'kitna', 'kitne', 'kitni', 'karna', 'kar', 'me', 'mera', 'meri', 'aap', 'clinic', 'ka', 'ki', 'ke', 'ko', 'se', 'ho', 'hota', 'hoga', 'hoti', 'chahiye', 'kab', 'kahan', 'aur', 'bhi', 'toh', 'the', 'is', 'are', 'can', 'my', 'what', 'how', 'does', 'do', 'you', 'please', 'bataye', 'batao', 'raha', 'rahi', 'hue', 'wala', 'liye', 'par', 'tak', 'sab', 'koi', 'kyu', 'kyun', 'why', 'when', 'where']);
function kbAnswer(t, kb) {
  const words = norm(t).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w));
  let best = null, bestScore = 0;
  for (const k of kb) {
    const hay = norm(k.q + ' ' + k.a);
    const tags = norm(k.tags || '');
    let score = 0;
    for (const w of words) {
      if (tags.includes(w)) score += 2;
      else if (hay.includes(w)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return bestScore >= 2 ? best : null;
}

function serviceMatch(t, settings) {
  for (const s of settings.services) {
    if (s.keywords.some(k => t.includes(k)) || t.includes(s.name.toLowerCase())) return s;
  }
  return null;
}

function upcomingFor(phone, appts) {
  const t = todayIST();
  return appts
    .filter(a => a.phone === phone && a.status === 'confirmed' && a.date >= t)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] || null;
}

function book(conv, db, date, time, service) {
  const appt = {
    id: uid('apt'), name: conv.name || 'Patient', phone: conv.phone,
    date, time, service: service || 'Consultation / Check-up',
    status: 'confirmed', source: 'ai', reminderSent: false, reminderConfirmed: false, createdAt: Date.now()
  };
  db.appointments.push(appt);
  const token = db.appointments.filter(a => a.date === date && a.status !== 'cancelled').length;
  return { appt, token };
}

const S = () => load().settings;

// ---------- main reply ----------
async function reply(conv, text, db) {
  const settings = db.settings;
  const t = norm(text);
  const st = conv.state || (conv.state = { stage: 'idle', draft: {} });
  const clinic = settings.clinicName;
  const doc = settings.doctorName;
  const fee = settings.consultFee;
  const addr = settings.address;

  const say = (msg) => ({ text: msg, action: null });

  // ---- safety first: emergencies & medical advice ----
  if (has(t, ['emergency', 'accident', 'bahut khoon', 'bleeding', 'behosh', 'unconscious', 'saans'])) {
    conv.flags.urgent = true;
    return say(`🚨 Yeh emergency lag rahi hai. Main sirf receptionist hoon — please turant nazdeeki hospital ke emergency ward jaayein ya 108 ambulance call karein. Maine ${doc} ko alert bhej diya hai. Agar daant ka severe dard hai to main abhi ka sabse pehla slot de sakta hoon — "abhi slot" likhein.`);
  }
  if (has(t, ['abhi slot', 'turant slot', 'earliest', 'jaldi se jaldi'])) {
    const today = todayIST();
    const slots = openSlots(today, settings, db.appointments);
    if (slots.length) {
      st.stage = 'confirm'; st.draft = { date: today, time: slots[0], service: st.draft.service || 'Consultation / Check-up' };
      return say(`Sabse pehla available slot: aaj ${fmt12(slots[0])}. Naam ${conv.name} hai na? Confirm karne ke liye "haan" likhein.`);
    }
    const tm = addDays(today, 1);
    const s2 = openSlots(tm, settings, db.appointments);
    st.stage = 'confirm'; st.draft = { date: tm, time: s2[0], service: 'Consultation / Check-up' };
    return say(`Aaj ke slots full ho gaye hain 🙏 Sabse pehla slot kal ${fmt12(s2[0])} hai. Book karun? "haan" likhein.`);
  }

  // ---- booking state machine ----
  if (st.stage === 'name') {
    let name = text.trim().replace(/^(mera naam|my name is|naam|i am|myself|main)\s+/i, '').replace(/\s+(hai|hu|hoon)\.?$/i, '');
    if (name.length < 2) return say('Aapka poora naam batayein please 🙏');
    conv.name = name; st.stage = 'when';
    return say(`Shukriya ${name} ji! Kis din aur time par aana chahenge? (Jaise "kal shaam 6 baje" ya "saturday subah 11"). ${DAY_NAMES[new Date(todayIST() + 'T00:00:00Z').getUTCDay()] === 'Saturday' ? '' : ''}Clinic Mon–Sat 10–2 & 5–9 khula hai, Sunday closed.`);
  }

  if (st.stage === 'when' || st.stage === 'slot') {
    if (negate(t) && has(t, ['cancel', 'rehne do', 'nahi chahiye', 'band karo', 'nahi'])) { st.stage = 'idle'; st.draft = {}; return say('Theek hai, booking cancel kar di. Jab chahein "BOOK" likhkar phir shuru kar sakte hain 🙏'); }
    let date = parseDate(t) || st.draft.date;
    let pref = parseTime(t, settings);
    if (!date) return say('Kaunsa din theek rahega — aaj, kal, ya koi aur din? (Sunday closed hai)');
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (settings.closedDays.includes(dow)) {
      const next = addDays(date, 1);
      const slots = openSlots(next, settings, db.appointments);
      st.stage = 'slot'; st.draft.date = next; st.draft.offers = pickOffers(slots, pref);
      return say(`Sunday clinic closed rehta hai 🙏 Monday ke slots: ${st.draft.offers.map((s, i) => `${i + 1}) ${fmt12(s)}`).join('  ')}. Number ya time likhein.`);
    }
    const slots = openSlots(date, settings, db.appointments);
    if (!slots.length) {
      const next = addDays(date, 1);
      const s2 = openSlots(next, settings, db.appointments);
      if (!s2.length) return say('Us din slots full hain. Koi aur din try karein?');
      st.stage = 'slot'; st.draft.date = next; st.draft.offers = pickOffers(s2, pref);
      return say(`${fmtDate(date)} ke slots full ho gaye hain 😅 ${fmtDate(next)} ye available hain: ${st.draft.offers.map((s, i) => `${i + 1}) ${fmt12(s)}`).join('  ')}. Kaunsa book karun?`);
    }
    // direct slot pick by number
    if (st.stage === 'slot' && st.draft.offers) {
      const pureNum = t.match(/^[1-9]$/);
      const num = t.match(/\b([1-9])\b/);
      const exact = pureNum ? null : parseTime(t, settings);
      let chosen = null;
      if (pureNum && st.draft.offers[+pureNum[0] - 1]) chosen = st.draft.offers[+pureNum[0] - 1];
      else if (exact && st.draft.offers.includes(exact)) chosen = exact;
      else if (num && st.draft.offers[+num[1] - 1]) chosen = st.draft.offers[+num[1] - 1];
      else if (has(t, ['pehla', 'first', '1st'])) chosen = st.draft.offers[0];
      if (chosen) {
        st.stage = 'confirm'; st.draft.time = chosen;
        const svc = st.draft.service || 'Consultation / Check-up';
        const svcObj = settings.services.find(s => s.name === svc);
        return say(`Confirm karein 📋\n👤 ${conv.name}\n📅 ${fmtDate(st.draft.date)} (${st.draft.date})\n🕐 ${fmt12(chosen)}\n🦷 ${svc} — ₹${svcObj ? svcObj.fee : fee}\n\n"haan" likhein to book ho jayega.`);
      }
    }
    const offers = pickOffers(slots, pref);
    st.stage = 'slot'; st.draft.date = date; st.draft.offers = offers;
    return say(`${fmtDate(date)} ke liye ye slots available hain:\n${offers.map((s, i) => `${i + 1}) ${fmt12(s)}`).join('\n')}\n\nNumber (1/2/3) ya apna time likhein.`);
  }

  if (st.stage === 'confirm') {
    if (affirm(t)) {
      const { appt, token } = book(conv, db, st.draft.date, st.draft.time, st.draft.service);
      st.stage = 'idle'; st.draft = {};
      return { text: `Done! ✅ Appointment confirm:\n👤 ${appt.name}\n📅 ${fmtDate(appt.date)} (${appt.date}) 🕐 ${fmt12(appt.time)}\n🦷 ${appt.service}\n🎫 Token #${token}\n\n${doc} ke saath ${clinic}. 10 min pehle aayein. Ek din pehle reminder aayega 📲\n📍 ${addr}\n\nBadalna ho to "CHANGE", cancel karna ho to "CANCEL" likhein.`, action: { type: 'booked', id: appt.id } };
    }
    if (negate(t)) { st.stage = 'idle'; st.draft = {}; return say('Theek hai, book nahi kiya. Koi aur din/time dekhna ho to batayein 🙏'); }
    return say('Booking confirm karun? "haan" ya "nahi" likhein 🙏');
  }

  if (st.stage === 'cancel_confirm') {
    if (affirm(t) || /\bcancel\b/.test(t)) {
      const appt = db.appointments.find(a => a.id === st.draft.apptId);
      if (appt) appt.status = 'cancelled';
      st.stage = 'idle'; st.draft = {};
      return { text: 'Cancel kar diya ✅ Koi charge nahi. Jab dobara aana ho, bas "BOOK" likhein. Apna khayal rakhein! 🙏', action: { type: 'cancelled', id: appt ? appt.id : null } };
    }
    st.stage = 'idle'; st.draft = {};
    return say('Theek hai, appointment waise hi rakha hai 👍');
  }

  // ---- reminder confirm/cancel shortcuts ----
  const lastOut = [...conv.messages].reverse().find(m => m.dir === 'out');
  if (lastOut && /reminder|CONFIRM likhein|yaad-dilaana/i.test(lastOut.text)) {
    const appt = upcomingFor(conv.phone, db.appointments);
    if (appt && affirm(t)) {
      appt.reminderConfirmed = true;
      return say(`Shukriya ${conv.name} ji! ✅ ${fmtDate(appt.date)} ${fmt12(appt.time)} par milte hain. 🙏`);
    }
  }

  // ---- intents ----
  if (/\b(cancel)\b/.test(t)) {
    const appt = upcomingFor(conv.phone, db.appointments);
    if (!appt) return say('Aapka koi upcoming appointment nahi mila. Naya book karna ho to "BOOK" likhein 🙏');
    st.stage = 'cancel_confirm'; st.draft = { apptId: appt.id };
    return say(`Aapka appointment: ${fmtDate(appt.date)} ${fmt12(appt.time)} — ${appt.service}. Kya ise cancel karun? "haan" likhein to cancel ho jayega.`);
  }

  if (has(t, ['reschedule', 'change', 'badal', 'shift', 'dusra time', 'aur time', 'badalna'])) {
    const appt = upcomingFor(conv.phone, db.appointments);
    if (appt) {
      appt.status = 'cancelled';
      st.stage = 'when'; st.draft = { service: appt.service, date: appt.date };
      return { text: `Purana slot (${fmtDate(appt.date)} ${fmt12(appt.time)}) chhod diya hai. Naya time batayein (usi din ya koi aur din) — jaise "shaam 7 baje" 🙏`, action: { type: 'cancelled', id: appt.id } };
    }
    st.stage = 'when'; st.draft = {};
    return say('Naya din aur time batayein — jaise "kal shaam 6 baje" 🙏');
  }

  if (has(t, ['book', 'appointment', 'slot', 'milna', 'mil sakte', 'milenge', 'dikhana', 'checkup', 'check-up', 'aana hai', 'visit karn', 'time chahiye', 'lagwana', 'karwana', 'karvana'])) {
    const svc = serviceMatch(t, settings);
    st.draft = { service: svc ? svc.name : 'Consultation / Check-up' };
    const date = parseDate(t); const pref = parseTime(t, settings);
    if (!conv.name || conv.name === 'Patient') { st.stage = 'name'; return say(`Namaste! 🙏 ${clinic} me aapka swagat hai. Main aapki AI receptionist hoon. Pehle apna naam batayein please?`); }
    if (date) {
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      if (settings.closedDays.includes(dow)) {
        const next = addDays(date, 1);
        const offers = pickOffers(openSlots(next, settings, db.appointments), pref);
        st.stage = 'slot'; st.draft.date = next; st.draft.offers = offers;
        return say(`Sunday closed rehta hai 🙏 Monday ke slots: ${offers.map((s, i) => `${i + 1}) ${fmt12(s)}`).join('  ')}. Kaunsa book karun?`);
      }
      const offers = pickOffers(openSlots(date, settings, db.appointments), pref);
      if (!offers.length) return say(`${fmtDate(date)} slots full hain 😅 Koi aur din batayein?`);
      st.stage = 'slot'; st.draft.date = date; st.draft.offers = offers;
      return say(`${fmtDate(date)} ke liye available slots:\n${offers.map((s, i) => `${i + 1}) ${fmt12(s)}`).join('\n')}\n\nNumber ya time likhein${svc ? ` (${svc.name} — ₹${svc.fee})` : ''}.`);
    }
    st.stage = 'when';
    return say(`Ji zaroor${svc ? ` — ${svc.name} (₹${svc.fee})` : ''}! Kis din aur time par aana chahenge? Jaise "kal shaam 6 baje" ya "saturday subah 11". Clinic Mon–Sat 10–2 & 5–9, Sunday closed.`);
  }

  if (has(t, ['timing', 'timings', 'time kya', 'kab khula', 'kitne baje', 'open', 'close', 'hours', 'chutti', 'sunday', 'kab tak', 'kab band'])) {
    return say(`🕐 ${clinic} ki timing:\nSomvaar–Shanivaar: subah 10:00–2:00, shaam 5:00–9:00\nSunday: closed\n\nAppointment book karna ho to "BOOK" likhein — bina wait ke slot mil jayega 👍`);
  }

  if (has(t, ['fees', 'fee', 'charge', 'charges', 'cost', 'price', 'rate', 'kitna', 'kitne', 'kharcha', 'paisa', 'paise'])) {
    const svc = serviceMatch(t, settings);
    if (svc) return say(`${svc.name} ka charge ₹${svc.fee} hai. Book karna ho to "BOOK" likhein 🙏`);
    const list = settings.services.slice(0, 6).map(s => `• ${s.name}: ₹${s.fee}`).join('\n');
    return say(`💰 Hamare charges:\n${list}\n\nUPI/cash/card sab chalta hai. Book karne ke liye "BOOK" likhein.`);
  }

  if (has(t, ['address', 'kahan', 'location', 'pata', 'directions', 'map', 'kaise aau', 'kaise pahunchu', 'kidhar'])) {
    return say(`📍 ${addr}\n\nGoogle Maps par "${clinic} Vijay Nagar" search karein. Free 2-wheeler parking building ke neeche hai.`);
  }

  if (has(t, ['doctor kaun', 'kaun hai doctor', 'qualification', 'degree', 'experience', 'kitne saal', 'doctor ke bare'])) {
    return say(`👩‍⚕️ ${doc} — ${settings.doctorQual}. ${clinic}, ${settings.tagline}. Appointment ke liye "BOOK" likhein 🙏`);
  }

  if (has(t, ['service', 'treatment', 'kya kya', 'ilaj', 'facility', 'kya hota'])) {
    const list = settings.services.map(s => `• ${s.name} — ₹${s.fee}`).join('\n');
    return say(`🦷 ${clinic} me ye treatments hote hain:\n${list}\n\nKisi ke liye bhi "BOOK" likhein.`);
  }

  if (has(t, ['human', 'staff se', 'receptionist se', 'baat kar', 'call kar', 'phone se baat'])) {
    return say(`Ji, main ${doc} ki team ko message bhej raha hoon — wo jaldi hi reply karenge 🙏 Urgent hai to clinic ke number ${settings.phoneDisplay} par call kar sakte hain. Tab tak main appointment book kar sakta hoon.`);
  }

  // medical symptoms → guardrail FIRST (unless asking about a specific treatment)
  const symptom = has(t, ['dard', 'pain', 'bukhar', 'fever', 'infection', 'sujan', 'swelling', 'khoon', 'problem', 'takleef', 'keeda']);
  const urgentWord = has(t, ['bahut', 'tez', 'severe', 'bohot', 'asahniya', 'khoon', 'bleeding', 'sujan', 'swelling']);
  if (symptom && (!serviceMatch(t, settings) || urgentWord)) {
    conv.flags.urgent = urgentWord;
    return say(`Samajh sakta hoon 🙏 Main receptionist hoon, isliye medical salah ${doc} hi denge — wo check-up ke baad sahi treatment batayenge. ${conv.flags.urgent ? 'Zyada takleef lag rahi hai — main sabse pehla slot dekh sakta hoon, "abhi slot" likhein. Agar bahut zyada problem hai to turant clinic aayein ya call karein.' : 'Appointment book karun? "BOOK" likhein ya din/time batayein.'}`);
  }

  // clinic FAQ → mini-RAG over owner's knowledge base
  const kb = kbAnswer(t, db.kb);
  if (kb) return say(kb.a + '\n\nAppointment chahiye to "BOOK" likhein 🙏');

  if ((/\b(hi|hello|hey|namaste|namaskar|salam)\b/.test(t) || has(t, ['good morning', 'good evening', 'ram ram'])) && t.length < 25) {
    return say(`Namaste ${conv.name ? conv.name + ' ji' : ''}! 🙏 ${clinic} me swagat hai. Main aapki AI receptionist hoon — 24×7 available.\n\nMain ye kar sakta hoon:\n📅 Appointment book/change/cancel\n💰 Fees batana\n🕐 Timings & address\n❓ Clinic ke baare me sawal\n\nBas likhein jaise "kal shaam 6 baje appointment chahiye" 😊`);
  }

  if (has(t, ['thank', 'shukriya', 'dhanyawad', 'thanks', 'thx'])) {
    return say(`Aapka swagat hai! 🙏 ${clinic} aapki seva me hamesha ready hai. Apna khayal rakhein 😊`);
  }

  // fallback (LLM hook lives here in production — see llm.js)
  return say(`Maaf kijiye, main theek se samajh nahi paya 🙏 Main ye kar sakta hoon:\n📅 "BOOK" — appointment\n💰 "FEES" — charges\n🕐 "TIMING" — clinic hours\n📍 "ADDRESS" — location\n\nYa seedha likhein: "kal shaam 6 baje appointment chahiye". Complex sawal ke liye clinic ${settings.phoneDisplay} par call karein.`);
}

module.exports = { reply, openSlots, fmt12, fmtDate, parseDate, parseTime, norm };
