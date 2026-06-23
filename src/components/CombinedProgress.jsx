import { useI18n } from '../i18n/I18nProvider.jsx';

export function CombinedProgress({ encountered = 0, graduated = 0, total = 0 }) {
  const { t } = useI18n();
  const exposurePct = total > 0 ? Math.min(100, (encountered / total) * 100) : 0;
  const gradPct = total > 0 ? Math.min(100, (graduated / total) * 100) : 0;

  return (
    <div className="combined-progress" role="group" aria-label={t.progressCombinedAria}>
      <div className="combined-progress__meta">
        <span className="combined-progress__label">{t.progressCombinedLabel}</span>
        <span className="combined-progress__nums">
          {t.progressCombinedNums(encountered, graduated, total)}
        </span>
      </div>
      <div className="combined-progress__track" aria-hidden="true">
        <div className="combined-progress__exposure" style={{ width: `${exposurePct}%` }} />
        <div className="combined-progress__graduation" style={{ width: `${gradPct}%` }} />
      </div>
    </div>
  );
}
