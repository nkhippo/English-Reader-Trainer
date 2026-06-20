import { useEffect, useRef, useState } from 'react';

function parsePassageText(text, chunks) {
  const parts = text.split(/(\{\{[^}]+\}\})/);
  return parts.map((part, i) => {
    if (part.startsWith('{{') && part.endsWith('}}')) {
      const chunkText = part.slice(2, -2);
      const chunk = chunks.find((c) => c.text === chunkText);
      if (chunk) {
        return { type: 'chunk', key: `${chunk.id}-${i}`, chunk };
      }
      return { type: 'text', key: `text-${i}`, content: chunkText };
    }
    return { type: 'text', key: `text-${i}`, content: part };
  });
}

export function PassageView({
  passage,
  activeChunkId,
  isTransitioning,
  transitionDirection,
  onChunkClick,
  onBackgroundClick,
  onSwipeNext,
  onSwipePrev,
}) {
  const areaRef = useRef(null);
  const touchStartRef = useRef(null);
  const [fadingMarginalia, setFadingMarginalia] = useState(false);

  useEffect(() => {
    if (activeChunkId) {
      setFadingMarginalia(true);
      const timer = setTimeout(() => setFadingMarginalia(false), 140);
      return () => clearTimeout(timer);
    }
  }, [activeChunkId]);

  const handleTouchStart = (e) => {
    touchStartRef.current = {
      y: e.touches[0].clientY,
      x: e.touches[0].clientX,
    };
  };

  const handleTouchEnd = (e) => {
    const start = touchStartRef.current;
    if (!start) return;
    const endY = e.changedTouches[0].clientY;
    const endX = e.changedTouches[0].clientX;
    const dy = endY - start.y;
    const dx = endX - start.x;
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx)) {
      if (dy < 0) onSwipeNext();
      else onSwipePrev();
    }
    touchStartRef.current = null;
  };

  if (!passage) return null;

  const segments = parsePassageText(passage.text, passage.chunks);
  const transitionClass = isTransitioning
    ? `passage-area--exit-${transitionDirection}`
    : '';

  return (
    <section
      ref={areaRef}
      className={`reader__passage ${transitionClass}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <article
        className="passage"
        onClick={(e) => {
          if (e.target.closest('.chunk')) return;
          onBackgroundClick();
        }}
      >
        <p>
          {segments.map((seg) =>
            seg.type === 'chunk' ? (
              <mark
                key={seg.key}
                className={`chunk ${activeChunkId === seg.chunk.id ? 'chunk--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChunkClick(seg.chunk.id);
                }}
              >
                {seg.chunk.text}
              </mark>
            ) : (
              <span key={seg.key}>{seg.content}</span>
            ),
          )}
        </p>
      </article>
    </section>
  );
}

export { parsePassageText };
