// Optional LLM polish layer. The deterministic brain handles ALL actions.
// If the clinic owner adds an OpenRouter key in Settings, free-text questions
// that the rule engine can't answer get sent here with clinic context (mini-RAG).
// Default demo works fully offline — no key required.

async function llmFallback(question, settings, kb) {
  if (!settings.llmEnabled || !settings.llmApiKey) return null;
  const context = kb.map(k => `Q: ${k.q}\nA: ${k.a}`).join('\n\n');
  const system = `You are the WhatsApp receptionist of ${settings.clinicName} (${settings.tagline}), working for ${settings.doctorName}, ${settings.doctorQual}.
Rules:
- Reply in warm Hinglish (roman script), max 3 short sentences, 1-2 emojis max.
- ONLY answer from the clinic knowledge below. Never give medical advice or diagnosis — say the doctor will advise after check-up, and offer to book.
- Fees: ${settings.services.map(s => s.name + ' ₹' + s.fee).join(', ')}.
- Hours: Mon-Sat 10:00-14:00 and 17:00-21:00, Sunday closed. Address: ${settings.address}.
- For booking, ask the patient to type BOOK.
Clinic knowledge:
${context}`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.llmApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.llmModel || 'google/gemini-2.0-flash-001',
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        max_tokens: 200,
        temperature: 0.4
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return txt ? txt.trim() : null;
  } catch {
    return null; // never break the demo because of an API hiccup
  }
}

module.exports = { llmFallback };
