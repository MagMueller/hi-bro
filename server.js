// Local proxy for chain-ditto. Talks to Browser Use Cloud v3, OpenAI, ElevenLabs.
//
// Browser Use endpoints used (https://docs.browser-use.com/cloud/openapi/v3.json):
//   GET    /api/v3/workspaces                  list workspaces
//   POST   /api/v3/workspaces                  create workspace
//   GET    /api/v3/profiles                    list profiles
//   GET    /api/v3/sessions                    list sessions (paginated)
//   POST   /api/v3/sessions                    create OR dispatch (sessionId optional)
//   GET    /api/v3/sessions/{id}               status + final output
//   POST   /api/v3/sessions/{id}/stop          { strategy: "task" } stops task, keeps session
//   DELETE /api/v3/sessions/{id}               destroy session entirely
//   GET    /api/v3/sessions/{id}/messages      cursor-paginated messages

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
// Local-only: Vercel serves /public/* directly via CDN.
if (!process.env.VERCEL) {
  app.use(express.static(join(__dirname, 'public')));
}

const BU_BASE = 'https://api.browser-use.com/api/v3';

// Cached, lazily-created workspace (only used when the user hasn't picked one).
let cachedWorkspaceId = null;
let workspaceDenied   = false;

function buHeaders(apiKey) {
  return { 'X-Browser-Use-API-Key': apiKey, 'Content-Type': 'application/json' };
}
async function buFetch(path, { method = 'GET', apiKey, body } = {}) {
  const res = await fetch(`${BU_BASE}${path}`, {
    method,
    headers: buHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Browser Use ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status; err.body = data;
    throw err;
  }
  return data;
}
async function ensureWorkspace(apiKey, explicitId) {
  if (explicitId === '__none__') return null;     // explicit "no workspace"
  if (explicitId) return explicitId;
  if (cachedWorkspaceId) return cachedWorkspaceId;
  if (workspaceDenied) return null;
  try {
    const data = await buFetch('/workspaces', { method: 'POST', apiKey, body: { name: 'chain-ditto' } });
    cachedWorkspaceId = data.id;
    return cachedWorkspaceId;
  } catch (e) {
    if (e.status === 402 || e.status === 403) {
      workspaceDenied = true;
      return null;
    }
    throw e;
  }
}

// Hidden suffix appended to every task. Tells the BU agent to keep the response
// short and TTS-friendly. Never visible to the user in the chat.
const TASK_FORMAT_SUFFIX = '\n\n---\nIMPORTANT: Keep your final answer concise and to the point. Markdown formatting (bold, bullet lists, short tables, headings) is welcome.';

// =========================================================================
// Dispatch a task to a Browser Use session
// =========================================================================
app.post('/api/dispatch', async (req, res) => {
  const { task, sessionId, apiKey, workspaceId, profileId, proxyCountryCode = 'us' } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: 'Missing Browser Use apiKey' });
  if (!task)   return res.status(400).json({ error: 'Missing task' });

  try {
    const ws = await ensureWorkspace(apiKey, workspaceId);

    // If we have an existing session, stop the running task on it (keeps session alive).
    if (sessionId) {
      try {
        await buFetch(`/sessions/${sessionId}/stop`, {
          method: 'POST', apiKey, body: { strategy: 'task' },
        });
      } catch (e) {
        // Session might be gone — let the caller handle by creating a new one.
        if (e.status === 404) {
          return res.status(410).json({ error: 'session_gone', message: 'Session no longer exists' });
        }
      }
    }

    const buBody = {
      task: task + TASK_FORMAT_SUFFIX,
      keepAlive: true,
      proxyCountryCode,
      useProxy: true,
    };
    if (ws)        buBody.workspaceId = ws;
    if (profileId) buBody.profileId   = profileId;
    if (sessionId) buBody.sessionId   = sessionId;

    const data = await buFetch('/sessions', { method: 'POST', apiKey, body: buBody });
    const newSessionId = data?.id || data?.sessionId || sessionId;
    res.json({ ok: true, sessionId: newSessionId, workspaceId: ws, raw: data });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, body: e.body });
  }
});

// =========================================================================
// Per-session status / messages / stop / destroy
// =========================================================================
app.get('/api/session-result', async (req, res) => {
  const { sessionId, apiKey } = req.query;
  if (!apiKey)    return res.status(400).json({ error: 'Missing apiKey' });
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  try {
    const data = await buFetch(`/sessions/${sessionId}`, { apiKey });
    res.json({ sessionId, status: data.status, output: data.output ?? null, raw: data });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/session-messages', async (req, res) => {
  const { sessionId, apiKey, after } = req.query;
  if (!apiKey)    return res.status(400).json({ error: 'Missing apiKey' });
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  try {
    const qs = after ? `?after=${encodeURIComponent(after)}` : '';
    const data = await buFetch(`/sessions/${sessionId}/messages${qs}`, { apiKey });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/stop-task', async (req, res) => {
  const { sessionId, apiKey } = req.body || {};
  if (!apiKey)    return res.status(400).json({ error: 'Missing apiKey' });
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  try {
    await buFetch(`/sessions/${sessionId}/stop`, {
      method: 'POST', apiKey, body: { strategy: 'task' },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/destroy-session', async (req, res) => {
  const { sessionId, apiKey } = req.body || {};
  if (!apiKey)    return res.status(400).json({ error: 'Missing apiKey' });
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  try {
    await buFetch(`/sessions/${sessionId}`, { method: 'DELETE', apiKey });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// =========================================================================
// Listing endpoints (workspaces, profiles, active sessions)
// =========================================================================
app.get('/api/workspaces', async (req, res) => {
  const { apiKey } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  try {
    const data = await buFetch('/workspaces?pageSize=100', { apiKey });
    const items = (data.items || []).map(w => ({ id: w.id, name: w.name || w.id }));
    res.json({ items });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/profiles', async (req, res) => {
  const { apiKey } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  try {
    const data = await buFetch('/profiles?pageSize=100', { apiKey });
    const items = (data.items || []).map(p => ({ id: p.id, name: p.name || p.id }));
    res.json({ items });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// List BU sessions and filter to active ones (running/idle/created).
app.get('/api/bu-sessions', async (req, res) => {
  const { apiKey } = req.query;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  try {
    const data = await buFetch('/sessions?page_size=100', { apiKey });
    const items = data.items || data.sessions || [];
    const active = items.filter(s => ['running','idle','created'].includes(s.status));
    res.json({
      items: active.map(s => ({
        id: s.id,
        status: s.status,
        title: s.title || null,
        lastStepSummary: s.lastStepSummary || null,
        createdAt: s.createdAt,
        liveUrl: s.liveUrl,
        workspaceId: s.workspaceId,
      })),
      total: items.length,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// =========================================================================
// ElevenLabs TTS (server-side credentials only)
// =========================================================================
// Configure via env vars before starting:
//   ELEVENLABS_API_KEY=sk_...      (required for premium voice; falls back to browser voice if absent)
//   ELEVENLABS_VOICE_ID=...        (optional; defaults to Rachel)
const EL_KEY      = process.env.ELEVENLABS_API_KEY || '';
// Default voice: Adam (deep, mature American male) — pNInz6obpgDQGcFmaJgB.
// Override with ELEVENLABS_VOICE_ID env var.
const EL_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

// Tells the frontend whether to even attempt /api/tts and /api/stt.
app.get('/api/tts/available', (_req, res) => {
  res.json({ available: Boolean(EL_KEY) });
});
app.get('/api/voice/available', (_req, res) => {
  res.json({ tts: Boolean(EL_KEY), stt: Boolean(EL_KEY) });
});

// Speech-to-text via ElevenLabs Scribe v2.
// Client POSTs raw audio bytes with the original Content-Type header.
app.post('/api/stt', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
  if (!EL_KEY) return res.status(503).json({ error: 'STT not configured on server' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No audio body' });
  try {
    const ct = req.headers['content-type'] || 'audio/webm';
    const ext = ct.includes('mp4') ? 'm4a' : ct.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: ct }), 'audio.' + ext);
    form.append('model_id', 'scribe_v2');
    form.append('language_code', 'eng');
    form.append('tag_audio_events', 'false');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY },
      body: form,
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) {
      return res.status(r.status).json({
        error: 'ElevenLabs STT ' + r.status,
        detail: j?.detail?.message || j?.detail || j?.raw || text,
      });
    }
    res.json({ text: j.text || '', raw: j });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!EL_KEY) return res.status(503).json({ error: 'TTS not configured on server' });
  if (!text)   return res.status(400).json({ error: 'Missing text' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      let parsed; try { parsed = JSON.parse(err); } catch { parsed = null; }
      const reason = r.status === 401 ? 'invalid key' : r.status === 402 ? 'no credits' : 'http ' + r.status;
      return res.status(r.status).json({
        error: 'ElevenLabs ' + reason,
        detail: parsed?.detail?.message || parsed?.detail || err,
      });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Local dev — Vercel ignores this and uses the exported app instead.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5173;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`chain-ditto listening on http://localhost:${PORT}`);
  });
}

export default app;
