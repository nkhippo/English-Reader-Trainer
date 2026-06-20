import { useCallback, useEffect, useState } from 'react';
import { MOCK_PASSAGES } from './data/mockPassages.js';
import { useReader } from './hooks/useReader.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';
import { ProcessingOverlay } from './components/ProcessingOverlay.jsx';
import { ReadingTimerBar } from './components/ReadingTimerBar.jsx';
import { StartReadingOverlay } from './components/StartReadingOverlay.jsx';
import { fetchSession } from './lib/api.js';
import { getStoredCefrBand, storeCefrBand } from './lib/cefr.js';
import { normalizePassagesFromApi } from './lib/passages.js';
import { USER_ID } from './lib/config.js';
import { useI18n } from './i18n/I18nProvider.jsx';

function filterMockByBand(band) {
  if (band === 'A1A2') {
    return MOCK_PASSAGES.filter((p) => p.chunks.some((c) => c.cefr === 'A1' || c.cefr === 'A2'));
  }
  if (band === 'B2') {
    return MOCK_PASSAGES.filter((p) => p.chunks.some((c) => c.cefr === 'B2'));
  }
  return MOCK_PASSAGES.filter((p) => p.cefr === 'B1' || band === 'B1');
}

export default function App() {
  const { t } = useI18n();
  const [cefrBand, setCefrBand] = useState(getStoredCefrBand);
  const [passages, setPassages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ reviewing: 0, graduated: 0 });

  useEffect(() => {
    let cancelled = false;

    async function loadContent(band) {
      setLoading(true);
      try {
        const sessionRes = await fetchSession({ userId: USER_ID, cefr: band });
        if (cancelled) return;

        const normalized = normalizePassagesFromApi(sessionRes.passages || []);
        setPassages(normalized.length > 0 ? normalized : filterMockByBand(band));
        setStats({
          reviewing: sessionRes.reviewing ?? 0,
          graduated: sessionRes.graduated ?? 0,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[ERT] load failed:', err);
        setPassages(filterMockByBand(band));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadContent(cefrBand);
    return () => {
      cancelled = true;
    };
  }, [cefrBand]);

  const handleProgressUpdate = useCallback(async () => {
    try {
      const sessionRes = await fetchSession({ userId: USER_ID, cefr: cefrBand });
      const normalized = normalizePassagesFromApi(sessionRes.passages || []);
      if (normalized.length > 0) setPassages(normalized);
      setStats({
        reviewing: sessionRes.reviewing ?? 0,
        graduated: sessionRes.graduated ?? 0,
      });
    } catch (err) {
      console.error('[ERT] progress refresh failed:', err);
    }
  }, [cefrBand]);

  const handleCefrChange = (band) => {
    storeCefrBand(band);
    setCefrBand(band);
  };

  const reader = useReader(passages, { onProgressUpdate: handleProgressUpdate });

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
        currentPage={reader.totalPassages > 0 ? reader.currentIndex + 1 : 0}
        totalPages={reader.totalPassages}
      />

      <ReadingTimerBar visible={reader.isReadingStarted} remainingSeconds={reader.remainingSeconds} />

      <main className="reader">
        <StartReadingOverlay
          visible={!reader.isReadingStarted && !!reader.passage}
          onStart={reader.startReading}
        />
        <PassageView
          passage={reader.passage}
          activeChunkId={reader.activeChunkId}
          currentIndex={reader.currentIndex}
          isTransitioning={reader.isTransitioning}
          transitionDirection={reader.transitionDirection}
          onChunkClick={reader.selectChunk}
          onBackgroundClick={reader.showTranslation}
          onSwipeNext={reader.nextPassage}
          onSwipePrev={reader.prevPassage}
        />
        <MarginaliaPanel
          chunk={reader.activeChunk}
          isOpen={reader.marginaliaOpen}
          onClose={reader.closeMarginalia}
          isFading={false}
        />
      </main>

      <Footer
        onStillHard={reader.handleStillHard}
        onGotIt={reader.handleGotIt}
        hardFlash={reader.hardFlash}
        disabled={reader.actionsDisabled || !reader.isReadingStarted}
      />

      <TranslationOverlay text={reader.passage?.ja ?? ''} visible={reader.translationVisible} />

      <ProcessingOverlay visible={reader.actionsDisabled} />
    </div>
  );
}
