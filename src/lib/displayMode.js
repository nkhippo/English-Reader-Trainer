export const DISPLAY_MODES = ['spelling', 'ipa'];

const STORAGE_KEY = 'ert_display_mode';

export function getStoredDisplayMode() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (DISPLAY_MODES.includes(stored)) return stored;
  return 'spelling';
}

export function storeDisplayMode(mode) {
  localStorage.setItem(STORAGE_KEY, mode);
}
