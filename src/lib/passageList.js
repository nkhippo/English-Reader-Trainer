import { flushSync } from 'react-dom';
import { withTimeout } from './async.js';
import { ADVANCE_GAS_TIMEOUT_MS } from './config.js';

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

async function tryTimedNetwork(promise, label, timeoutMs) {
  try {
    return await withTimeout(promise, timeoutMs, label);
  } catch (err) {
    console.warn(`[ERT] ${label}:`, err);
    return null;
  }
}

/**
 * Resolve and append the next passage from prefetch queue, brief GAS wait, or local fallback.
 * Returns the new index, or null when no unique passage could be loaded.
 */
export async function acquireNextPassageIndex({
  passagesRef,
  setPassages,
  takeQueuedPassage,
  consumePrefetched,
  pickLocal,
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

  // 2. Brief wait for in-flight prefetch only — do not start a new slow GAS call on advance.
  const prefetched = await tryTimedNetwork(
    consumePrefetched({ maxWaitMs: ADVANCE_GAS_TIMEOUT_MS }),
    'prefetch next passage',
    ADVANCE_GAS_TIMEOUT_MS + 500,
  );
  if (prefetched) {
    const idx = tryAppend(prefetched);
    if (idx >= 0) return idx;
  }

  // 3. Local templates — instant fallback; background prefetch continues for later pages.
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
