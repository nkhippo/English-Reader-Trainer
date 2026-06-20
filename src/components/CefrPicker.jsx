import { CEFR_BANDS } from '../lib/cefr.js';
import { useI18n } from '../i18n/I18nProvider.jsx';

export function CefrPicker({ band, onChange }) {
  const { t } = useI18n();

  return (
    <div className="cefr-picker" role="group" aria-label={t.cefrGroupAria}>
      {CEFR_BANDS.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`cefr-picker__btn ${b.id === band ? 'cefr-picker__btn--active' : ''}`}
          onClick={() => onChange(b.id)}
          aria-pressed={b.id === band}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
