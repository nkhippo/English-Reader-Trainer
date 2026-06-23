import { useState } from 'react';
import { CefrPicker } from './CefrPicker.jsx';
import { CombinedProgress } from './CombinedProgress.jsx';
import { ReaderMenu } from './ReaderMenu.jsx';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { bandLabel } from '../lib/cefr.js';

export function Header({
  compact = false,
  cefrBand,
  onCefrChange,
  reviewing = 0,
  graduated = 0,
  total = 0,
  encountered = 0,
  remainingSeconds,
  showTimer = false,
}) {
  const { locale, setLocale, t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  if (compact) {
    return (
      <>
        <header className="header header--compact">
          <button
            type="button"
            className="header__menu-btn"
            onClick={() => setMenuOpen(true)}
            aria-label={t.readerMenuOpen}
            aria-expanded={menuOpen}
          >
            ≡
          </button>
          <span className="header__band">{bandLabel(cefrBand)}</span>
          {showTimer ? (
            <span className="header__timer" role="timer" aria-live="off">
              {t.timeRemainingShort(remainingSeconds)}
            </span>
          ) : (
            <span className="header__timer header__timer--placeholder" aria-hidden="true" />
          )}
        </header>
        <ReaderMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          cefrBand={cefrBand}
          onCefrChange={(band) => {
            onCefrChange(band);
            setMenuOpen(false);
          }}
          reviewing={reviewing}
          graduated={graduated}
          total={total}
          encountered={encountered}
        />
      </>
    );
  }

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
      <CombinedProgress encountered={encountered} graduated={graduated} total={total} />
    </header>
  );
}
