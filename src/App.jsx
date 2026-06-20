import { MOCK_PASSAGES } from './data/mockPassages.js';
import { useReader } from './hooks/useReader.js';
import { Header } from './components/Header.jsx';
import { PassageView } from './components/PassageView.jsx';
import { MarginaliaPanel } from './components/MarginaliaPanel.jsx';
import { Footer } from './components/Footer.jsx';
import { TranslationOverlay } from './components/TranslationOverlay.jsx';

export default function App() {
  const reader = useReader(MOCK_PASSAGES);

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
    </div>
  );
}
