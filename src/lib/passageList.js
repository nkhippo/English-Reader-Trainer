import { flushSync } from 'react-dom';

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
export async function acquireNextPassageIndex({
  passagesRef,
  setPassages,
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

  const sources = [
    () => consumePrefetched(),
    () => pickLocal(seenIds()),
    () => fetchRemote(seenIds()),
  ];

  for (const source of sources) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const next = await source();
        if (!next) break;
        const idx = tryAppend(next);
        if (idx >= 0) return idx;
      } catch (err) {
        console.warn('[ERT] next passage source failed:', err);
        break;
      }
    }
  }

  return null;
}
