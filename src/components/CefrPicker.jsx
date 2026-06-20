import { useEffect, useRef, useState } from 'react';
import { CEFR_BANDS } from '../lib/cefr.js';
import { useI18n } from '../i18n/I18nProvider.jsx';

export function CefrPicker({ band, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { t } = useI18n();
  const label = CEFR_BANDS.find((b) => b.id === band)?.label ?? band;

  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  return (
    <div className="cefr-picker" ref={ref}>
      <button
        type="button"
        className="level-pill level-pill--btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t.cefrGroupAria}
      >
        <span className="level-pill__dot" />
        {label}
      </button>
      {open && (
        <ul className="cefr-picker__menu" role="listbox">
          {CEFR_BANDS.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                role="option"
                aria-selected={b.id === band}
                className={`cefr-picker__item ${b.id === band ? 'cefr-picker__item--active' : ''}`}
                onClick={() => {
                  onChange(b.id);
                  setOpen(false);
                }}
              >
                {b.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
