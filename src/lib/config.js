// Deployed GAS backend (Web App). Safe to commit — no secrets in this URL.
export const DEFAULT_GAS_URL =
  'https://script.google.com/macros/s/AKfycbwF-TlzAlKx4syPKfrzUmPKlvxhDiAHbM2YKQ0DGkcMqSXUnvGwyU0Y5V9xGhNNwboV/exec';

export const USER_ID = 'naoya';

// Passive encounter is no longer logged — timer is display-only reading guide.
export const READING_TIME_LIMIT_SEC = 60;

// Probability (0–1) that one target chunk is shown as a cloze blank per passage.
export const CLOZE_PROBABILITY = 0.3;

/** Number of passages to prefetch ahead while reading. */
export const PREFETCH_QUEUE_SIZE = 1;

/** Max wait for GAS on "Got it" advance before local fallback (ms). */
export const ADVANCE_GAS_TIMEOUT_MS = 3500;

// GAS Script Properties (not used by frontend — reference for backend setup)
export const SPREADSHEET_ID = '1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw';
export const DRIVE_ROOT_ID = '1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI';
