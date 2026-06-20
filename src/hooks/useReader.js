import { useCallback, useEffect, useRef, useState } from 'react';
import { logEncounter } from '../lib/api.js';
import { USER_ID } from '../lib/config.js';

export function useReader(passages) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [marginaliaOpen, setMarginaliaOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionDirection, setTransitionDirection] = useState(null);
  const [translationVisible, setTranslationVisible] = useState(false);
  const [hardFlash, setHardFlash] = useState(false);

  const pageStartRef = useRef(Date.now());
  const translationTimerRef = useRef(null);

  const passage = passages[currentIndex] ?? null;

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
    transitionTo(currentIndex + 1, 'next');
  }, [currentIndex, transitionTo]);

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
      } catch (err) {
        console.error('[ERT] log_encounter failed:', err);
      }
    },
    [passage],
  );

  const handleGotIt = useCallback(async () => {
    await recordEncounter('got_it');
    nextPassage();
  }, [nextPassage, recordEncounter]);

  const handleStillHard = useCallback(async () => {
    await recordEncounter('still_hard');
    setHardFlash(true);
    setTimeout(() => {
      setHardFlash(false);
      nextPassage();
    }, 240);
  }, [nextPassage, recordEncounter]);

  const selectChunk = useCallback((chunkId) => {
    setActiveChunkId(chunkId);
    setMarginaliaOpen(true);
  }, []);

  const closeMarginalia = useCallback(() => {
    setMarginaliaOpen(false);
    setActiveChunkId(null);
  }, []);

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
    nextPassage,
    prevPassage,
    selectChunk,
    closeMarginalia,
    showTranslation,
    handleGotIt,
    handleStillHard,
  };
}
