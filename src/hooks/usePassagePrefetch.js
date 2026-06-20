import { useCallback, useEffect, useRef } from 'react';
import { fetchGeneratePassage } from '../lib/api.js';
import { normalizePassagesFromApi } from '../lib/passages.js';
import { USER_ID } from '../lib/config.js';

/**
 * Prefetch the next passage in the background while the user reads the current one.
 */
export function usePassagePrefetch({ cefrBand, currentPassageId, enabled }) {
  const prefetchedRef = useRef(null);
  const inflightRef = useRef(null);
  const bandRef = useRef(cefrBand);

  const clearPrefetch = useCallback(() => {
    prefetchedRef.current = null;
    inflightRef.current = null;
  }, []);

  const prefetchNext = useCallback(async () => {
    if (!enabled || prefetchedRef.current || inflightRef.current) return;

    const band = bandRef.current;
    inflightRef.current = (async () => {
      try {
        const res = await fetchGeneratePassage({ userId: USER_ID, cefr: band });
        const normalized = normalizePassagesFromApi(res.passages || []);
        if (normalized[0] && bandRef.current === band) {
          prefetchedRef.current = normalized[0];
        }
      } catch (err) {
        console.warn('[ERT] prefetch failed:', err);
      } finally {
        inflightRef.current = null;
      }
    })();

    await inflightRef.current;
  }, [enabled]);

  useEffect(() => {
    bandRef.current = cefrBand;
    clearPrefetch();
  }, [cefrBand, clearPrefetch]);

  useEffect(() => {
    if (!enabled || !currentPassageId) return;
    prefetchNext();
  }, [currentPassageId, enabled, prefetchNext]);

  const consumePrefetched = useCallback(async () => {
    if (prefetchedRef.current) {
      const next = prefetchedRef.current;
      prefetchedRef.current = null;
      prefetchNext();
      return next;
    }

    if (inflightRef.current) {
      await inflightRef.current;
      if (prefetchedRef.current) {
        const next = prefetchedRef.current;
        prefetchedRef.current = null;
        prefetchNext();
        return next;
      }
    }

    try {
      const res = await fetchGeneratePassage({ userId: USER_ID, cefr: bandRef.current });
      const normalized = normalizePassagesFromApi(res.passages || []);
      prefetchNext();
      return normalized[0] ?? null;
    } catch (err) {
      console.error('[ERT] fetch next passage failed:', err);
      return null;
    }
  }, [prefetchNext]);

  return { consumePrefetched, clearPrefetch };
}
