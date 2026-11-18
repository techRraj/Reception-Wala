# ReceptionWala 💬🩺

**Aapki clinic ka AI receptionist, WhatsApp par. 24×7.**
Hinglish-first WhatsApp receptionist for solo clinics in India's tier-2/3 cities.
Built to be run by ONE person (you, Rajkumar).

## What's in the box (MVP v0.1)

| Piece | File | What it does |
|---|---|---|
| Landing page | `public/index.html` | Hinglish sales page: pricing, ROI calculator, comparison, FAQ |
| Patient demo | `public/demo.html` | WhatsApp-style simulator — anyone can book an appointment in Hinglish |
| Doctor dashboard | `public/app.html` | Appointments, live WhatsApp inbox, KB editor, reminders/recall, analytics, settings |
| Hinglish brain | `brain.js` | Deterministic state machine: book/cancel/reschedule, date-time parsing ("kal shaam 6 baje"), fees/timing/address intents, mini-RAG FAQ, medical guardrails, emergency detection |
| Optional LLM | `llm.js` | OpenRouter/Gemini polish for free-text questions (booking NEVER depends on it) |
| WhatsApp layer | `whatsapp.js` | Real Meta Cloud API send + webhook verify/parse. Demo mode when no env vars |
| Server + API | `server.js` | Express, JSON-file DB, reminders & recall campaigns, stats |
| Store | `store.js` | Zero-dependency JSON persistence + realistic seed data (Indore clinic) |

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

- `/` — landing page
- `/demo.html` — patient WhatsApp simulator
- `/app.html` — doctor dashboard

**Demo script (use this to sell):**
1. Open `/demo.html`, type: `kal shaam 6 baje appointment chahiye` → pick `1` → `haan`
2. Open `/app.html` → the appointment is there, source 🤖 AI
3. Click **"Send kal ke reminders"** → go back to the simulator → reminder arrived → type `CONFIRM`
4. Click **"Purane patients ko recall bhejo"** → see the campaign in the Inbox
5. Try `daant me bahut dard hai` → watch the medical guardrail + 🚨 urgent flag in the dashboard

## Go LIVE with real WhatsApp (per clinic)

1. Create a Meta Business account + app at developers.facebook.com → add **WhatsApp** product.
2. Get the clinic's number onto WhatsApp Cloud API (number must NOT be active on the normal WhatsApp app; use a fresh SIM or migrate).
3. Create a **permanent system-user token** with `whatsapp_business_messaging` permission.
4. Set env vars on your server:
   ```
   WA_TOKEN=EAAG...          # permanent token
   WA_PHONE_ID=1234567890    # clinic's phone number ID
   WA_VERIFY_TOKEN=any-secret-string
   ```
5. In Meta's webhook config: URL `https://your-domain/webhook`, verify token = same secret, subscribe to `messages`.
6. Submit **message templates** for approval: one *utility* (appointment reminder) and one *marketing* (patient recall). Inside the 24h customer-service window, free-form replies are allowed (that's what the brain sends).
7. Restart → dashboard shows **LIVE** instead of demo.

**India costs (verify current rates):** utility ≈ ₹0.115/msg, marketing ≈ ₹0.863/msg, service (replies within 24h window) = free.

## Deploy on Render (you already know Render)

- New Web Service → connect this repo → build `npm install` → start `npm start`.
- Free tier works for the pilot. Add a **persistent disk** mounted at `./data` so `db.json` survives deploys.
- Set the `WA_*` env vars per clinic deployment (v0.1 = one deployment per clinic; simplest possible multi-tenancy).

## Roadmap (in priority order)

1. **Real WhatsApp on your own number** + 2 approved templates (this week)
2. **Razorpay payment links** for subscriptions (₹999/₹1,999/₹3,499) — no gateway code needed at first, just links + manual activation
3. **Multi-tenant single server**: add `clinicId` to every record, one webhook per clinic number (when you cross ~10 clinics)
4. **pgvector RAG upgrade**: replace keyword KB with your MCP-server pattern (embeddings + cosine search) for uploaded price lists/FAQ PDFs
5. **DPDP consent flow**: first-message consent line + "DELETE MY DATA" handler
6. **Monthly ROI report** auto-WhatsApp'd to the doctor (bookings recovered, no-shows avoided) — this is your churn-killer

## Honest limitations of v0.1

- WhatsApp is **simulated** in-browser until you set `WA_*` vars (Meta approval is something only you can do).
- Single clinic per deployment; JSON file DB (fine up to ~50 clinics with a disk).
- Rule-based Hinglish NLU covers the common flows; exotic phrasing falls back to a menu (LLM polish optional).
- No auth on the dashboard yet — **add a password before putting real patient data in** (e.g. basic-auth middleware or a simple session login).
