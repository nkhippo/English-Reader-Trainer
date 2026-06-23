import { useI18n } from '../i18n/I18nProvider.jsx';

export function DisplayModeSwitch({ mode, onChange }) {
  const { t } = useI18n();

  return (
    <div className="display-mode-switch" role="group" aria-label={t.displayModeAria}>
      <button
        type="button"
        className={`display-mode-switch__btn ${mode === 'spelling' ? 'display-mode-switch__btn--active' : ''}`}
        onClick={() => onChange('spelling')}
        aria-pressed={mode === 'spelling'}
      >
        {t.displayModeSpelling}
      </button>
      <button
        type="button"
        className={`display-mode-switch__btn ${mode === 'ipa' ? 'display-mode-switch__btn--active' : ''}`}
        onClick={() => onChange('ipa')}
        aria-pressed={mode === 'ipa'}
      >
        {t.displayModeIpa}
      </button>
    </div>
  );
}
