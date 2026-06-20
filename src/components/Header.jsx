import { CefrPicker } from './CefrPicker.jsx';
import { useI18n } from '../i18n/I18nProvider.jsx';

export function Header({
  cefrBand,
  onCefrChange,
  reviewing = 0,
  graduated = 0,
  currentPage,
  totalPages,
}) {
  const { locale, setLocale, t } = useI18n();

  return (
    <header className="header">
      <CefrPicker band={cefrBand} onChange={onCefrChange} />
      <div className="header__right">
        <div className="stats">
          <span className="stat">
            <span className="stat__num">{reviewing}</span> {t.reviewing}
          </span>
          <span className="stat">
            <span className="stat__num">{graduated}</span> {t.graduated}
          </span>
          <span className="stat">
            <span className="stat__num">{currentPage}</span> / {totalPages}
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
    </header>
  );
}
