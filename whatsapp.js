// Real WhatsApp Cloud API layer (Meta).
// In demo mode (no env vars) everything runs through the in-app simulator.
// To go live per clinic, set these env vars and point Meta's webhook here:
//   WA_TOKEN        — permanent system-user access token
//   WA_PHONE_ID     — clinic's WhatsApp Business phone number ID
//   WA_VERIFY_TOKEN — any secret string you also enter in Meta's webhook config
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const GRAPH = 'https://graph.facebook.com/v21.0';

function isLive() {
  return Boolean(process.env.WA_TOKEN && process.env.WA_PHONE_ID);
}

async function sendText(toPhone, text) {
  if (!isLive()) return { demo: true };
  const res = await fetch(`${GRAPH}/${process.env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: { preview_url: false, body: text }
    })
  });
  return res.json();
}

// Meta webhook verification (GET)
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.WA_VERIFY_TOKEN || 'receptionwala-demo')) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// Extract incoming message from Meta's webhook payload
function parseIncoming(body) {
  try {
    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const msg = value && value.messages && value.messages[0];
    if (!msg || msg.type !== 'text') return null;
    const contact = value.contacts && value.contacts[0];
    return {
      phone: msg.from,
      name: (contact && contact.profile && contact.profile.name) || 'Patient',
      text: msg.text.body,
      waMessageId: msg.id
    };
  } catch {
    return null;
  }
}

module.exports = { isLive, sendText, verifyWebhook, parseIncoming };
