export const config = { runtime: 'edge' };

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// Ini nama model asli yang aktif di Google AI Studio (2026)
const GEMINI_MODELS = {
  'gemini-4-hydrogen': 'gemini-4-hydrogen',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.6-flash': 'gemini-3.6-flash',
  'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite'
};

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  
  const model = new URL(req.url).searchParams.get('model') || 'gemini-3.5-flash-lite';
  const body = await req.text();

  // Kalau modelnya ada di daftar Gemini, lempar ke Gemini
  if (GEMINI_MODELS[model]) {
    return handleGemini(GEMINI_MODELS[model], body);
  } 
  // Kalau bukan, anggap itu model Groq
  else {
    return handleGroq(model, body);
  }
}

async function handleGemini(model, body) {
  const p = JSON.parse(body);
  const up = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: p.system_instruction, contents: p.contents }) }
  );
  return pass(up);
}

async function handleGroq(model, body) {
  const p = JSON.parse(body);
  const messages = [];
  const sys = p.system_instruction?.parts?.map(x => x.text).filter(Boolean).join('\n');
  if (sys) messages.push({ role: 'system', content: sys });
  for (const c of p.contents || []) {
    messages.push({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: (c.parts || []).map(x => x.text || '').filter(Boolean).join('\n'),
    });
  }

  const up = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  
  if (!up.ok || !up.body) return pass(up);

  const reader = up.body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  return new Response(new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await reader.read();
      if (done) return ctrl.close();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        const raw = l.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const t = JSON.parse(raw).choices?.[0]?.delta?.content;
          if (t) ctrl.enqueue(enc.encode(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`
          ));
        } catch {}
      }
    }
  }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

function pass(up) {
  return new Response(up.body, {
    status: up.status,
    headers: { 'Content-Type': up.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
