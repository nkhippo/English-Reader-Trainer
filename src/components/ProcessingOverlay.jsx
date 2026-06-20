import { useI18n } from '../i18n/I18nProvider.jsx';

export function ProcessingOverlay({ visible }) {
  const { t } = useI18n();

  if (!visible) return null;

  return (
    <div className="processing-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="processing-overlay__content">
        <span className="processing-overlay__spinner" aria-hidden="true" />
        <p className="processing-overlay__label">{t.processing}</p>
      </div>
    </div>
  );
}
