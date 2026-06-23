import { useI18n } from '../i18n/I18nProvider.jsx';
import { resolveChunkGloss } from '../lib/chunkGlosses.js';
import { formatChunkIpaDisplay } from '../lib/chunkDisplay.js';

export function ChunkGlossCard({
  chunk,
  evaluation,
  onEvaluate,
  actionsDisabled,
  variant = 'focus',
  onSelect,
}) {
  const { locale, t } = useI18n();

  if (!chunk) return null;

  if (variant === 'history') {
    const mark = evaluation === 'got_it' ? '✓' : '△';
    return (
      <button type="button" className="chunk-history__item" onClick={() => onSelect?.(chunk.id)}>
        <span className={`chunk-history__mark chunk-history__mark--${evaluation === 'got_it' ? 'ok' : 'hold'}`}>
          {mark}
        </span>
        <span className="chunk-history__text">{chunk.text}</span>
      </button>
    );
  }

  const gloss = resolveChunkGloss(chunk.text, chunk, locale);
  const ipaLine = formatChunkIpaDisplay(chunk.ipa);
  const evaluated = evaluation === 'got_it' || evaluation === 'still_hard';

  return (
    <article className="chunk-gloss">
      <h3 className="chunk-gloss__headline">{chunk.text}</h3>
      {ipaLine ? <p className="chunk-gloss__ipa">{ipaLine}</p> : null}
      {gloss ? <p className="chunk-gloss__meaning">{gloss}</p> : null}
      {chunk.example ? (
        <p className="chunk-gloss__example">
          <span className="chunk-gloss__example-label">{t.exampleShort}</span>
          {chunk.example}
        </p>
      ) : null}
      <p className="chunk-gloss__meta">{t.chunkMetaLine(chunk.cefr, chunk.encounters)}</p>
      <div className="chunk-gloss__buttons">
        <button
          type="button"
          className={`btn btn--ghost chunk-gloss__btn ${evaluation === 'got_it' ? 'chunk-gloss__btn--active' : ''}`}
          disabled={actionsDisabled}
          aria-pressed={evaluation === 'got_it'}
          onClick={() => onEvaluate?.(chunk.id, 'got_it')}
        >
          {t.chunkOk}
        </button>
        <button
          type="button"
          className={`btn btn--ghost chunk-gloss__btn ${evaluation === 'still_hard' ? 'chunk-gloss__btn--active' : ''}`}
          disabled={actionsDisabled}
          aria-pressed={evaluation === 'still_hard'}
          onClick={() => onEvaluate?.(chunk.id, 'still_hard')}
        >
          {t.chunkHold}
        </button>
      </div>
      {evaluated ? (
        <p className="chunk-gloss__status" aria-live="polite">
          {evaluation === 'got_it' ? t.chunkEvaluatedOk : t.chunkEvaluatedHold}
        </p>
      ) : null}
    </article>
  );
}
