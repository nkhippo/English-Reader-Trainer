export const LOCALES = ['ja', 'en'];

const STORAGE_KEY = 'ert_locale';

export function getStoredLocale() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (LOCALES.includes(stored)) return stored;
  return navigator.language.startsWith('ja') ? 'ja' : 'en';
}

export function storeLocale(locale) {
  localStorage.setItem(STORAGE_KEY, locale);
}

export const translations = {
  en: {
    reviewing: 'reviewing',
    graduated: 'graduated',
    stillHard: 'Still hard',
    gotIt: 'Got it →',
    marginaliaEmpty: 'Tap any highlighted phrase to read its note.',
    encounters: 'Encounters',
    stage: 'Stage',
    stageProgress: (n) => `${n}/5`,
    stageNew: 'New',
    example: 'Example',
    close: 'Close',
    passageIndicator: (num, cefr) => `PASSAGE ${num} · ${cefr}`,
    langGroupAria: 'Language',
    cefrGroupAria: 'CEFR level',
    loading: 'Loading…',
    processing: 'Saving…',
    processingPauseHint: 'Tap Pause to wait for the next passage after saving finishes.',
    processingPauseQueued: 'Saving… Will wait when done.',
    suspendQueued: 'Waiting',
    startReading: 'Start reading',
    startHint: 'Press start when you are ready. The timer begins once you begin reading.',
    resumeReading: 'Resume',
    pauseHint: 'Reading is paused. Resume when you are ready to continue.',
    suspend: 'Pause',
    timeRemaining: (sec) => `${sec}s left`,
    clozeReveal: 'Tap to reveal the hidden phrase',
  },
  ja: {
    reviewing: '復習中',
    graduated: '習得済み',
    stillHard: 'まだ難しい',
    gotIt: '理解した →',
    marginaliaEmpty: 'ハイライトされた語句をタップすると解説が表示されます。',
    encounters: '出会い回数',
    stage: '段階',
    stageProgress: (n) => `${n}/5`,
    stageNew: '未習得',
    example: '例文',
    close: '閉じる',
    passageIndicator: (num, cefr) => `パッサージ ${num} · ${cefr}`,
    langGroupAria: '言語',
    cefrGroupAria: 'CEFR レベル',
    loading: '読み込み中…',
    processing: '処理中…',
    processingPauseHint: '「中断」を押すと、保存完了後に次の問題を自動開始しません。',
    processingPauseQueued: '処理中… 完了後に待機します',
    suspendQueued: '待機する',
    startReading: '読み始める',
    startHint: '準備ができたら開始してください。タイマーは読み始めてからカウントされます。',
    resumeReading: '再開する',
    pauseHint: '中断中です。準備ができたら再開してください。',
    suspend: '中断',
    timeRemaining: (sec) => `残り ${sec} 秒`,
    clozeReveal: 'タップして隠れた語句を表示',
  },
};
