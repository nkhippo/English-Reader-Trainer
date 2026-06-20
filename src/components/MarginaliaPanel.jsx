import { useI18n } from '../i18n/I18nProvider.jsx';

function StageDots({ stage }) {
  return (
    <span className="stage-dots">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={`dot ${i < stage ? 'dot--filled' : ''}`} />
      ))}
    </span>
  );
}

export function MarginaliaPanel({ chunk, isOpen, onClose, isFading }) {
  const { t } = useI18n();

  return (
    <aside className={`marginalia ${isOpen ? 'is-open' : ''}`}>
      <button className="marginalia__close" onClick={onClose} aria-label={t.close}>
        ×
      </button>
      <div className={`marginalia__content ${isFading ? 'is-fading' : ''}`}>
        {!chunk ? (
          <div className="marginalia__empty">{t.marginaliaEmpty}</div>
        ) : (
          <div className="note">
            <span className="note__chunk">{chunk.text}</span>
            <div className="note__translation">{chunk.ja}</div>
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
                <span className="note__meta-value note__stage">
                  <span className="note__stage-count">{t.stageProgress(chunk.stage)}</span>
                  <StageDots stage={chunk.stage} />
                </span>
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
