import { useI18n } from '../i18n/I18nProvider.jsx';
import { parsePassageText } from '../lib/passageMarkup.js';
import { formatChunkPassageText } from '../lib/chunkDisplay.js';
import { PassageGlossPane } from './PassageGlossPane.jsx';

export function PassageView({
  passage,
  focusedChunkId,
  chunkEvaluations,
  clozeChunkId,
  clozeRevealed,
  isTransitioning,
  transitionDirection,
  canInteract,
  showInteractionHint,
  displayMode,
  onChunkTap,
  onEvaluate,
  onBackgroundClick,
  actionsDisabled,
}) {
  const { t } = useI18n();

  if (!passage) return null;

  const segments = parsePassageText(passage.text, passage.chunks);
  const transitionClass = isTransitioning
    ? `passage-area--exit-${transitionDirection}`
    : '';
  const focusedChunk = passage.chunks.find((c) => c.id === focusedChunkId) ?? null;

  return (
    <section className={`reader__passage ${transitionClass}`}>
      <article
        className="passage"
        onClick={(e) => {
          if (e.target.closest('.chunk')) return;
          onBackgroundClick();
        }}
      >
        {showInteractionHint ? (
          <p className="passage-interaction-hint">{t.chunkInteractionHint}</p>
        ) : null}
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
            const focusedClass = focusedChunkId === seg.chunk.id ? 'chunk--focused' : '';
            return (
              <mark
                key={seg.key}
                className={`chunk ${focusedClass} ${isCloze ? 'chunk--cloze' : ''} ${evalClass}`}
                aria-label={isCloze ? t.clozeReveal : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onChunkTap(seg.chunk.id);
                }}
              >
                {isCloze
                  ? '___'
                  : formatChunkPassageText(
                    seg.chunk,
                    displayMode,
                    seg.displayText || seg.chunk.text,
                  )}
              </mark>
            );
          })}
        </p>
      </article>
      <PassageGlossPane
        focusedChunk={focusedChunk}
        chunkEvaluations={chunkEvaluations}
        onEvaluate={onEvaluate}
        actionsDisabled={actionsDisabled}
      />
    </section>
  );
}

export { parsePassageText } from '../lib/passageMarkup.js';
