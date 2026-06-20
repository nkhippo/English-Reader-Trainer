import { useCallback, useEffect, useRef } from 'react';
import { fetchGeneratePassage } from '../lib/api.js';
import { normalizePassagesFromApi } from '../lib/passages.js';
import { USER_ID } from '../lib/config.js';

/**
 * Prefetch the next passage in the background while the user reads the current one.
 */
export function usePassagePrefetch({ cefrBand, seenPassageIds, enabled }) {
  const prefetchedRef = useRef(null);
  const inflightRef = useRef(null);
  const bandRef = useRef(cefrBand);
  const seenRef = useRef([]);

  const clearPrefetch = useCallback(() => {
    prefetchedRef.current = null;
    inflightRef.current = null;
  }, []);

  const isSeen = useCallback((passage) => {
    if (!passage?.id) return true;
    return seenRef.current.includes(passage.id);
  }, []);

  const fetchNextPassage = useCallback(async (extraExclude = []) => {
    const exclude = new Set([...seenRef.current, ...extraExclude]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetchGeneratePassage({
        userId: USER_ID,
        cefr: bandRef.current,
        excludePassageIds: [...exclude],
      });
      const normalized = normalizePassagesFromApi(res.passages || []);
      const next = normalized[0] ?? null;
      if (!next) return null;
      if (!exclude.has(next.id)) return next;
      exclude.add(next.id);
    }

    return null;
  }, []);

  const prefetchNext = useCallback(async () => {
    if (!enabled || prefetchedRef.current || inflightRef.current) return;

    const band = bandRef.current;
    inflightRef.current = (async () => {
      try {
        const next = await fetchNextPassage();
        if (next && !isSeen(next) && bandRef.current === band) {
          prefetchedRef.current = next;
        }
      } catch (err) {
        console.warn('[ERT] prefetch failed:', err);
      } finally {
        inflightRef.current = null;
      }
    })();

    await inflightRef.current;
  }, [enabled, fetchNextPassage, isSeen]);

  useEffect(() => {
    bandRef.current = cefrBand;
    clearPrefetch();
  }, [cefrBand, clearPrefetch]);

  useEffect(() => {
    seenRef.current = seenPassageIds || [];
  }, [seenPassageIds]);

  useEffect(() => {
    if (!enabled || seenPassageIds.length === 0) return;
    if (prefetchedRef.current && isSeen(prefetchedRef.current)) {
      prefetchedRef.current = null;
    }
    prefetchNext();
  }, [enabled, isSeen, prefetchNext, seenPassageIds]);

  const consumePrefetched = useCallback(async () => {
    const takeNext = async (candidate) => {
      if (!candidate || isSeen(candidate)) {
        return fetchNextPassage([candidate?.id].filter(Boolean));
      }
      return candidate;
    };

    if (prefetchedRef.current) {
      const next = await takeNext(prefetchedRef.current);
      prefetchedRef.current = null;
      prefetchNext();
      return next && !isSeen(next) ? next : takeNext(null);
    }

    if (inflightRef.current) {
      await inflightRef.current;
      if (prefetchedRef.current) {
        const next = await takeNext(prefetchedRef.current);
        prefetchedRef.current = null;
        prefetchNext();
        return next && !isSeen(next) ? next : takeNext(null);
      }
    }

    try {
      const next = await takeNext(null);
      prefetchNext();
      return next && !isSeen(next) ? next : null;
    } catch (err) {
      console.error('[ERT] fetch next passage failed:', err);
      return null;
    }
  }, [fetchNextPassage, isSeen, prefetchNext]);

  return { consumePrefetched, clearPrefetch };
}
