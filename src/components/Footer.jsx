import { useI18n } from '../i18n/I18nProvider.jsx';

export function Footer({
  onStillHard,
  onGotIt,
  onSuspend,
  hardFlash,
  actionsDisabled,
  isProcessing,
  suspendDisabled,
  suspendQueued,
}) {
  const { t } = useI18n();
  const footerClass = isProcessing ? 'footer footer--processing' : 'footer';

  return (
    <footer className={footerClass}>
      <div className="footer__left">
        <button
          className={`btn btn--ghost ${hardFlash ? 'btn--hard-flash' : ''}`}
          onClick={onStillHard}
          disabled={actionsDisabled}
        >
          ⊘ {t.stillHard}
        </button>
      </div>
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
          className={`btn btn--primary ${isProcessing ? 'btn--processing' : ''}`}
          onClick={onGotIt}
          disabled={actionsDisabled}
          aria-busy={isProcessing || undefined}
        >
          {isProcessing ? (
            <>
              <span className="btn__spinner" aria-hidden="true" />
              {t.gotItProcessing}
            </>
          ) : (
            t.gotIt
          )}
        </button>
      </div>
    </footer>
  );
}
