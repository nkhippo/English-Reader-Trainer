import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { CLOZE_PROBABILITY, READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

const READING_TIME_LIMIT_MS = READING_TIME_LIMIT_SEC * 1000;
const TRANSITION_MS = 200;
const ACTION_LOCK_TIMEOUT_MS = 12000;

export function useReader(passages, { passagesRef, onProgressUpdate, onAdvancePastEnd } = {}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [hardFlash, setHardFlash] = useState(false);
  const [actionsDisabled, setActionsDisabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [awaitingStart, setAwaitingStart] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [isReadingStarted, setIsReadingStarted] = useState(false);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(READING_TIME_LIMIT_SEC);
  const [clozeChunkId, setClozeChunkId] = useState(null);
  const [clozeRevealed, setClozeRevealed] = useState(false);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);
  const passagesKeyRef = useRef('');
  const actionPendingRef = useRef(false);
  const actionLockTimerRef = useRef(null);
  const pauseAfterActionRef = useRef(false);
  const [pauseAfterAction, setPauseAfterAction] = useState(false);
  const passiveFiredRef = useRef(false);
  const remainingSecondsRef = useRef(READING_TIME_LIMIT_SEC);

  const passage = passages[currentIndex] ?? null;
  const canInteract = isReadingStarted && !awaitingStart && !isPaused;

  const passageCount = useCallback(
    () => passagesRef?.current?.length ?? passages.length,
    [passages.length, passagesRef],
  );

  const syncRemainingSeconds = useCallback((seconds) => {
    remainingSecondsRef.current = seconds;
    setRemainingSeconds(seconds);
  }, []);

  const resetReadingTimer = useCallback(() => {
    setAwaitingStart(true);
    setIsPaused(false);
    setIsReadingStarted(false);
    setIsTimerRunning(false);
    syncRemainingSeconds(READING_TIME_LIMIT_SEC);
    passiveFiredRef.current = false;
  }, [syncRemainingSeconds]);

  const stopTimer = useCallback(() => {
    setIsTimerRunning(false);
  }, []);

  const activateTimer = useCallback(
    ({ resume = false } = {}) => {
      if (resume) {
        const remaining = remainingSecondsRef.current;
        pageStartRef.current = Date.now() - (READING_TIME_LIMIT_SEC - remaining) * 1000;
      } else {
        pageStartRef.current = Date.now();
        syncRemainingSeconds(READING_TIME_LIMIT_SEC);
        passiveFiredRef.current = false;
      }

      setAwaitingStart(false);
      setIsPaused(false);
      setIsReadingStarted(true);
      setIsTimerRunning(true);
    },
    [syncRemainingSeconds],
  );

  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    const prevKey = passagesKeyRef.current;
    if (prevKey && prevKey !== key) {
      const isAppend = key.startsWith(`${prevKey}|`);
      if (!isAppend) {
        setCurrentIndex(0);
        setActiveChunkId(null);
        setMarginaliaOpen(false);
        resetReadingTimer();
      }
    }
    passagesKeyRef.current = key;
  }, [passages, resetReadingTimer]);

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

  const applyAfterTransition = useCallback(
    (autoStart) => {
      resetMarginalia();
      if (autoStart) {
        activateTimer();
      } else {
        resetReadingTimer();
      }
    },
    [activateTimer, resetMarginalia, resetReadingTimer],
  );

  const transitionTo = useCallback(
    (newIndex, direction, { autoStart = false } = {}) => {
      const count = passageCount();
      if (newIndex < 0 || newIndex >= count || newIndex === currentIndex) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        setTransitionDirection(direction);
        setIsTransitioning(true);
        setTimeout(() => {
          setCurrentIndex(newIndex);
          applyAfterTransition(autoStart);
          setIsTransitioning(false);
          setTransitionDirection(null);
          resolve(true);
        }, TRANSITION_MS);
      });
    },
    [applyAfterTransition, currentIndex, passageCount],
  );

  const advanceToNext = useCallback(
    async ({ autoStart = false } = {}) => {
      if (currentIndex + 1 < passageCount()) {
        return transitionTo(currentIndex + 1, 'next', { autoStart });
      }
      if (!onAdvancePastEnd) {
        if (!autoStart) resetReadingTimer();
        return false;
      }

      const nextIndex = await onAdvancePastEnd();
      if (nextIndex == null || nextIndex < 0) {
        if (!autoStart) resetReadingTimer();
        return false;
      }

      return transitionTo(nextIndex, 'next', { autoStart });
    },
    [currentIndex, onAdvancePastEnd, passageCount, resetReadingTimer, transitionTo],
  );

  const releaseActionLock = useCallback(() => {
    clearTimeout(actionLockTimerRef.current);
    actionLockTimerRef.current = null;
    actionPendingRef.current = false;
    setActionsDisabled(false);
    setIsSaving(false);
  }, []);

  const beginAction = useCallback(() => {
    if (actionPendingRef.current) return false;
    actionPendingRef.current = true;
    setActionsDisabled(true);
    setIsSaving(true);
    clearTimeout(actionLockTimerRef.current);
    actionLockTimerRef.current = setTimeout(() => {
      console.warn('[ERT] action lock timed out — releasing overlay');
      releaseActionLock();
    }, ACTION_LOCK_TIMEOUT_MS);
    return true;
  }, [releaseActionLock]);

  const prevPassage = useCallback(() => {
    transitionTo(currentIndex - 1, 'prev');
  }, [currentIndex, transitionTo]);

  const showTranslation = useCallback(() => {
    if (!canInteract) return;
    setTranslationVisible(true);
    clearTimeout(translationTimerRef.current);
    translationTimerRef.current = setTimeout(() => {
      setTranslationVisible(false);
    }, 3500);
  }, [canInteract]);

  const recordEncounter = useCallback(
    (signal) => {
      if (!passage) return;
      const timeOnPageMs = isReadingStarted ? Date.now() - pageStartRef.current : 0;
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
    [isReadingStarted, onProgressUpdate, passage],
  );

  const startReading = useCallback(
    ({ resume = false } = {}) => {
      activateTimer({ resume });
    },
    [activateTimer],
  );

  const pauseReading = useCallback(() => {
    if (actionPendingRef.current) {
      pauseAfterActionRef.current = true;
      setPauseAfterAction(true);
      return;
    }
    if (!canInteract || !isTimerRunning) return;
    stopTimer();
    setIsPaused(true);
    setAwaitingStart(true);
  }, [canInteract, isTimerRunning, stopTimer]);

  const finishPassageAction = useCallback(
    async (signal) => {
      stopTimer();
      resetMarginalia();
      recordEncounter(signal);
      const autoStart = !pauseAfterActionRef.current;
      let advanced = false;
      try {
        advanced = await advanceToNext({ autoStart });
      } finally {
        pauseAfterActionRef.current = false;
        setPauseAfterAction(false);
      }
      if (!advanced) {
        releaseActionLock();
        activateTimer({ resume: true });
      }
    },
    [activateTimer, advanceToNext, recordEncounter, releaseActionLock, resetMarginalia, stopTimer],
  );

  const handleGotIt = useCallback(async () => {
    if (!canInteract || !beginAction()) return;
    try {
      await finishPassageAction('got_it');
    } catch (err) {
      console.error('[ERT] got_it failed:', err);
      releaseActionLock();
    }
  }, [beginAction, canInteract, finishPassageAction, releaseActionLock]);

  const handleStillHard = useCallback(async () => {
    if (!canInteract || !beginAction()) return;
    try {
      await finishPassageAction('still_hard');
    } catch (err) {
      console.error('[ERT] still_hard failed:', err);
      releaseActionLock();
    }
    setHardFlash(true);
    await new Promise((resolve) => setTimeout(resolve, 240));
    setHardFlash(false);
  }, [beginAction, canInteract, finishPassageAction, releaseActionLock]);

  const selectChunk = useCallback(
    (chunkId) => {
      if (!canInteract) return;
      setActiveChunkId(chunkId);
      setMarginaliaOpen(true);
    },
    [canInteract],
  );

  const handleChunkClick = useCallback(
    (chunkId) => {
      if (!canInteract) return;
      if (chunkId === clozeChunkId && !clozeRevealed) {
        setClozeRevealed(true);
        return;
      }
      selectChunk(chunkId);
    },
    [canInteract, clozeChunkId, clozeRevealed, selectChunk],
  );

  const closeMarginalia = useCallback(() => {
    setMarginaliaOpen(false);
    setActiveChunkId(null);
  }, []);

  useEffect(() => {
    releaseActionLock();
  }, [currentIndex, releaseActionLock]);

  useEffect(() => {
    return () => clearTimeout(actionLockTimerRef.current);
  }, []);

  // Countdown display + silent passive encounter at time limit
  useEffect(() => {
    if (!isTimerRunning || !passage) return undefined;

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
  }, [currentIndex, isTimerRunning, passage, recordEncounter, syncRemainingSeconds]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (actionPendingRef.current || !canInteract) return;
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
  }, [advanceToNext, canInteract, closeMarginalia, prevPassage, showTranslation]);

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
    isSaving,
    pauseAfterAction,
    awaitingStart,
    isPaused,
    isReadingStarted,
    remainingSeconds,
    clozeChunkId,
    clozeRevealed,
    startReading,
    pauseReading,
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
