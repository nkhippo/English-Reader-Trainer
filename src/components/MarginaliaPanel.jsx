import { useI18n } from '../i18n/I18nProvider.jsx';

function StageDots({ stage }) {
  return (
    <span className="stage-dots" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={`dot ${i < stage ? 'dot--filled' : ''}`} />
      ))}
    </span>
  );
}

function StageDisplay({ stage, status }) {
  const { t } = useI18n();
  const normalizedStage = Math.max(0, Math.min(Number(stage) || 0, 5));

  if (status === 'graduated' || normalizedStage >= 5) {
    return (
      <span className="note__stage">
        <span className="note__stage-count">{t.stageProgress(5)}</span>
        <StageDots stage={5} />
      </span>
    );
  }

  if (normalizedStage <= 0) {
    return <span className="note__stage note__stage--new">{t.stageNew}</span>;
  }

  return (
    <span className="note__stage">
      <span className="note__stage-count">{t.stageProgress(normalizedStage)}</span>
      <StageDots stage={normalizedStage} />
    </span>
  );
}

export function MarginaliaPanel({ chunk, isOpen, onClose, isFading, clozePending }) {
  const { t } = useI18n();
  const emptyMessage = clozePending ? t.clozeReveal : t.marginaliaEmpty;

  return (
    <aside className={`marginalia ${isOpen ? 'is-open' : ''}`}>
      <button className="marginalia__close" onClick={onClose} aria-label={t.close}>
        ×
      </button>
      <div className={`marginalia__content ${isFading ? 'is-fading' : ''}`}>
        {!chunk ? (
          <div className={`marginalia__empty ${clozePending ? 'marginalia__empty--cloze' : ''}`}>
            {emptyMessage}
          </div>
        ) : (
          <div className="note">
            <span className="note__chunk">{chunk.text}</span>
            {chunk.ja ? <div className="note__translation">{chunk.ja}</div> : null}
            <hr className="note__rule" />
            <div className="note__meta">
              <div className="note__meta-item">
                <span className="note__meta-label">CEFR</span>
                <span className="note__meta-value">{chunk.cefr}</span>
              </div>
              <div className="note__meta-item">
                <span className="note__meta-label">{t.encounters}</span>
                <span className="note__meta-value">{chunk.encounters}</span>
              </div>
              <div className="note__meta-item">
                <span className="note__meta-label">{t.stage}</span>
                <StageDisplay stage={chunk.stage} status={chunk.status} />
              </div>
            </div>
            <div className="note__example">
              <span className="note__example-label">{t.example}</span>
              {chunk.example}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
