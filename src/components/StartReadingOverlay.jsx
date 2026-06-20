import { useI18n } from '../i18n/I18nProvider.jsx';

export function StartReadingOverlay({ visible, onStart }) {
  const { t } = useI18n();

  if (!visible) return null;

  return (
    <div className="start-overlay" role="dialog" aria-modal="true" aria-labelledby="start-overlay-title">
      <div className="start-overlay__panel">
        <p id="start-overlay-title" className="start-overlay__hint">
          {t.startHint}
        </p>
        <button type="button" className="btn btn--primary start-overlay__btn" onClick={onStart}>
          {t.startReading}
        </button>
      </div>
    </div>
  );
}
