/** Match GAS makeChunkId_ — SHA-256 of lowercased trimmed text, first 8 hex chars. */
export async function makeChunkId(text) {
  const normalized = String(text || '').toLowerCase().trim();
  const data = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `ch_${hex.slice(0, 8)}`;
}
