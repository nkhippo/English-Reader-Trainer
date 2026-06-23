import { useI18n } from '../i18n/I18nProvider.jsx';
import { ChunkGlossCard } from './ChunkGlossCard.jsx';

export function PassageGlossPane({
  focusedChunk,
  chunkEvaluations,
  onEvaluate,
  actionsDisabled,
}) {
  const { t } = useI18n();

  return (
    <section className="passage-gloss" aria-label={t.passageGlossAria}>
      {focusedChunk ? (
        <ChunkGlossCard
          chunk={focusedChunk}
          evaluation={chunkEvaluations?.[focusedChunk.id]}
          onEvaluate={onEvaluate}
          actionsDisabled={actionsDisabled}
          variant="focus"
        />
      ) : (
        <p className="passage-gloss__empty">{t.marginaliaEmpty}</p>
      )}
    </section>
  );
}
