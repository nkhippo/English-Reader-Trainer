export const CEFR_BANDS = [
  { id: 'A1A2', label: 'A1+A2' },
  { id: 'B1', label: 'B1' },
  { id: 'B2', label: 'B2' },
];

export const DEFAULT_CEFR_BAND = 'B1';

const STORAGE_KEY = 'ert_cefr_band';

export function getStoredCefrBand() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (CEFR_BANDS.some((b) => b.id === stored)) return stored;
  return DEFAULT_CEFR_BAND;
}

export function storeCefrBand(band) {
  localStorage.setItem(STORAGE_KEY, band);
}

export function bandLabel(bandId) {
  return CEFR_BANDS.find((b) => b.id === bandId)?.label ?? bandId;
}
