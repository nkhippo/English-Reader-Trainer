import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { USER_ID } from '../lib/config.js';

export function useReader(passages, { onProgressUpdate } = {}) {
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

  const passage = passages[currentIndex] ?? null;

  // Reset when passage set changes (CEFR band switch)
  useEffect(() => {
    const key = passages.map((p) => p.id).join('|');
    if (passagesKeyRef.current && passagesKeyRef.current !== key) {
      setCurrentIndex(0);
      setActiveChunkId(null);
      setMarginaliaOpen(false);
      pageStartRef.current = Date.now();
    }
    passagesKeyRef.current = key;
  }, [passages]);

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
        pageStartRef.current = Date.now();
        setIsTransitioning(false);
        setTransitionDirection(null);
      }, 200);
    },
    [currentIndex, passages.length, resetMarginalia],
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
    setTranslationVisible(true);
    clearTimeout(translationTimerRef.current);
    translationTimerRef.current = setTimeout(() => {
      setTranslationVisible(false);
    }, 3500);
  }, []);

  const recordEncounter = useCallback(
    async (signal) => {
      if (!passage) return;
      const timeOnPageMs = Date.now() - pageStartRef.current;
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
          await onProgressUpdate();
        }
      } catch (err) {
        console.error('[ERT] log_encounter failed:', err);
      }
    },
    [passage, onProgressUpdate],
  );

  const handleGotIt = useCallback(async () => {
    if (!beginAction()) return;
    await recordEncounter('got_it');
    if (!nextPassage()) releaseActionLock();
  }, [beginAction, nextPassage, recordEncounter, releaseActionLock]);

  const handleStillHard = useCallback(async () => {
    if (!beginAction()) return;
    await recordEncounter('still_hard');
    setHardFlash(true);
    setTimeout(() => {
      setHardFlash(false);
      if (!nextPassage()) releaseActionLock();
    }, 240);
  }, [beginAction, nextPassage, recordEncounter, releaseActionLock]);

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

  // Passive encounter after 30 seconds
  useEffect(() => {
    pageStartRef.current = Date.now();
    const timer = setTimeout(() => {
      recordEncounter('passive');
    }, 30000);
    return () => clearTimeout(timer);
  }, [currentIndex, recordEncounter]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e) => {
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
  }, [closeMarginalia, nextPassage, prevPassage, showTranslation]);

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
    nextPassage,
    prevPassage,
    selectChunk,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
