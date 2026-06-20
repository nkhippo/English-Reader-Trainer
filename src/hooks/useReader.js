import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { CLOZE_PROBABILITY, READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

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
  const [remainingSeconds, setRemainingSeconds] = useState(READING_TIME_LIMIT_SEC);
  const [clozeChunkId, setClozeChunkId] = useState(null);
  const [clozeRevealed, setClozeRevealed] = useState(false);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);
  const passagesKeyRef = useRef('');
  const actionPendingRef = useRef(false);
  const passiveFiredRef = useRef(false);
  const remainingSecondsRef = useRef(READING_TIME_LIMIT_SEC);

  const passage = passages[currentIndex] ?? null;

  const syncRemainingSeconds = useCallback((seconds) => {
    remainingSecondsRef.current = seconds;
    setRemainingSeconds(seconds);
  }, []);

  const resetPassiveTimer = useCallback(() => {
    pageStartRef.current = Date.now();
    passiveFiredRef.current = false;
    syncRemainingSeconds(READING_TIME_LIMIT_SEC);
  }, [syncRemainingSeconds]);

  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    if (passagesKeyRef.current && passagesKeyRef.current !== key) {
      setCurrentIndex(0);
      setActiveChunkId(null);
      setMarginaliaOpen(false);
    }
    passagesKeyRef.current = key;
  }, [passages]);

  // Occasional cloze blank on one target chunk (pillar 5 — light recall)
  useEffect(() => {
    if (!passage?.chunks?.length) {
      setClozeChunkId(null);
      setClozeRevealed(false);
      return;
    }
    if (Math.random() < CLOZE_PROBABILITY) {
      const pick = passage.chunks[Math.floor(Math.random() * passage.chunks.length)];
      setClozeChunkId(pick.id);
      setClozeRevealed(false);
    } else {
      setClozeChunkId(null);
      setClozeRevealed(false);
    }
  }, [currentIndex, passage]);

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

  const handleChunkClick = useCallback(
    (chunkId) => {
      if (chunkId === clozeChunkId && !clozeRevealed) {
        setClozeRevealed(true);
        return;
      }
      selectChunk(chunkId);
    },
    [clozeChunkId, clozeRevealed, selectChunk],
  );

  const closeMarginalia = useCallback(() => {
    setMarginaliaOpen(false);
    setActiveChunkId(null);
  }, []);

  useEffect(() => {
    releaseActionLock();
  }, [currentIndex, releaseActionLock]);

  // Countdown display + silent passive encounter at time limit (no forced navigation)
  useEffect(() => {
    if (!passage) return undefined;
    resetPassiveTimer();

    const tick = () => {
      const elapsed = Date.now() - pageStartRef.current;
      const remaining = Math.max(0, Math.ceil((READING_TIME_LIMIT_MS - elapsed) / 1000));
      syncRemainingSeconds(remaining);

      if (remaining === 0 && !passiveFiredRef.current) {
        passiveFiredRef.current = true;
        recordEncounter('passive');
      }
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [currentIndex, passage, recordEncounter, resetPassiveTimer, syncRemainingSeconds]);

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
    remainingSeconds,
    clozeChunkId,
    clozeRevealed,
    prevPassage,
    advanceToNext,
    selectChunk,
    handleChunkClick,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
