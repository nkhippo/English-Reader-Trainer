/** Wrap bare IPA symbols for display: sɪt daʊn → /sɪt daʊn/ */
export function formatChunkIpaDisplay(ipa) {
  const raw = String(ipa || '').trim();
  if (!raw) return null;
  return `/${raw}/`;
}

/** Passage highlight text: spelling default, IPA when mode is ipa and data exists. */
export function formatChunkPassageText(chunk, displayMode, fallbackText) {
  const spelling = fallbackText || chunk?.text || '';
  if (displayMode !== 'ipa') return spelling;
  return formatChunkIpaDisplay(chunk?.ipa) || spelling;
}
