import { DEFAULT_GAS_URL } from './config.js';

function getGasUrl() {
  return import.meta.env.VITE_GAS_URL || DEFAULT_GAS_URL || localStorage.getItem('ert_gas_url') || '';
}

async function postAction(action, payload = {}) {
  const url = getGasUrl();
  if (!url) {
    console.warn('[ERT] GAS URL not configured — skipping API call:', action);
    return { ok: false, skipped: true };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action, ...payload }),
  });

  if (!res.ok) {
    throw new Error(`GAS ${action} failed: ${res.status}`);
  }

  return res.json();
}

export async function fetchDueChunks({ userId, cefr, limit = 20 }) {
  return postAction('due_chunks', { user_id: userId, cefr, limit });
}

export async function fetchGeneratePassage({ userId, cefr }) {
  return postAction('generate_passage', { user_id: userId, cefr });
}

export async function logEncounter({
  userId,
  chunkIds,
  passageId,
  signal,
  timeOnPageMs = 0,
}) {
  return postAction('log_encounter', {
    user_id: userId,
    chunk_ids: chunkIds,
    passage_id: passageId,
    signal,
    time_on_page_ms: timeOnPageMs,
  });
}

export function setGasUrl(url) {
  if (url) {
    localStorage.setItem('ert_gas_url', url);
  } else {
    localStorage.removeItem('ert_gas_url');
  }
}

export function getStoredGasUrl() {
  return getGasUrl();
}

export async function checkBackendHealth() {
  const url = getGasUrl();
  if (!url) {
    return { ok: false, error: 'GAS URL not configured' };
  }

  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.status === 'ok' && data.service === 'english-reader-trainer') {
      return { ok: true, phase: data.phase };
    }
    return { ok: false, error: 'Unexpected response' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
