import { useI18n } from '../i18n/I18nProvider.jsx';

export function Footer({ onStillHard, onGotIt, hardFlash, disabled }) {
  const { t } = useI18n();

  return (
    <footer className="footer">
      <button
        className={`btn btn--ghost ${hardFlash ? 'btn--hard-flash' : ''}`}
        onClick={onStillHard}
        disabled={disabled}
      >
        ⊘ {t.stillHard}
      </button>
      <button className="btn btn--primary" onClick={onGotIt} disabled={disabled}>
        {t.gotIt}
      </button>
    </footer>
  );
}
