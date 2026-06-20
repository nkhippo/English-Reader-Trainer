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
  return (
    <aside className={`marginalia ${isOpen ? 'is-open' : ''}`}>
      <button className="marginalia__close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className={`marginalia__content ${isFading ? 'is-fading' : ''}`}>
        {!chunk ? (
          <div className="marginalia__empty">Tap any highlighted phrase to read its note.</div>
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
                <span className="note__meta-label">Encounters</span>
                <span className="note__meta-value">{chunk.encounters}</span>
              </div>
              <div className="note__meta-item">
                <span className="note__meta-label">Stage</span>
                <StageDots stage={chunk.stage} />
              </div>
            </div>
            <div className="note__example">
              <span className="note__example-label">Example</span>
              {chunk.example}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
