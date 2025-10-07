// /api/chat.js — minimal Assistants v2 (no tools/functions)
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = await readBody(req);
    const { message, threadId: _threadIdFromClient, prevId: _prevIdFromClient } = body || {};
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // env
    const key = (process.env.OPENAI_API_KEY || '').trim();
    const project = (process.env.OPENAI_PROJECT_ID || '').trim(); // only if your key starts with sk-proj-
    const org = (process.env.OPENAI_ORG_ID || '').trim();         // optional
    const assistantId = (process.env.ASSISTANT_ID || '').trim();

    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY is missing' });
    if (!assistantId) return res.status(500).json({ error: 'ASSISTANT_ID is missing' });
    if (key.startsWith('sk-proj-') && !project) {
      return res.status(500).json({ error: 'OPENAI_PROJECT_ID is required when using a sk-proj key' });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'OpenAI-Beta': 'assistants=v2',
      ...(project ? { 'OpenAI-Project': project } : {}),
      ...(org ? { 'OpenAI-Organization': org } : {}),
    };

    // 1) ensure a thread
    let threadId = (_threadIdFromClient || _prevIdFromClient || '').trim();
    if (!threadId) {
      const t = await fetch('https://api.openai.com/v1/threads', { method: 'POST', headers, body: JSON.stringify({}) });
      const tText = await t.text();
      if (!t.ok) return res.status(t.status).json({ error: tText });
      threadId = JSON.parse(tText).id;
    }

    // 2) add user message
    const m = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ role: 'user', content: message })
    });
    if (!m.ok) return res.status(m.status).json({ error: await m.text() });

    // 3) run assistant (no tools)
    const run = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'POST', headers, body: JSON.stringify({ assistant_id: assistantId })
    });
    const runText = await run.text();
    if (!run.ok) return res.status(run.status).json({ error: runText });
    let runData = JSON.parse(runText);

    // 4) simple poll until completed (20s cap)
    const started = Date.now();
    while (runData.status !== 'completed') {
      if (Date.now() - started > 20000) {
        return res.status(502).json({ error: 'Run timed out (serverless limit)', threadId });
      }
      const rr = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runData.id}`, { headers });
      if (!rr.ok) return res.status(rr.status).json({ error: await rr.text(), threadId });
      runData = await rr.json();

      if (['failed', 'expired', 'cancelling', 'cancelled'].includes(runData.status)) {
        return res.status(502).json({ error: `Run status: ${runData.status}`, threadId });
      }
      await sleep(700);
    }

    // 5) get latest assistant reply
    const list = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=10&order=desc`, { headers });
    if (!list.ok) return res.status(list.status).json({ error: await list.text(), threadId });
    const listJson = await list.json();
    const lastAssistant = listJson.data.find(x => x.role === 'assistant');
    const reply = (lastAssistant?.content || [])
      .map(c => c?.text?.value)
      .filter(Boolean)
      .join('\n') || '(no reply)';

    return res.status(200).json({ reply, threadId, responseId: threadId });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}

async function readBody(req) {
  if (req.body) return req.body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch { return {}; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms));}
