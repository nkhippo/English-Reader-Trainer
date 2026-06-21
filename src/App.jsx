import { useCallback, useEffect, useRef, useState } from 'react';
import { useReader } from './hooks/useReader.js';
import { usePassagePrefetch } from './hooks/usePassagePrefetch.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';
import { ProcessingOverlay } from './components/ProcessingOverlay.jsx';
import { ReadingTimerBar } from './components/ReadingTimerBar.jsx';
import { StartReadingOverlay } from './components/StartReadingOverlay.jsx';
import { fetchSession, fetchStats } from './lib/api.js';
import { getStoredCefrBand, storeCefrBand } from './lib/cefr.js';
import { normalizePassagesFromApi } from './lib/passages.js';
import { pickUnseenBandTemplate } from './lib/localPassages.js';
import { normalizeBandStats } from './lib/stats.js';
import { USER_ID } from './lib/config.js';
import { useI18n } from './i18n/I18nProvider.jsx';

function firstPassageFromResponse(res) {
  const normalized = normalizePassagesFromApi(res.passages || []);
  if (normalized.length > 0) return normalized[0];
  return null;
}

function appendPassage(setPassages, passagesRef, next) {
  if (!next) return false;
  let added = false;
  setPassages((prev) => {
    if (prev.some((p) => p.id === next.id)) return prev;
    added = true;
    const updated = [...prev, next];
    passagesRef.current = updated;
    return updated;
  });
  return added;
}

export default function App() {
  const { t } = useI18n();
  const [cefrBand, setCefrBand] = useState(getStoredCefrBand);
  const [passages, setPassages] = useState([]);
  const passagesRef = useRef(passages);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ reviewing: 0, graduated: 0, total: 0, encountered: 0 });
  const advancePastEndRef = useRef(async () => false);

  const refreshStats = useCallback(async (band) => {
    try {
      const statsRes = await fetchStats({ userId: USER_ID, cefr: band });
      setStats(normalizeBandStats(statsRes));
    } catch (err) {
      console.error('[ERT] stats refresh failed:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadContent(band) {
      setLoading(true);
      try {
        const sessionRes = await fetchSession({ userId: USER_ID, cefr: band });
        if (cancelled) return;

        let first = firstPassageFromResponse(sessionRes);
        if (!first) first = await pickUnseenBandTemplate(band, []);
        setPassages(first ? [first] : []);
        setStats(normalizeBandStats(sessionRes));
      } catch (err) {
        if (cancelled) return;
        console.error('[ERT] load failed:', err);
        const fallback = await pickUnseenBandTemplate(band, []);
        setPassages(fallback ? [fallback] : []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadContent(cefrBand);
    return () => {
      cancelled = true;
    };
  }, [cefrBand]);

  useEffect(() => {
    passagesRef.current = passages;
  }, [passages]);

  const handleProgressUpdate = useCallback(async () => {
    await refreshStats(cefrBand);
  }, [cefrBand, refreshStats]);

  const reader = useReader(passages, {
    passagesRef,
    onProgressUpdate: handleProgressUpdate,
    onAdvancePastEnd: () => advancePastEndRef.current(),
  });

  const { takeQueuedPassage, fillQueue } = usePassagePrefetch({
    cefrBand,
    seenPassageIds: passages.map((p) => p.id),
    enabled: !loading && passages.length > 0,
  });

  useEffect(() => {
    advancePastEndRef.current = async () => {
      const seenIds = passagesRef.current.map((p) => p.id);

      const queued = takeQueuedPassage();
      if (queued && appendPassage(setPassages, passagesRef, queued)) {
        return passagesRef.current.length - 1;
      }

      const local = await pickUnseenBandTemplate(cefrBand, seenIds);
      if (local && appendPassage(setPassages, passagesRef, local)) {
        fillQueue();
        return passagesRef.current.length - 1;
      }

      return null;
    };
  }, [cefrBand, fillQueue, takeQueuedPassage]);

  const handleCefrChange = (band) => {
    storeCefrBand(band);
    setCefrBand(band);
  };

  if (loading && passages.length === 0) {
    return (
      <div className="app app--loading">
        <p className="loading-msg">{t.loading}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        cefrBand={cefrBand}
        onCefrChange={handleCefrChange}
        reviewing={stats.reviewing}
        graduated={stats.graduated}
        total={stats.total}
        encountered={stats.encountered}
      />

      <ReadingTimerBar visible={reader.isReadingStarted} remainingSeconds={reader.remainingSeconds} />

      <main className="reader">
        <StartReadingOverlay
          visible={reader.awaitingStart && !!reader.passage}
          paused={reader.isPaused}
          onStart={() => reader.startReading()}
          onResume={() => reader.startReading({ resume: true })}
        />
        <PassageView
          passage={reader.passage}
          activeChunkId={reader.activeChunkId}
          clozeChunkId={reader.clozeChunkId}
          clozeRevealed={reader.clozeRevealed}
          isTransitioning={reader.isTransitioning}
          transitionDirection={reader.transitionDirection}
          onChunkClick={reader.handleChunkClick}
          onBackgroundClick={reader.showTranslation}
          onSwipeNext={() => reader.advanceToNext()}
          onSwipePrev={reader.prevPassage}
        />
        <MarginaliaPanel
          chunk={reader.activeChunk}
          isOpen={reader.marginaliaOpen}
          onClose={reader.closeMarginalia}
          isFading={false}
          clozePending={!!reader.clozeChunkId && !reader.clozeRevealed}
        />
      </main>

      <Footer
        onStillHard={reader.handleStillHard}
        onGotIt={reader.handleGotIt}
        onSuspend={reader.pauseReading}
        hardFlash={reader.hardFlash}
        actionsDisabled={
          reader.actionsDisabled || reader.awaitingStart || reader.isPaused || !reader.isReadingStarted
        }
        suspendDisabled={
          reader.awaitingStart || reader.isPaused || !reader.isReadingStarted
        }
        suspendQueued={reader.pauseAfterAction}
      />

      <TranslationOverlay text={reader.passage?.ja ?? ''} visible={reader.translationVisible} />

      <ProcessingOverlay visible={reader.isSaving} pauseQueued={reader.pauseAfterAction} />
    </div>
  );
}
