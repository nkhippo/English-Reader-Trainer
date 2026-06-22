import { useI18n } from '../i18n/I18nProvider.jsx';

export function ReaderHintPanel() {
  const { t } = useI18n();

  return (
    <aside className="reader-hint" aria-label={t.chunkInteractionHint}>
      <p className="reader-hint__text">{t.chunkInteractionHint}</p>
      <ul className="reader-hint__legend">
        <li>
          <span className="reader-hint__swatch reader-hint__swatch--pending" aria-hidden="true" />
          {t.chunkEvalLegendPending}
        </li>
        <li>
          <span className="reader-hint__swatch reader-hint__swatch--ok" aria-hidden="true" />
          {t.chunkOk}
        </li>
        <li>
          <span className="reader-hint__swatch reader-hint__swatch--hold" aria-hidden="true" />
          {t.chunkHold}
        </li>
      </ul>
    </aside>
  );
}
