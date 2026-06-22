import { useCallback, useEffect, useRef } from 'react';
import { fetchGeneratePassage } from '../lib/api.js';
import { chunkIdsFromPassages } from '../lib/chunkIds.js';
import { PREFETCH_QUEUE_SIZE, USER_ID } from '../lib/config.js';
import { normalizePassagesFromApi } from '../lib/passages.js';

/**
 * Keep a queue of prefetched passages while the user reads.
 */
export function usePassagePrefetch({
  cefrBand,
  seenPassageIds,
  seenPassages,
  getExcludeChunkIds,
  enabled,
}) {
  const queueRef = useRef([]);
  const inflightRef = useRef(null);
  const prefetchGenerationRef = useRef(0);
  const bandRef = useRef(cefrBand);
  const seenRef = useRef([]);
  const passagesRef = useRef([]);

  const clearPrefetch = useCallback(() => {
    prefetchGenerationRef.current += 1;
    queueRef.current = [];
    inflightRef.current = null;
  }, []);

  const isSeen = useCallback((passage) => {
    if (!passage?.id) return true;
    return seenRef.current.includes(passage.id);
  }, []);

  const sharesSessionChunks = useCallback((passage) => {
    const exclude = new Set([
      ...chunkIdsFromPassages(passagesRef.current),
      ...(getExcludeChunkIds?.() || []),
    ]);
    if (!exclude.size) return false;
    return (passage?.chunks || []).some((c) => exclude.has(c.id));
  }, [getExcludeChunkIds]);

  const fetchNextPassage = useCallback(async (extraExclude = []) => {
    const generation = prefetchGenerationRef.current;
    const exclude = new Set([...seenRef.current, ...extraExclude, ...queueRef.current.map((p) => p.id)]);
    const excludeChunkIds = [
      ...new Set([
        ...chunkIdsFromPassages([...passagesRef.current, ...queueRef.current]),
        ...(getExcludeChunkIds?.() || []),
      ]),
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (generation !== prefetchGenerationRef.current) return null;

      const res = await fetchGeneratePassage({
        userId: USER_ID,
        cefr: bandRef.current,
        excludePassageIds: [...exclude],
        excludeChunkIds,
      });
      const normalized = normalizePassagesFromApi(res.passages || []);
      const next = normalized[0] ?? null;
      if (!next) return null;
      if (exclude.has(next.id) || sharesSessionChunks(next)) {
        exclude.add(next.id);
        continue;
      }
      return next;
    }

    return null;
  }, [getExcludeChunkIds, sharesSessionChunks]);

  const fillQueue = useCallback(async () => {
    if (!enabled) return;

    while (queueRef.current.length < PREFETCH_QUEUE_SIZE && !inflightRef.current) {
      const band = bandRef.current;
      const generation = prefetchGenerationRef.current;
      inflightRef.current = (async () => {
        try {
          const next = await fetchNextPassage();
          if (
            generation === prefetchGenerationRef.current
            && next
            && !isSeen(next)
            && !sharesSessionChunks(next)
            && bandRef.current === band
          ) {
            const ids = new Set(queueRef.current.map((p) => p.id));
            if (!ids.has(next.id)) queueRef.current.push(next);
          }
        } catch (err) {
          console.warn('[ERT] prefetch failed:', err);
        } finally {
          if (generation === prefetchGenerationRef.current) {
            inflightRef.current = null;
          }
        }
      })();
      await inflightRef.current;
    }
  }, [enabled, fetchNextPassage, isSeen, sharesSessionChunks]);

  useEffect(() => {
    bandRef.current = cefrBand;
    clearPrefetch();
  }, [cefrBand, clearPrefetch]);

  useEffect(() => {
    seenRef.current = seenPassageIds || [];
    passagesRef.current = seenPassages || [];
    queueRef.current = queueRef.current.filter(
      (p) => !seenRef.current.includes(p.id) && !sharesSessionChunks(p),
    );
  }, [seenPassageIds, seenPassages, sharesSessionChunks]);

  useEffect(() => {
    if (!enabled || seenPassageIds.length === 0) return;
    fillQueue();
  }, [enabled, fillQueue, seenPassageIds]);

  /** Instant: take next prefetched passage without waiting on network. */
  const takeQueuedPassage = useCallback(() => {
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next?.id) continue;
      if (isSeen(next) || sharesSessionChunks(next)) continue;
      fillQueue();
      return next;
    }
    return null;
  }, [fillQueue, isSeen, sharesSessionChunks]);

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
      return next && !isSeen(next) && !sharesSessionChunks(next) ? next : null;
    } catch (err) {
      console.error('[ERT] fetch next passage failed:', err);
      return null;
    }
  }, [fetchNextPassage, fillQueue, isSeen, sharesSessionChunks, takeQueuedPassage]);

  return { consumePrefetched, takeQueuedPassage, clearPrefetch, fillQueue };
}
