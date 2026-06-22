import { useI18n } from '../i18n/I18nProvider.jsx';
import { resolveChunkGloss } from '../lib/chunkGlosses.js';

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

export function ChunkDetailModal({ chunk, visible, onClose }) {
  const { locale, t } = useI18n();

  if (!visible || !chunk) return null;

  const gloss = resolveChunkGloss(chunk.text, chunk, locale);

  return (
    <div className="chunk-modal" role="dialog" aria-modal="true" aria-labelledby="chunk-modal-title">
      <button
        type="button"
        className="chunk-modal__backdrop"
        aria-label={t.close}
        onClick={onClose}
      />
      <div className="chunk-modal__panel">
        <button type="button" className="chunk-modal__close" onClick={onClose} aria-label={t.close}>
          ×
        </button>
        <div className="note">
          <span className="note__chunk" id="chunk-modal-title">{chunk.text}</span>
          {gloss ? <div className="note__translation">{gloss}</div> : null}
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
      </div>
    </div>
  );
}
