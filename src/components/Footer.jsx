import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';

export function Footer({
  onNext,
  onSuspend,
  actionsDisabled,
  isProcessing,
  suspendDisabled,
  suspendQueued,
}) {
  const { t } = useI18n();
  const [optimisticProcessing, setOptimisticProcessing] = useState(false);
  const showProcessing = isProcessing || optimisticProcessing;

  useEffect(() => {
    if (!isProcessing) setOptimisticProcessing(false);
  }, [isProcessing]);

  useEffect(() => {
    if (!optimisticProcessing) return undefined;
    const timer = setTimeout(() => setOptimisticProcessing(false), 15000);
    return () => clearTimeout(timer);
  }, [optimisticProcessing]);

  const handleNext = useCallback(() => {
    if (actionsDisabled || optimisticProcessing) return;
    setOptimisticProcessing(true);
    void Promise.resolve(onNext());
  }, [actionsDisabled, onNext, optimisticProcessing]);

  return (
    <footer className="footer">
      <div className="footer__left" />
      <div className="footer__center">
        <button
          className={`btn btn--ghost ${suspendQueued ? 'btn--suspend-queued' : ''}`}
          onClick={onSuspend}
          disabled={suspendDisabled}
          aria-pressed={suspendQueued || undefined}
        >
          {suspendQueued ? t.suspendQueued : t.suspend}
        </button>
      </div>
      <div className="footer__right">
        <button
          type="button"
          className={`btn btn--primary ${showProcessing ? 'btn--processing' : ''}`}
          onClick={handleNext}
          disabled={actionsDisabled || optimisticProcessing}
          aria-busy={showProcessing || undefined}
        >
          {showProcessing ? (
            <>
              <span className="btn__spinner" aria-hidden="true" />
              {t.nextProcessing}
            </>
          ) : (
            t.nextPassage
          )}
        </button>
      </div>
    </footer>
  );
}
