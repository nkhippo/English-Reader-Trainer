import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { READING_TIME_LIMIT_SEC, USER_ID } from '../lib/config.js';

const READING_TIME_LIMIT_MS = READING_TIME_LIMIT_SEC * 1000;

export function useReader(passages, { onProgressUpdate } = {}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [hardFlash, setHardFlash] = useState(false);
  const [actionsDisabled, setActionsDisabled] = useState(false);
  const [isReadingStarted, setIsReadingStarted] = useState(false);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(READING_TIME_LIMIT_SEC);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);
  const passagesKeyRef = useRef('');
  const actionPendingRef = useRef(false);
  const passiveFiredRef = useRef(false);

  const passage = passages[currentIndex] ?? null;

  const resetReadingTimer = useCallback(() => {
    setIsReadingStarted(false);
    setIsTimerRunning(false);
    setRemainingSeconds(READING_TIME_LIMIT_SEC);
    passiveFiredRef.current = false;
  }, []);

  const stopTimer = useCallback(() => {
    setIsTimerRunning(false);
  }, []);

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
    (newIndex, direction) => {
      if (newIndex < 0 || newIndex >= passages.length || newIndex === currentIndex) return;
      setTransitionDirection(direction);
      setIsTransitioning(true);
      setTimeout(() => {
        setCurrentIndex(newIndex);
        resetMarginalia();
        resetReadingTimer();
        setIsTransitioning(false);
        setTransitionDirection(null);
      }, 200);
    },
    [currentIndex, passages.length, resetMarginalia, resetReadingTimer],
  );

  const nextPassage = useCallback(() => {
    const newIndex = currentIndex + 1;
    if (newIndex >= passages.length) return false;
    transitionTo(newIndex, 'next');
    return true;
  }, [currentIndex, passages.length, transitionTo]);

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
    if (!isReadingStarted) return;
    setTranslationVisible(true);
    clearTimeout(translationTimerRef.current);
    translationTimerRef.current = setTimeout(() => {
      setTranslationVisible(false);
    }, 3500);
  }, [isReadingStarted]);

  const recordEncounter = useCallback(
    async (signal) => {
      if (!passage) return;
      const timeOnPageMs = isReadingStarted ? Date.now() - pageStartRef.current : 0;
      const chunkIds = passage.chunks.map((c) => c.id);
      try {
        await logEncounter({
          userId: USER_ID,
          chunkIds,
          passageId: passage.id,
          signal,
          timeOnPageMs,
        });
        if (onProgressUpdate && (signal === 'got_it' || signal === 'still_hard')) {
          onProgressUpdate().catch((err) => {
            console.error('[ERT] progress refresh failed:', err);
          });
        }
      } catch (err) {
        console.error('[ERT] log_encounter failed:', err);
      }
    },
    [isReadingStarted, passage, onProgressUpdate],
  );

  const startReading = useCallback(() => {
    pageStartRef.current = Date.now();
    passiveFiredRef.current = false;
    setRemainingSeconds(READING_TIME_LIMIT_SEC);
    setIsReadingStarted(true);
    setIsTimerRunning(true);
  }, []);

  const handleGotIt = useCallback(async () => {
    if (!isReadingStarted || !beginAction()) return;
    stopTimer();
    await recordEncounter('got_it');
    if (!nextPassage()) releaseActionLock();
  }, [beginAction, isReadingStarted, nextPassage, recordEncounter, releaseActionLock, stopTimer]);

  const handleStillHard = useCallback(async () => {
    if (!isReadingStarted || !beginAction()) return;
    stopTimer();
    await recordEncounter('still_hard');
    setHardFlash(true);
    setTimeout(() => {
      setHardFlash(false);
      if (!nextPassage()) releaseActionLock();
    }, 240);
  }, [beginAction, isReadingStarted, nextPassage, recordEncounter, releaseActionLock, stopTimer]);

  const selectChunk = useCallback(
    (chunkId) => {
      if (!isReadingStarted) return;
      setActiveChunkId(chunkId);
      setMarginaliaOpen(true);
    },
    [isReadingStarted],
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
      setRemainingSeconds(remaining);

      if (remaining === 0 && !passiveFiredRef.current) {
        passiveFiredRef.current = true;
        recordEncounter('passive');
      }
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [currentIndex, isTimerRunning, passage, recordEncounter]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e) => {
      if (actionPendingRef.current || !isReadingStarted) return;
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
  }, [closeMarginalia, isReadingStarted, nextPassage, prevPassage, showTranslation]);

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
    isReadingStarted,
    remainingSeconds,
    startReading,
    nextPassage,
    prevPassage,
    selectChunk,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
