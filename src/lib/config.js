// Deployed GAS backend (Web App). Safe to commit — no secrets in this URL.
export const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbyqaGlLgSw_POF68109IsHNF4wy8sGyBcmYGCcU4BIAMlN6j6WCDXq0WeCe4vUtA291/exec';

export const USER_ID = 'naoya';

// Passive encounter is logged after this many seconds on a passage.
export const READING_TIME_LIMIT_SEC = 30;

// Probability (0–1) that one target chunk is shown as a cloze blank per passage.
export const CLOZE_PROBABILITY = 0.3;

// GAS Script Properties (not used by frontend — reference for backend setup)
export const SPREADSHEET_ID = '1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw';
export const DRIVE_ROOT_ID = '1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI';
