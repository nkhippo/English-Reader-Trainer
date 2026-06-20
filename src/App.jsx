import { useCallback, useEffect, useState } from 'react';
import { MOCK_PASSAGES } from './data/mockPassages.js';
import { useReader } from './hooks/useReader.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';
import { fetchGeneratePassage, fetchStats } from './lib/api.js';
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

  const loadContent = useCallback(async (band) => {
    setLoading(true);
    try {
      const [passageRes, statsRes] = await Promise.all([
        fetchGeneratePassage({ userId: USER_ID, cefr: band }),
        fetchStats({ userId: USER_ID, cefr: band }),
      ]);
      const normalized = normalizePassagesFromApi(passageRes.passages || []);
      setPassages(normalized.length > 0 ? normalized : filterMockByBand(band));
      setStats({
        reviewing: statsRes.reviewing ?? statsRes.chunks_in_band ?? 0,
        graduated: statsRes.graduated ?? 0,
      });
    } catch (err) {
      console.error('[ERT] load failed:', err);
      setPassages(filterMockByBand(band));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadContent(cefrBand);
  }, [cefrBand, loadContent]);

  const handleCefrChange = (band) => {
    storeCefrBand(band);
    setCefrBand(band);
  };

  const reader = useReader(passages);

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

      <main className="reader">
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
      />

      <TranslationOverlay text={reader.passage?.ja ?? ''} visible={reader.translationVisible} />
    </div>
  );
}
