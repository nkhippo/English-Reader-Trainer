import { DEFAULT_GAS_URL } from './config.js';

function getGasUrl() {
  return import.meta.env.VITE_GAS_URL || DEFAULT_GAS_URL;
}

async function parseGasResponse(res, action) {
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`GAS ${action} returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function postAction(action, payload = {}) {
  const url = getGasUrl();
  if (!url) {
    console.warn('[ERT] GAS URL not configured — skipping API call:', action);
    return { ok: false, skipped: true };
  }

  const body = JSON.stringify({ action, ...payload });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
  });

  if (!res.ok) {
    throw new Error(`GAS ${action} failed: HTTP ${res.status}`);
  }

  return parseGasResponse(res, action);
}

/** GET fallback — reliable when GAS POST redirect loses the body. */
async function getAction(action, payload = {}) {
  const url = getGasUrl();
  if (!url) {
    console.warn('[ERT] GAS URL not configured — skipping API call:', action);
    return { ok: false, skipped: true };
  }

  const data = encodeURIComponent(JSON.stringify({ action, ...payload }));
  const res = await fetch(`${url}?data=${data}`);

  if (!res.ok) {
    throw new Error(`GAS ${action} failed: HTTP ${res.status}`);
  }

  return parseGasResponse(res, action);
}

async function callAction(action, payload = {}) {
  try {
    return await postAction(action, payload);
  } catch (postErr) {
    console.warn(`[ERT] POST ${action} failed, retrying via GET:`, postErr);
    return getAction(action, payload);
  }
}

export async function fetchDueChunks({ userId, cefr, limit = 20 }) {
  return callAction('due_chunks', { user_id: userId, cefr, limit });
}

export async function fetchGeneratePassage({ userId, cefr }) {
  return callAction('generate_passage', { user_id: userId, cefr });
}

export async function logEncounter({
  userId,
  chunkIds,
  passageId,
  signal,
  timeOnPageMs = 0,
}) {
  return callAction('log_encounter', {
    user_id: userId,
    chunk_ids: chunkIds,
    passage_id: passageId,
    signal,
    time_on_page_ms: timeOnPageMs,
  });
}

export async function fetchStats({ userId, cefr }) {
  return callAction('stats', { user_id: userId, cefr });
}

export async function updateProgress({ userId, chunkIds, passageId, signal }) {
  return callAction('update_progress', {
    user_id: userId,
    chunk_ids: chunkIds,
    passage_id: passageId,
    signal,
  });
}
