// ReceptionWala — server. One process, one person can run it.
// Demo mode: everything works in-browser. Live mode: set WA_* env vars.
const express = require('express');
const path = require('path');
const { load, save, reseedDemo, uid, todayIST, addDays } = require('./store');
const brain = require('./brain');
const { llmFallback } = require('./llm');
const wa = require('./whatsapp');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = load();

// ---------- helpers ----------
function findOrCreateConv(phone, name) {
  phone = String(phone || '').replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;
  let conv = db.conversations.find(c => c.phone === phone);
  if (!conv) {
    conv = {
      id: uid('conv'), phone, name: name || 'Patient',
      flags: { urgent: false }, state: { stage: 'idle', draft: {} },
      messages: [], lastTs: Date.now()
    };
    db.conversations.push(conv);
  } else if (name && name !== 'Patient' && (!conv.name || conv.name === 'Patient')) {
    conv.name = name;
  }
  return conv;
}
function pushMsg(conv, dir, text) {
  const m = { id: uid('m'), dir, text, ts: Date.now() };
  conv.messages.push(m);
  conv.lastTs = m.ts;
  return m;
}
function stats() {
  const t = todayIST();
  const today = db.appointments.filter(a => a.date === t && a.status !== 'cancelled');
  const upcoming = db.appointments.filter(a => a.date >= t && a.status === 'confirmed');
  const msgsIn = db.conversations.reduce((n, c) => n + c.messages.filter(m => m.dir === 'in').length, 0);
  const aiBookings = db.appointments.filter(a => a.source === 'ai' && a.status !== 'cancelled').length;
  const done = db.appointments.filter(a => a.status === 'completed');
  const noShow = db.appointments.filter(a => a.status === 'no-show').length;
  const finished = done.length + noShow;
  const revenue = db.appointments
    .filter(a => a.status === 'completed' || a.status === 'confirmed')
    .reduce((sum, a) => {
      const s = db.settings.services.find(x => x.name === a.service);
      return sum + (s ? s.fee : db.settings.consultFee);
    }, 0);
  return {
    todayCount: today.length,
    upcomingCount: upcoming.length,
    messagesHandled: msgsIn,
    aiBookings,
    noShowRate: finished ? Math.round((noShow / finished) * 100) : 0,
    estRevenue: revenue,
    hoursSaved: Math.round((msgsIn * 3) / 60 * 10) / 10,
    urgent: db.conversations.filter(c => c.flags.urgent).length,
    waLive: wa.isLive()
  };
}

// ---------- core chat endpoint (simulator + webhook share this) ----------
async function handleChat(phone, name, text) {
  const conv = findOrCreateConv(phone, name);
  pushMsg(conv, 'in', text);
  let out = await brain.reply(conv, text, db);
  // optional LLM polish for unanswered free text
  if (db.settings.llmEnabled && db.settings.llmApiKey && out.text.startsWith('Maaf kijiye')) {
    const better = await llmFallback(text, db.settings, db.kb);
    if (better) out = { text: better, action: null };
  }
  pushMsg(conv, 'out', out.text);
  save();
  return { conv, out };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { phone, name, text } = req.body || {};
    if (!text || !phone) return res.status(400).json({ error: 'phone and text required' });
    const { conv, out } = await handleChat(phone, name, String(text).slice(0, 1000));
    res.json({ reply: out.text, action: out.action, conversationId: conv.id, name: conv.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'brain error' });
  }
});

app.get('/api/conversations', (req, res) => {
  const list = [...db.conversations].sort((a, b) => b.lastTs - a.lastTs);
  res.json(list);
});
app.get('/api/conversations/:id', (req, res) => {
  const c = db.conversations.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});
app.post('/api/conversations/:id/read', (req, res) => {
  const c = db.conversations.find(x => x.id === req.params.id);
  if (c) { c.flags.urgent = false; save(); }
  res.json({ ok: true });
});

// ---------- appointments ----------
app.get('/api/appointments', (req, res) => {
  const list = [...db.appointments].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(list);
});
app.post('/api/appointments', (req, res) => {
  const { name, phone, date, time, service } = req.body || {};
  if (!name || !date || !time) return res.status(400).json({ error: 'name, date, time required' });
  const clash = db.appointments.find(a => a.date === date && a.time === time && a.status !== 'cancelled');
  if (clash) return res.status(409).json({ error: 'Slot already booked — choose another time' });
  const appt = {
    id: uid('apt'), name, phone: String(phone || '').replace(/\D/g, ''), date, time,
    service: service || 'Consultation / Check-up', status: 'confirmed', source: 'front-desk',
    reminderSent: false, reminderConfirmed: false, createdAt: Date.now()
  };
  db.appointments.push(appt); save();
  res.json(appt);
});
app.patch('/api/appointments/:id', (req, res) => {
  const a = db.appointments.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { status } = req.body || {};
  if (!['confirmed', 'completed', 'cancelled', 'no-show'].includes(status)) {
    return res.status(400).json({ error: 'bad status' });
  }
  a.status = status; save();
  res.json(a);
});
app.get('/api/slots', (req, res) => {
  const date = req.query.date || todayIST();
  res.json({ date, slots: brain.openSlots(date, db.settings, db.appointments) });
});

// ---------- reminders & recall (the money features) ----------
app.post('/api/reminders/run', async (req, res) => {
  const tm = addDays(todayIST(), 1);
  const targets = db.appointments.filter(a => a.date === tm && a.status === 'confirmed' && !a.reminderSent);
  for (const a of targets) {
    const text = db.settings.reminderTemplate
      .replaceAll('{name}', a.name.split(' ')[0])
      .replaceAll('{time}', brain.fmt12(a.time))
      .replaceAll('{clinic}', db.settings.clinicName)
      .replaceAll('{doctor}', db.settings.doctorName);
    const conv = findOrCreateConv(a.phone, a.name);
    pushMsg(conv, 'out', text);
    a.reminderSent = true;
    if (wa.isLive()) await wa.sendText(a.phone, text); // utility template in production
  }
  save();
  res.json({ sent: targets.length, date: tm });
});

app.get('/api/recall', (req, res) => res.json(db.recallPatients));
app.post('/api/recall/run', async (req, res) => {
  const targets = db.recallPatients.filter(p => !p.sent);
  for (const p of targets) {
    const text = db.settings.recallTemplate
      .replaceAll('{name}', p.name.split(' ')[0])
      .replaceAll('{clinic}', db.settings.clinicName)
      .replaceAll('{fee}', String(db.settings.consultFee));
    const conv = findOrCreateConv(p.phone, p.name);
    pushMsg(conv, 'out', text);
    p.sent = true;
    if (wa.isLive()) await wa.sendText(p.phone, text); // marketing template in production (₹0.86/msg)
  }
  save();
  res.json({ sent: targets.length, costEstimate: (targets.length * 0.8631).toFixed(2) });
});

// ---------- knowledge base ----------
app.get('/api/kb', (req, res) => res.json(db.kb));
app.post('/api/kb', (req, res) => {
  const { q, a, tags } = req.body || {};
  if (!q || !a) return res.status(400).json({ error: 'q and a required' });
  const item = { id: uid('kb'), q, a, tags: tags || '' };
  db.kb.push(item); save();
  res.json(item);
});
app.delete('/api/kb/:id', (req, res) => {
  const i = db.kb.findIndex(x => x.id === req.params.id);
  if (i >= 0) { db.kb.splice(i, 1); save(); }
  res.json({ ok: true });
});

// ---------- settings & stats ----------
app.get('/api/settings', (req, res) => {
  const s = { ...db.settings };
  if (s.llmApiKey) s.llmApiKey = ''; // never expose the key to the browser
  s.llmKeySet = Boolean(db.settings.llmApiKey);
  res.json(s);
});
app.put('/api/settings', (req, res) => {
  const allowed = ['clinicName', 'doctorName', 'doctorQual', 'tagline', 'address', 'phoneDisplay',
    'consultFee', 'slotMinutes', 'reminderTemplate', 'recallTemplate', 'llmEnabled', 'llmApiKey', 'llmModel'];
  for (const k of allowed) if (k in (req.body || {})) db.settings[k] = req.body[k];
  save();
  const s = { ...db.settings };
  if (s.llmApiKey) s.llmApiKey = '';
  s.llmKeySet = Boolean(db.settings.llmApiKey);
  res.json(s);
});
app.get('/api/stats', (req, res) => res.json(stats()));
app.get('/api/analytics', (req, res) => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(todayIST(), -i);
    const dayAppts = db.appointments.filter(a => a.date === d && a.status !== 'cancelled');
    days.push({
      date: d,
      total: dayAppts.length,
      ai: dayAppts.filter(a => a.source === 'ai').length
    });
  }
  res.json({ days, stats: stats() });
});
app.post('/api/demo/reset', (req, res) => {
  reseedDemo(); // mutates the shared db object in place
  res.json({ ok: true });
});

// ---------- real WhatsApp webhook ----------
app.get('/webhook', wa.verifyWebhook);
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack fast, Meta requires <20s
  const incoming = wa.parseIncoming(req.body);
  if (!incoming) return;
  try {
    const { out } = await handleChat(incoming.phone, incoming.name, incoming.text);
    await wa.sendText(incoming.phone, out.text);
  } catch (e) { console.error('webhook error', e); }
});

app.get('/healthz', (req, res) => res.json({ ok: true, mode: wa.isLive() ? 'live' : 'demo' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReceptionWala running on http://0.0.0.0:${PORT} (${wa.isLive() ? 'LIVE WhatsApp' : 'DEMO mode'})`);
});
