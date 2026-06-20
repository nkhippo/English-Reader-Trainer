import { useEffect, useState } from 'react';
import { MOCK_PASSAGES } from './data/mockPassages.js';
import { useReader } from './hooks/useReader.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';
import { checkBackendHealth, getStoredGasUrl, setGasUrl } from './lib/api.js';

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [gasUrlInput, setGasUrlInput] = useState(getStoredGasUrl());
  const [backendStatus, setBackendStatus] = useState({ checking: true });

  const reader = useReader(MOCK_PASSAGES);

  useEffect(() => {
    let cancelled = false;
    checkBackendHealth().then((status) => {
      if (!cancelled) setBackendStatus({ checking: false, ...status });
    });
    return () => {
      cancelled = true;
    };
  }, [gasUrlInput]);

  const saveGasUrl = () => {
    setGasUrl(gasUrlInput.trim());
    setBackendStatus({ checking: true });
    setShowSettings(false);
  };

  return (
    <div className="app">
      <Header
        cefr={reader.passage?.cefr ?? 'B1'}
        currentPage={reader.currentIndex + 1}
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

      <button
        className="settings-btn"
        onClick={() => setShowSettings((v) => !v)}
        aria-label="Settings"
      >
        ⚙
      </button>

      {showSettings && (
        <div className="settings-panel">
          <h3>Settings</h3>
          <div className="backend-status">
            Backend:{' '}
            {backendStatus.checking ? (
              <span className="backend-status__checking">checking…</span>
            ) : backendStatus.ok ? (
              <span className="backend-status__ok">connected (phase {backendStatus.phase})</span>
            ) : (
              <span className="backend-status__error">{backendStatus.error}</span>
            )}
          </div>
          <label>
            GAS Endpoint URL
            <input
              type="url"
              value={gasUrlInput}
              onChange={(e) => setGasUrlInput(e.target.value)}
              placeholder="https://script.google.com/macros/s/.../exec"
            />
          </label>
          <p className="settings-hint">
            Encounter logging writes to the encounter_log sheet via log_encounter.
          </p>
          <button className="btn btn--primary" onClick={saveGasUrl}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
