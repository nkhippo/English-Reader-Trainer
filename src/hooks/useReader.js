import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

const READING_TIME_LIMIT_MS = READING_TIME_LIMIT_SEC * 1000;
const TRANSITION_MS = 200;

export function useReader(passages, { onProgressUpdate } = {}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [hardFlash, setHardFlash] = useState(false);
  const [actionsDisabled, setActionsDisabled] = useState(false);
  const [awaitingStart, setAwaitingStart] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [isReadingStarted, setIsReadingStarted] = useState(false);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(READING_TIME_LIMIT_SEC);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);
  const passagesKeyRef = useRef('');
  const actionPendingRef = useRef(false);
  const passiveFiredRef = useRef(false);
  const remainingSecondsRef = useRef(READING_TIME_LIMIT_SEC);

  const passage = passages[currentIndex] ?? null;
  const canInteract = isReadingStarted && !awaitingStart && !isPaused;

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

  // Reset when passage set changes (CEFR band switch)
  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    if (passagesKeyRef.current && passagesKeyRef.current !== key) {
      setCurrentIndex(0);
      setActiveChunkId(null);
      setMarginaliaOpen(false);
      resetReadingTimer();
    }
    passagesKeyRef.current = key;
  }, [passages, resetReadingTimer]);

  const resetMarginalia = useCallback(() => {
    setActiveChunkId(null);
    setMarginaliaOpen(false);
  }, []);

  const transitionTo = useCallback(
    (newIndex, direction, { autoStart = false } = {}) => {
      if (newIndex < 0 || newIndex >= passages.length || newIndex === currentIndex) return false;
      setTransitionDirection(direction);
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentIndex(newIndex);
        resetMarginalia();
        if (autoStart) {
          activateTimer();
        } else {
          resetReadingTimer();
        }
        setIsTransitioning(false);
        setTransitionDirection(null);
      }, TRANSITION_MS);
      return true;
    },
    [activateTimer, currentIndex, passages.length, resetMarginalia, resetReadingTimer],
  );

  const nextPassage = useCallback(
    (options) => {
      return transitionTo(currentIndex + 1, 'next', options);
    },
    [currentIndex, transitionTo],
  );

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
    if (!canInteract || !isTimerRunning) return;
    stopTimer();
    setIsPaused(true);
    setAwaitingStart(true);
  }, [canInteract, isTimerRunning, stopTimer]);

  const finishPassageAction = useCallback(
    (signal) => {
      stopTimer();
      recordEncounter(signal);
      const moved = nextPassage({ autoStart: true });
      if (!moved) {
        resetReadingTimer();
      }
    },
    [nextPassage, recordEncounter, resetReadingTimer, stopTimer],
  );

  const handleGotIt = useCallback(async () => {
    if (!canInteract || !beginAction()) return;
    try {
      finishPassageAction('got_it');
      await new Promise((resolve) => setTimeout(resolve, TRANSITION_MS));
    } finally {
      releaseActionLock();
    }
  }, [beginAction, canInteract, finishPassageAction, releaseActionLock]);

  const handleStillHard = useCallback(async () => {
    if (!canInteract || !beginAction()) return;
    try {
      finishPassageAction('still_hard');
      setHardFlash(true);
      await new Promise((resolve) => setTimeout(resolve, 240));
      setHardFlash(false);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, TRANSITION_MS - 240)));
    } finally {
      releaseActionLock();
    }
  }, [beginAction, canInteract, finishPassageAction, releaseActionLock]);

  const selectChunk = useCallback(
    (chunkId) => {
      if (!canInteract) return;
      setActiveChunkId(chunkId);
      setMarginaliaOpen(true);
    },
    [canInteract],
  );

  const closeMarginalia = useCallback(() => {
    setMarginaliaOpen(false);
    setActiveChunkId(null);
  }, []);

  useEffect(() => {
    releaseActionLock();
  }, [currentIndex, releaseActionLock]);

  // Countdown + passive encounter after time limit
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

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e) => {
      if (actionPendingRef.current || !canInteract) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        nextPassage();
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
  }, [canInteract, closeMarginalia, nextPassage, prevPassage, showTranslation]);

  useEffect(() => {
    return () => clearTimeout(translationTimerRef.current);
  }, []);

  const activeChunk = passage?.chunks.find((c) => c.id === activeChunkId) ?? null;

  return {
    passage,
    currentIndex,
    totalPassages: passages.length,
    activeChunkId,
    activeChunk,
    marginaliaOpen,
    isTransitioning,
    transitionDirection,
    translationVisible,
    hardFlash,
    actionsDisabled,
    awaitingStart,
    isPaused,
    isReadingStarted,
    remainingSeconds,
    startReading,
    pauseReading,
    nextPassage,
    prevPassage,
    selectChunk,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
