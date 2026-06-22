import { useCallback, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { parsePassageText } from '../lib/passageMarkup.js';

const LONG_PRESS_MS = 480;

export function PassageView({
  passage,
  chunkEvaluations,
  clozeChunkId,
  clozeRevealed,
  isTransitioning,
  transitionDirection,
  canInteract,
  onChunkTap,
  onChunkLongPress,
  onBackgroundClick,
}) {
  const { t } = useI18n();
  const pressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const activePointerRef = useRef(null);

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const handleChunkPointerDown = useCallback((e, chunkId) => {
    if (!canInteract) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    clearPressTimer();
    activePointerRef.current = e.pointerId;
    longPressTriggeredRef.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);

    pressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      onChunkLongPress(chunkId);
    }, LONG_PRESS_MS);
  }, [canInteract, clearPressTimer, onChunkLongPress]);

  const handleChunkPointerUp = useCallback((e, chunkId) => {
    if (activePointerRef.current !== e.pointerId) return;

    clearPressTimer();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    activePointerRef.current = null;

    if (!longPressTriggeredRef.current) {
      onChunkTap(chunkId);
    }
  }, [clearPressTimer, onChunkTap]);

  const handleChunkPointerCancel = useCallback((e) => {
    if (activePointerRef.current !== e.pointerId) return;
    clearPressTimer();
    activePointerRef.current = null;
    longPressTriggeredRef.current = false;
  }, [clearPressTimer]);

  if (!passage) return null;

  const segments = parsePassageText(passage.text, passage.chunks);
  const transitionClass = isTransitioning
    ? `passage-area--exit-${transitionDirection}`
    : '';

  return (
    <section className={`reader__passage ${transitionClass}`}>
      <article
        className="passage"
        onClick={(e) => {
          if (e.target.closest('.chunk')) return;
          onBackgroundClick();
        }}
      >
        <p>
          {segments.map((seg) => {
            if (seg.type !== 'chunk') {
              return <span key={seg.key}>{seg.content}</span>;
            }
            const isCloze = seg.chunk.id === clozeChunkId && !clozeRevealed;
            const evaluation = chunkEvaluations?.[seg.chunk.id];
            const evalClass = evaluation === 'got_it'
              ? 'chunk--evaluated-ok'
              : evaluation === 'still_hard'
                ? 'chunk--evaluated-hold'
                : 'chunk--unevaluated';
            return (
              <mark
                key={seg.key}
                className={`chunk ${isCloze ? 'chunk--cloze' : ''} ${evalClass}`}
                aria-label={isCloze ? t.clozeReveal : undefined}
                onPointerDown={(e) => handleChunkPointerDown(e, seg.chunk.id)}
                onPointerUp={(e) => handleChunkPointerUp(e, seg.chunk.id)}
                onPointerCancel={handleChunkPointerCancel}
              >
                {isCloze ? '___' : (seg.displayText || seg.chunk.text)}
              </mark>
            );
          })}
        </p>
        <p className="passage-interaction-hint">{t.chunkInteractionHint}</p>
      </article>
    </section>
  );
}

export { parsePassageText } from '../lib/passageMarkup.js';
