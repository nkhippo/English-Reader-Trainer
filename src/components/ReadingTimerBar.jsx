import { useI18n } from '../i18n/I18nProvider.jsx';
import { READING_TIME_LIMIT_SEC } from '../lib/config.js';

export function ReadingTimerBar({ visible, remainingSeconds }) {
  const { t } = useI18n();

  if (!visible) return null;

  const progress = Math.max(0, Math.min(1, remainingSeconds / READING_TIME_LIMIT_SEC));

  return (
    <div className="reading-timer" role="timer" aria-live="off">
      <div className="reading-timer__track" aria-hidden="true">
        <div className="reading-timer__fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="reading-timer__label">{t.timeRemaining(remainingSeconds)}</span>
    </div>
  );
}
