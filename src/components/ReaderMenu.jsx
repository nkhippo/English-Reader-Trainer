import { useEffect, useRef } from 'react';
import { CefrPicker } from './CefrPicker.jsx';
import { CombinedProgress } from './CombinedProgress.jsx';
import { DisplayModeSwitch } from './DisplayModeSwitch.jsx';
import { useI18n } from '../i18n/I18nProvider.jsx';

export function ReaderMenu({
  open,
  onClose,
  cefrBand,
  onCefrChange,
  reviewing,
  graduated,
  total,
  encountered,
  displayMode,
  onDisplayModeChange,
}) {
  const { locale, setLocale, t } = useI18n();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="reader-menu" role="dialog" aria-modal="true" aria-label={t.readerMenuAria}>
      <button type="button" className="reader-menu__backdrop" aria-label={t.close} onClick={onClose} />
      <div ref={panelRef} className="reader-menu__panel">
        <div className="reader-menu__head">
          <h2 className="reader-menu__title">{t.readerMenuTitle}</h2>
          <button type="button" className="reader-menu__close" onClick={onClose} aria-label={t.close}>
            ×
          </button>
        </div>

        <section className="reader-menu__section">
          <h3 className="reader-menu__section-label">{t.cefrGroupAria}</h3>
          <CefrPicker band={cefrBand} onChange={onCefrChange} />
        </section>

        <section className="reader-menu__section">
          <h3 className="reader-menu__section-label">{t.displayModeAria}</h3>
          <DisplayModeSwitch mode={displayMode} onChange={onDisplayModeChange} />
        </section>

        <section className="reader-menu__section">
          <h3 className="reader-menu__section-label">{t.langGroupAria}</h3>
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
        </section>

        <section className="reader-menu__section">
          <div className="stats stats--menu">
            <span className="stat">
              <span className="stat__num">{reviewing}</span> {t.reviewing}
            </span>
            <span className="stat">
              <span className="stat__num">{graduated}</span> {t.graduated}
            </span>
          </div>
          <CombinedProgress encountered={encountered} graduated={graduated} total={total} />
        </section>
      </div>
    </div>
  );
}
