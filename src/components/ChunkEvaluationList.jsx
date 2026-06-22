import { useI18n } from '../i18n/I18nProvider.jsx';

export function ChunkEvaluationList({
  chunks,
  evaluations,
  activeChunkId,
  onEvaluate,
  onChunkSelect,
  disabled,
}) {
  const { t } = useI18n();

  if (!chunks?.length) return null;

  return (
    <section className="chunk-eval" aria-label={t.chunkEvalGroupAria}>
      <h2 className="chunk-eval__heading">{t.chunkEvalHeading}</h2>
      <ul className="chunk-eval__list">
        {chunks.map((chunk) => {
          const evaluation = evaluations?.[chunk.id];
          const groupName = `chunk-eval-${chunk.id}`;
          return (
            <li
              key={chunk.id}
              className={`chunk-eval__item ${activeChunkId === chunk.id ? 'chunk-eval__item--active' : ''} ${evaluation ? `chunk-eval__item--${evaluation === 'got_it' ? 'ok' : 'hold'}` : ''}`}
            >
              <button
                type="button"
                className="chunk-eval__word"
                onClick={() => onChunkSelect?.(chunk.id)}
              >
                {chunk.text}
              </button>
              <div
                className="chunk-eval__radios"
                role="radiogroup"
                aria-label={`${chunk.text} — ${t.chunkEvalGroupAria}`}
              >
                <label className="chunk-eval__radio">
                  <input
                    type="radio"
                    name={groupName}
                    value="got_it"
                    checked={evaluation === 'got_it'}
                    disabled={disabled}
                    onChange={() => onEvaluate?.(chunk.id, 'got_it')}
                  />
                  <span>{t.chunkOk}</span>
                </label>
                <label className="chunk-eval__radio">
                  <input
                    type="radio"
                    name={groupName}
                    value="still_hard"
                    checked={evaluation === 'still_hard'}
                    disabled={disabled}
                    onChange={() => onEvaluate?.(chunk.id, 'still_hard')}
                  />
                  <span>{t.chunkHold}</span>
                </label>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
