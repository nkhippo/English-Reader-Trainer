import { CefrPicker } from './CefrPicker.jsx';
import { useI18n } from '../i18n/I18nProvider.jsx';

function BandProgress({ label, current, total, variant }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const fillWidth = total > 0 ? Math.min(100, (current / total) * 100) : 0;

  return (
    <div className="band-progress" role="group" aria-label={`${label} ${pct}%`}>
      <div className="band-progress__meta">
        <span className="band-progress__label">{label}</span>
        <span className="band-progress__nums">
          {current.toLocaleString()} / {total.toLocaleString()}
        </span>
        <span className="band-progress__pct">{pct}%</span>
      </div>
      <div className="band-progress__track" aria-hidden="true">
        <div
          className={`band-progress__fill band-progress__fill--${variant}`}
          style={{ width: `${fillWidth}%` }}
        />
      </div>
    </div>
  );
}

export function Header({
  cefrBand,
  onCefrChange,
  reviewing = 0,
  graduated = 0,
  total = 0,
  encountered = 0,
}) {
  const { locale, setLocale, t } = useI18n();

  return (
    <header className="header">
      <div className="header__top">
        <CefrPicker band={cefrBand} onChange={onCefrChange} />
        <div className="header__right">
          <div className="stats">
            <span className="stat">
              <span className="stat__num">{reviewing}</span> {t.reviewing}
            </span>
            <span className="stat">
              <span className="stat__num">{graduated}</span> {t.graduated}
            </span>
          </div>
          <div className="lang-switch" role="group" aria-label={t.langGroupAria}>
            <button
              type="button"
              className={`lang-switch__btn ${locale === 'ja' ? 'lang-switch__btn--active' : ''}`}
              onClick={() => setLocale('ja')}
              aria-pressed={locale === 'ja'}
            >
              日本語
            </button>
            <button
              type="button"
              className={`lang-switch__btn ${locale === 'en' ? 'lang-switch__btn--active' : ''}`}
              onClick={() => setLocale('en')}
              aria-pressed={locale === 'en'}
            >
              EN
            </button>
          </div>
        </div>
      </div>
      <div className="header__progress">
        <BandProgress
          label={t.progressFirstExposure}
          current={encountered}
          total={total}
          variant="exposure"
        />
        <BandProgress
          label={t.progressGraduation}
          current={graduated}
          total={total}
          variant="graduation"
        />
      </div>
    </header>
  );
}
