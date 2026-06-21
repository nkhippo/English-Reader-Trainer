import { DEFAULT_GAS_URL } from './config.js';

const READ_ACTIONS = new Set(['session', 'due_chunks', 'generate_passage', 'stats']);
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** session / generate_passage can exceed 30s on cold GAS (measured ~40s). */
const SLOW_ACTION_TIMEOUT_MS = 90000;
const SLOW_ACTIONS = new Set(['session', 'generate_passage']);

function requestTimeoutMs(action) {
  return SLOW_ACTIONS.has(action) ? SLOW_ACTION_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

function isRequestTimeout(err) {
  return err?.name === 'TimeoutError'
    || (err?.name === 'AbortError' && /timed out/i.test(String(err?.message || err)));
}

function logActionRetry(method, action, err, nextMethod) {
  if (isRequestTimeout(err)) {
    console.info(`[ERT] ${method} ${action} timed out, retrying via ${nextMethod}`);
    return;
  }
  console.warn(`[ERT] ${method} ${action} failed, retrying via ${nextMethod}:`, err);
}

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
  if (data.status === 'ok' && data.service === 'english-reader-trainer' && !data.passages && action !== 'stats') {
    throw new Error(`GAS ${action} returned health check instead of payload`);
  }
  return data;
}

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`GAS request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function postAction(action, payload = {}) {
  const url = getGasUrl();
  if (!url) {
    console.warn('[ERT] GAS URL not configured — skipping API call:', action);
    return { ok: false, skipped: true };
  }

  const body = JSON.stringify({ action, ...payload });
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
    },
    requestTimeoutMs(action),
  );

  if (!res.ok) {
    throw new Error(`GAS ${action} failed: HTTP ${res.status}`);
  }

  return parseGasResponse(res, action);
}

/** GET — reliable for read actions against GAS Web App redirects. */
async function getAction(action, payload = {}) {
  const url = getGasUrl();
  if (!url) {
    console.warn('[ERT] GAS URL not configured — skipping API call:', action);
    return { ok: false, skipped: true };
  }

  const data = encodeURIComponent(JSON.stringify({ action, ...payload }));
  const res = await fetchWithTimeout(`${url}?data=${data}`, {}, requestTimeoutMs(action));

  if (!res.ok) {
    throw new Error(`GAS ${action} failed: HTTP ${res.status}`);
  }

  return parseGasResponse(res, action);
}

async function callAction(action, payload = {}) {
  if (READ_ACTIONS.has(action)) {
    try {
      return await getAction(action, payload);
    } catch (getErr) {
      logActionRetry('GET', action, getErr, 'POST');
      return postAction(action, payload);
    }
  }

  try {
    return await postAction(action, payload);
  } catch (postErr) {
    logActionRetry('POST', action, postErr, 'GET');
    return getAction(action, payload);
  }
}

export async function fetchSession({ userId, cefr }) {
  try {
    return await callAction('session', { user_id: userId, cefr });
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes('Unknown action')) throw err;

    const passageRes = await callAction('generate_passage', { user_id: userId, cefr });
    const statsRes = await callAction('stats', { user_id: userId, cefr });
    return { ...passageRes, ...statsRes };
  }
}

export async function fetchDueChunks({ userId, cefr, limit = 20 }) {
  return callAction('due_chunks', { user_id: userId, cefr, limit });
}

export async function fetchGeneratePassage({ userId, cefr, excludePassageIds = [] }) {
  return callAction('generate_passage', {
    user_id: userId,
    cefr,
    exclude_passage_ids: excludePassageIds,
  });
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
