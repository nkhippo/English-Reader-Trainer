import { flushSync } from 'react-dom';
import { withTimeout } from './async.js';

/** Network passage fetch must finish before the action-lock safety timeout. */
const NETWORK_PASSAGE_TIMEOUT_MS = 8000;

/** Append a passage and flush React state so navigation can read it immediately. */
export function appendPassageSync(setPassages, passagesRef, next) {
  if (!next?.id) return -1;
  if (passagesRef.current.some((p) => p.id === next.id)) return -1;

  let newIndex = -1;
  flushSync(() => {
    setPassages((prev) => {
      if (prev.some((p) => p.id === next.id)) return prev;
      const updated = [...prev, next];
      passagesRef.current = updated;
      newIndex = updated.length - 1;
      return updated;
    });
  });
  return newIndex;
}

/**
 * Resolve and append the next passage from prefetch, local templates, or GAS.
 * Returns the new index, or null when no unique passage could be loaded.
 */
async function tryTimedNetwork(promise, label) {
  try {
    return await withTimeout(promise, NETWORK_PASSAGE_TIMEOUT_MS, label);
  } catch (err) {
    console.warn(`[ERT] ${label}:`, err);
    return null;
  }
}

export async function acquireNextPassageIndex({
  passagesRef,
  setPassages,
  takeQueuedPassage,
  consumePrefetched,
  pickLocal,
  fetchRemote,
  fillQueue,
}) {
  const seenIds = () => passagesRef.current.map((p) => p.id);

  const tryAppend = (next) => {
    const idx = appendPassageSync(setPassages, passagesRef, next);
    if (idx >= 0) fillQueue?.();
    return idx;
  };

  // 1. Instant: passage already in the prefetch queue (SRS-driven from GAS).
  const queued = takeQueuedPassage?.() ?? null;
  if (queued) {
    const idx = tryAppend(queued);
    if (idx >= 0) return idx;
  }

  // 2. Timed network prefetch — due/new chunks from GAS hybrid pipeline.
  const prefetched = await tryTimedNetwork(
    consumePrefetched(),
    'prefetch next passage',
  );
  if (prefetched) {
    const idx = tryAppend(prefetched);
    if (idx >= 0) return idx;
  }

  // 3. Timed remote fetch when prefetch queue is empty.
  const remote = await tryTimedNetwork(
    fetchRemote(seenIds()),
    'remote next passage',
  );
  if (remote) {
    const idx = tryAppend(remote);
    if (idx >= 0) return idx;
  }

  // 4. Local templates — offline / GAS timeout fallback only.
  try {
    const local = await pickLocal(seenIds());
    if (local) {
      const idx = tryAppend(local);
      if (idx >= 0) return idx;
    }
  } catch (err) {
    console.warn('[ERT] local passage pick failed:', err);
  }

  return null;
}
