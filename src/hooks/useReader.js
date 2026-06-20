import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

const READING_TIME_LIMIT_MS = READING_TIME_LIMIT_SEC * 1000;
const TRANSITION_MS = 200;

export function useReader(passages, { onProgressUpdate, onAdvancePastEnd } = {}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [hardFlash, setHardFlash] = useState(false);
  const [actionsDisabled, setActionsDisabled] = useState(false);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);
  const passagesKeyRef = useRef('');
  const actionPendingRef = useRef(false);
  const passiveFiredRef = useRef(false);

  const passage = passages[currentIndex] ?? null;

  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    if (passagesKeyRef.current && passagesKeyRef.current !== key) {
      setCurrentIndex(0);
      setActiveChunkId(null);
      setMarginaliaOpen(false);
    }
    passagesKeyRef.current = key;
  }, [passages]);

  const resetMarginalia = useCallback(() => {
    setActiveChunkId(null);
    setMarginaliaOpen(false);
  }, []);

  const transitionTo = useCallback(
    (newIndex, direction) => {
      if (newIndex < 0 || newIndex >= passages.length || newIndex === currentIndex) return false;
      setTransitionDirection(direction);
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentIndex(newIndex);
        resetMarginalia();
        setIsTransitioning(false);
        setTransitionDirection(null);
      }, TRANSITION_MS);
      return true;
    },
    [currentIndex, passages.length, resetMarginalia],
  );

  const advanceToNext = useCallback(async () => {
    if (currentIndex + 1 < passages.length) {
      return transitionTo(currentIndex + 1, 'next');
    }
    if (!onAdvancePastEnd) return false;

    const added = await onAdvancePastEnd();
    if (!added) return false;

    setTransitionDirection('next');
    setIsTransitioning(true);
    setTimeout(() => {
      setCurrentIndex((i) => i + 1);
      resetMarginalia();
      setIsTransitioning(false);
      setTransitionDirection(null);
    }, TRANSITION_MS);
    return true;
  }, [currentIndex, onAdvancePastEnd, passages.length, resetMarginalia, transitionTo]);

  const releaseActionLock = useCallback(() => {
    actionPendingRef.current = false;
    setActionsDisabled(false);
  }, []);

  const beginAction = useCallback(() => {
    if (actionPendingRef.current) return false;
    actionPendingRef.current = true;
    setActionsDisabled(true);
    return true;
  }, []);

  const prevPassage = useCallback(() => {
    transitionTo(currentIndex - 1, 'prev');
  }, [currentIndex, transitionTo]);

  const showTranslation = useCallback(() => {
    setTranslationVisible(true);
    clearTimeout(translationTimerRef.current);
    translationTimerRef.current = setTimeout(() => {
      setTranslationVisible(false);
    }, 3500);
  }, []);

  const recordEncounter = useCallback(
    (signal) => {
      if (!passage) return;
      const timeOnPageMs = Date.now() - pageStartRef.current;
      const chunkIds = passage.chunks.map((c) => c.id);
      logEncounter({
        userId: USER_ID,
        chunkIds,
        passageId: passage.id,
        signal,
        timeOnPageMs,
      }).catch((err) => {
        console.error('[ERT] log_encounter failed:', err);
      });

      if (onProgressUpdate && (signal === 'got_it' || signal === 'still_hard')) {
        onProgressUpdate().catch((err) => {
          console.error('[ERT] progress refresh failed:', err);
        });
      }
    },
    [onProgressUpdate, passage],
  );

  const finishPassageAction = useCallback(
    async (signal) => {
      recordEncounter(signal);
      await advanceToNext();
    },
    [advanceToNext, recordEncounter],
  );

  const handleGotIt = useCallback(async () => {
    if (!beginAction()) return;
    try {
      await finishPassageAction('got_it');
      await new Promise((resolve) => setTimeout(resolve, TRANSITION_MS));
    } finally {
      releaseActionLock();
    }
  }, [beginAction, finishPassageAction, releaseActionLock]);

  const handleStillHard = useCallback(async () => {
    if (!beginAction()) return;
    try {
      await finishPassageAction('still_hard');
      setHardFlash(true);
      await new Promise((resolve) => setTimeout(resolve, 240));
      setHardFlash(false);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, TRANSITION_MS - 240)));
    } finally {
      releaseActionLock();
    }
  }, [beginAction, finishPassageAction, releaseActionLock]);

  const selectChunk = useCallback((chunkId) => {
    setActiveChunkId(chunkId);
    setMarginaliaOpen(true);
  }, []);

  const closeMarginalia = useCallback(() => {
    setMarginaliaOpen(false);
    setActiveChunkId(null);
  }, []);

  useEffect(() => {
    releaseActionLock();
  }, [currentIndex, releaseActionLock]);

  // Silent passive encounter after time limit (no UI)
  useEffect(() => {
    if (!passage) return undefined;
    pageStartRef.current = Date.now();
    passiveFiredRef.current = false;
    const timer = setTimeout(() => {
      if (!passiveFiredRef.current) {
        passiveFiredRef.current = true;
        recordEncounter('passive');
      }
    }, READING_TIME_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [currentIndex, passage, recordEncounter]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (actionPendingRef.current) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        advanceToNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevPassage();
      } else if (e.key === 'Escape') {
        closeMarginalia();
      } else if (e.key === 't' || e.key === 'T') {
        showTranslation();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [advanceToNext, closeMarginalia, prevPassage, showTranslation]);

  useEffect(() => {
    return () => clearTimeout(translationTimerRef.current);
  }, []);

  const activeChunk = passage?.chunks.find((c) => c.id === activeChunkId) ?? null;

  return {
    passage,
    currentIndex,
    activeChunkId,
    activeChunk,
    marginaliaOpen,
    isTransitioning,
    transitionDirection,
    translationVisible,
    hardFlash,
    actionsDisabled,
    prevPassage,
    advanceToNext,
    selectChunk,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
