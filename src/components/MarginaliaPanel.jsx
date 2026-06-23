import { useI18n } from '../i18n/I18nProvider.jsx';
import { ChunkGlossCard } from './ChunkGlossCard.jsx';

export function MarginaliaPanel({
  chunks,
  focusedChunk,
  chunkEvaluations,
  onEvaluate,
  onSelectChunk,
  actionsDisabled,
}) {
  const { t } = useI18n();

  const history = (chunks || []).filter((c) => {
    const signal = chunkEvaluations?.[c.id];
    return (signal === 'got_it' || signal === 'still_hard') && c.id !== focusedChunk?.id;
  });

  return (
    <aside className="marginalia">
      {focusedChunk ? (
        <ChunkGlossCard
          chunk={focusedChunk}
          evaluation={chunkEvaluations?.[focusedChunk.id]}
          onEvaluate={onEvaluate}
          actionsDisabled={actionsDisabled}
          variant="focus"
        />
      ) : (
        <p className="marginalia__empty">{t.marginaliaEmpty}</p>
      )}

      {history.length > 0 ? (
        <section className="chunk-history" aria-label={t.evaluatedHistory}>
          <h3 className="chunk-history__heading">{t.evaluatedHistory}</h3>
          <div className="chunk-history__list">
            {history.map((chunk) => (
              <ChunkGlossCard
                key={chunk.id}
                chunk={chunk}
                evaluation={chunkEvaluations[chunk.id]}
                variant="history"
                onSelect={onSelectChunk}
              />
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
