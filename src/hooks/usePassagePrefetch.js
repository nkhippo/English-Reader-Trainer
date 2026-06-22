import { useCallback, useEffect, useRef } from 'react';
import { fetchGeneratePassage } from '../lib/api.js';
import { chunkIdsFromPassages } from '../lib/chunkIds.js';
import { PREFETCH_QUEUE_SIZE, USER_ID } from '../lib/config.js';
import { normalizePassagesFromApi } from '../lib/passages.js';

/**
 * Keep a queue of prefetched passages while the user reads.
 */
export function usePassagePrefetch({ cefrBand, seenPassageIds, seenPassages, enabled }) {
  const queueRef = useRef([]);
  const inflightRef = useRef(null);
  const bandRef = useRef(cefrBand);
  const seenRef = useRef([]);
  const passagesRef = useRef([]);

  const clearPrefetch = useCallback(() => {
    queueRef.current = [];
    inflightRef.current = null;
  }, []);

  const isSeen = useCallback((passage) => {
    if (!passage?.id) return true;
    return seenRef.current.includes(passage.id);
  }, []);

  const fetchNextPassage = useCallback(async (extraExclude = []) => {
    const exclude = new Set([...seenRef.current, ...extraExclude, ...queueRef.current.map((p) => p.id)]);
    const excludeChunkIds = chunkIdsFromPassages([
      ...passagesRef.current,
      ...queueRef.current,
    ]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await fetchGeneratePassage({
        userId: USER_ID,
        cefr: bandRef.current,
        excludePassageIds: [...exclude],
        excludeChunkIds,
      });
      const normalized = normalizePassagesFromApi(res.passages || []);
      const next = normalized[0] ?? null;
      if (!next) return null;
      if (!exclude.has(next.id)) return next;
      exclude.add(next.id);
    }

    return null;
  }, []);

  const fillQueue = useCallback(async () => {
    if (!enabled) return;

    while (queueRef.current.length < PREFETCH_QUEUE_SIZE && !inflightRef.current) {
      const band = bandRef.current;
      inflightRef.current = (async () => {
        try {
          const next = await fetchNextPassage();
          if (next && !isSeen(next) && bandRef.current === band) {
            const ids = new Set(queueRef.current.map((p) => p.id));
            if (!ids.has(next.id)) queueRef.current.push(next);
          }
        } catch (err) {
          console.warn('[ERT] prefetch failed:', err);
        } finally {
          inflightRef.current = null;
        }
      })();
      await inflightRef.current;
    }
  }, [enabled, fetchNextPassage, isSeen]);

  useEffect(() => {
    bandRef.current = cefrBand;
    clearPrefetch();
  }, [cefrBand, clearPrefetch]);

  useEffect(() => {
    seenRef.current = seenPassageIds || [];
    passagesRef.current = seenPassages || [];
    queueRef.current = queueRef.current.filter((p) => !seenRef.current.includes(p.id));
  }, [seenPassageIds, seenPassages]);

  useEffect(() => {
    if (!enabled || seenPassageIds.length === 0) return;
    fillQueue();
  }, [enabled, fillQueue, seenPassageIds]);

  /** Instant: take next prefetched passage without waiting on network. */
  const takeQueuedPassage = useCallback(() => {
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next?.id) continue;
      if (isSeen(next)) continue;
      fillQueue();
      return next;
    }
    return null;
  }, [fillQueue, isSeen]);

  const consumePrefetched = useCallback(async ({ maxWaitMs } = {}) => {
    const queued = takeQueuedPassage();
    if (queued) return queued;

    if (inflightRef.current) {
      if (maxWaitMs != null) {
        await Promise.race([
          inflightRef.current,
          new Promise((resolve) => { setTimeout(resolve, maxWaitMs); }),
        ]);
      } else {
        await inflightRef.current;
      }
      const afterInflight = takeQueuedPassage();
      if (afterInflight) return afterInflight;
    }

    // Advance path: never start a fresh GAS call here (too slow); local fallback handles it.
    if (maxWaitMs != null) return null;

    try {
      const next = await fetchNextPassage();
      fillQueue();
      return next && !isSeen(next) ? next : null;
    } catch (err) {
      console.error('[ERT] fetch next passage failed:', err);
      return null;
    }
  }, [fetchNextPassage, fillQueue, isSeen, takeQueuedPassage]);

  return { consumePrefetched, takeQueuedPassage, clearPrefetch, fillQueue };
}
