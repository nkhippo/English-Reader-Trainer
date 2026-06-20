import { useI18n } from '../i18n/I18nProvider.jsx';

export function Footer({
  onStillHard,
  onGotIt,
  onSuspend,
  hardFlash,
  actionsDisabled,
  suspendDisabled,
}) {
  const { t } = useI18n();

  return (
    <footer className="footer">
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
        <button className="btn btn--ghost" onClick={onSuspend} disabled={suspendDisabled}>
          {t.suspend}
        </button>
      </div>
      <div className="footer__right">
        <button className="btn btn--primary" onClick={onGotIt} disabled={actionsDisabled}>
          {t.gotIt}
        </button>
      </div>
    </footer>
  );
}
