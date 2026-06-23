const CHUNK_HINT_KEY = 'ert_chunk_hint_seen';

export function hasSeenChunkHint() {
  return localStorage.getItem(CHUNK_HINT_KEY) === '1';
}

export function markChunkHintSeen() {
  localStorage.setItem(CHUNK_HINT_KEY, '1');
}
