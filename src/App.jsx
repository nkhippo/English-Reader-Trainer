import { useCallback, useEffect, useState } from 'react';
import { MOCK_PASSAGES } from './data/mockPassages.js';
import { useReader } from './hooks/useReader.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';
import { ProcessingOverlay } from './components/ProcessingOverlay.jsx';
import { fetchGeneratePassage, fetchSession, fetchStats } from './lib/api.js';
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

function firstPassageFromResponse(res, band) {
  const normalized = normalizePassagesFromApi(res.passages || []);
  if (normalized.length > 0) return normalized[0];
  return filterMockByBand(band)[0] ?? null;
}

export default function App() {
  const { t } = useI18n();
  const [cefrBand, setCefrBand] = useState(getStoredCefrBand);
  const [passages, setPassages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ reviewing: 0, graduated: 0 });

  const refreshStats = useCallback(async (band) => {
    try {
      const statsRes = await fetchStats({ userId: USER_ID, cefr: band });
      setStats({
        reviewing: statsRes.reviewing ?? 0,
        graduated: statsRes.graduated ?? 0,
      });
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

        const first = firstPassageFromResponse(sessionRes, band);
        setPassages(first ? [first] : filterMockByBand(band).slice(0, 1));
        setStats({
          reviewing: sessionRes.reviewing ?? 0,
          graduated: sessionRes.graduated ?? 0,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[ERT] load failed:', err);
        const mock = filterMockByBand(band);
        setPassages(mock.length > 0 ? [mock[0]] : []);
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
    await refreshStats(cefrBand);
  }, [cefrBand, refreshStats]);

  const handleAdvancePastEnd = useCallback(async () => {
    try {
      const res = await fetchGeneratePassage({ userId: USER_ID, cefr: cefrBand });
      const normalized = normalizePassagesFromApi(res.passages || []);
      if (normalized.length === 0) return false;
      setPassages((prev) => [...prev, normalized[0]]);
      return true;
    } catch (err) {
      console.error('[ERT] fetch next passage failed:', err);
      const mock = filterMockByBand(cefrBand);
      if (mock.length === 0) return false;
      const next = mock[Math.floor(Math.random() * mock.length)];
      setPassages((prev) => [...prev, next]);
      return true;
    }
  }, [cefrBand]);

  const handleCefrChange = (band) => {
    storeCefrBand(band);
    setCefrBand(band);
  };

  const reader = useReader(passages, {
    onProgressUpdate: handleProgressUpdate,
    onAdvancePastEnd: handleAdvancePastEnd,
  });

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
      />

      <main className="reader">
        <PassageView
          passage={reader.passage}
          activeChunkId={reader.activeChunkId}
          isTransitioning={reader.isTransitioning}
          transitionDirection={reader.transitionDirection}
          onChunkClick={reader.selectChunk}
          onBackgroundClick={reader.showTranslation}
          onSwipeNext={() => reader.advanceToNext()}
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
        disabled={reader.actionsDisabled}
      />

      <TranslationOverlay text={reader.passage?.ja ?? ''} visible={reader.translationVisible} />

      <ProcessingOverlay visible={reader.actionsDisabled} />
    </div>
  );
}
