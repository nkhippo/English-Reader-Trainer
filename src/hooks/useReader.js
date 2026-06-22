import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { logEncounter } from '../lib/api.js';
import { CLOZE_PROBABILITY, READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

const READING_TIME_LIMIT_MS = READING_TIME_LIMIT_SEC * 1000;
const TRANSITION_MS = 200;
const ACTION_LOCK_TIMEOUT_MS = 10000;
/** Keep processing UI visible long enough to notice (avoids sub-frame flash). */
const MIN_PROCESSING_MS = 400;

export function useReader(passages, { passagesRef, onProgressUpdate, onAdvancePastEnd, onBeforeAdvance } = {}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [actionsDisabled, setActionsDisabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [chunkEvaluations, setChunkEvaluations] = useState({});
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
  const actionStartedAtRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const currentIndexRef = useRef(0);
  const pauseAfterActionRef = useRef(false);
  const [pauseAfterAction, setPauseAfterAction] = useState(false);
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
      }

      setAwaitingStart(false);
      setIsPaused(false);
      setIsReadingStarted(true);
      setIsTimerRunning(true);
    },
    [syncRemainingSeconds],
  );

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    setChunkEvaluations({});
  }, [currentIndex]);

  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    const prevKey = passagesKeyRef.current;
    if (prevKey && prevKey !== key) {
      const isAppend = key.startsWith(`${prevKey}|`);
      if (!isAppend) {
        setCurrentIndex(0);
        currentIndexRef.current = 0;
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
      const shouldAutoStart = autoStart && !pauseAfterActionRef.current;
      if (shouldAutoStart) {
        activateTimer();
      } else {
        resetReadingTimer();
        if (pauseAfterActionRef.current) {
          setIsPaused(true);
        }
      }
    },
    [activateTimer, resetMarginalia, resetReadingTimer],
  );

  const forceGoToIndex = useCallback(
    (newIndex, autoStart) => {
      const count = passageCount();
      if (newIndex < 0 || newIndex >= count) return false;
      flushSync(() => {
        setCurrentIndex(newIndex);
        currentIndexRef.current = newIndex;
      });
      applyAfterTransition(autoStart);
      return true;
    },
    [applyAfterTransition, passageCount],
  );

  const transitionTo = useCallback(
    (newIndex, direction, { autoStart = false } = {}) => {
      const count = passageCount();
      const fromIndex = currentIndexRef.current;
      if (newIndex < 0 || newIndex >= count || newIndex === fromIndex) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        setTransitionDirection(direction);
        setIsTransitioning(true);
        setTimeout(() => {
          setCurrentIndex(newIndex);
          currentIndexRef.current = newIndex;
          applyAfterTransition(autoStart);
          setIsTransitioning(false);
          setTransitionDirection(null);
          resolve(true);
        }, TRANSITION_MS);
      });
    },
    [applyAfterTransition, passageCount],
  );

  const advanceToNextInternal = useCallback(
    async ({ autoStart = false } = {}) => {
      const fromIndex = currentIndexRef.current;
      const count = passageCount();

      if (fromIndex + 1 < count) {
        return transitionTo(fromIndex + 1, 'next', { autoStart });
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

      const transitioned = await transitionTo(nextIndex, 'next', { autoStart });
      if (transitioned) return true;

      if (nextIndex < passageCount() && nextIndex !== currentIndexRef.current) {
        console.warn('[ERT] transition failed — forcing navigation to index', nextIndex);
        return forceGoToIndex(nextIndex, autoStart);
      }
      return false;
    },
    [forceGoToIndex, onAdvancePastEnd, passageCount, resetReadingTimer, transitionTo],
  );

  const advanceToNext = useCallback(
    async (opts = {}) => {
      if (!opts.internal && actionPendingRef.current) return false;
      return advanceToNextInternal(opts);
    },
    [advanceToNextInternal],
  );

  const releaseActionLock = useCallback(() => {
    clearTimeout(actionLockTimerRef.current);
    actionLockTimerRef.current = null;
    actionPendingRef.current = false;
    setActionsDisabled(false);
    setIsSaving(false);
  }, []);

  const recoverFromActionTimeout = useCallback(
    (gen) => {
      if (actionGenerationRef.current !== gen) return;
      console.warn('[ERT] action lock timed out — recovering');
      actionGenerationRef.current += 1;
      releaseActionLock();
      activateTimer({ resume: true });
    },
    [activateTimer, releaseActionLock],
  );

  const beginAction = useCallback(() => {
    if (actionPendingRef.current) return false;
    if (!passage?.id) return false;
    const gen = actionGenerationRef.current + 1;
    actionGenerationRef.current = gen;
    actionPendingRef.current = true;
    actionStartedAtRef.current = Date.now();
    flushSync(() => {
      setActionsDisabled(true);
      setIsSaving(true);
    });
    clearTimeout(actionLockTimerRef.current);
    actionLockTimerRef.current = setTimeout(() => {
      recoverFromActionTimeout(gen);
    }, ACTION_LOCK_TIMEOUT_MS);
    return true;
  }, [passage, recoverFromActionTimeout]);

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

  const recordExposure = useCallback(
    async () => {
      if (!passage) return;
      const timeOnPageMs = isReadingStarted ? Date.now() - pageStartRef.current : 0;
      await logEncounter({
        userId: USER_ID,
        chunkIds: passage.chunks.map((c) => c.id),
        passageId: passage.id,
        signal: 'exposure',
        timeOnPageMs,
      }).catch((err) => {
        console.error('[ERT] log_encounter (exposure) failed:', err);
      });
    },
    [isReadingStarted, passage],
  );

  const evaluateChunk = useCallback(
    async (chunkId, signal) => {
      if (!passage || chunkEvaluations[chunkId]) return false;
      const timeOnPageMs = isReadingStarted ? Date.now() - pageStartRef.current : 0;
      await logEncounter({
        userId: USER_ID,
        chunkId,
        passageId: passage.id,
        signal,
        timeOnPageMs,
      }).catch((err) => {
        console.error('[ERT] log_encounter failed:', err);
      });

      setChunkEvaluations((prev) => ({ ...prev, [chunkId]: signal }));
      setMarginaliaOpen(false);
      setActiveChunkId(null);

      if (onProgressUpdate) {
        await onProgressUpdate().catch((err) => {
          console.error('[ERT] progress refresh failed:', err);
        });
      }
      return true;
    },
    [chunkEvaluations, isReadingStarted, onProgressUpdate, passage],
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

  const finishNextAction = useCallback(
    async () => {
      const gen = actionGenerationRef.current;
      stopTimer();
      resetMarginalia();
      await recordExposure();
      onBeforeAdvance?.();
      try {
        let advanced = false;
        for (let attempt = 0; attempt < 2 && !advanced; attempt += 1) {
          if (actionGenerationRef.current !== gen) break;
          advanced = await advanceToNextInternal({ autoStart: true });
          if (!advanced && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        if (actionGenerationRef.current === gen && !advanced) {
          console.warn('[ERT] could not advance to next passage');
          if (pauseAfterActionRef.current) {
            setIsPaused(true);
            setAwaitingStart(true);
            setIsReadingStarted(false);
            setIsTimerRunning(false);
          } else {
            activateTimer({ resume: true });
          }
        }
      } finally {
        if (actionGenerationRef.current !== gen) return;
        pauseAfterActionRef.current = false;
        setPauseAfterAction(false);
        const waitMs = MIN_PROCESSING_MS - (Date.now() - actionStartedAtRef.current);
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        if (actionGenerationRef.current !== gen) return;
        releaseActionLock();
      }
    },
    [
      activateTimer,
      advanceToNextInternal,
      onBeforeAdvance,
      recordExposure,
      releaseActionLock,
      resetMarginalia,
      stopTimer,
    ],
  );

  const handleNext = useCallback(async () => {
    if (actionPendingRef.current || !canInteract) return;
    if (!beginAction()) return;
    try {
      await finishNextAction();
    } catch (err) {
      console.error('[ERT] next failed:', err);
      releaseActionLock();
    }
  }, [beginAction, canInteract, finishNextAction, releaseActionLock]);

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
    return () => clearTimeout(actionLockTimerRef.current);
  }, []);

  // Countdown display only — no encounter logging at time limit
  useEffect(() => {
    if (!isTimerRunning || !passage) return undefined;

    const tick = () => {
      const elapsed = Date.now() - pageStartRef.current;
      const remaining = Math.max(0, Math.ceil((READING_TIME_LIMIT_MS - elapsed) / 1000));
      syncRemainingSeconds(remaining);
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [currentIndex, isTimerRunning, passage, syncRemainingSeconds]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (actionPendingRef.current || !canInteract) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        handleNext();
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
  }, [canInteract, closeMarginalia, handleNext, prevPassage, showTranslation]);

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
    actionsDisabled,
    isSaving,
    pauseAfterAction,
    chunkEvaluations,
    awaitingStart,
    isPaused,
    isReadingStarted,
    remainingSeconds,
    clozeChunkId,
    clozeRevealed,
    startReading,
    pauseReading,
    prevPassage,
    handleNext,
    selectChunk,
    handleChunkClick,
    closeMarginalia,
    showTranslation,
    evaluateChunk,
  };
}
