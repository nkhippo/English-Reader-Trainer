import { fallbackChunkJa } from '../data/chunkTranslations.js';

function resolveChunkJa(chunk) {
  const ja = chunk.ja_translation || chunk.ja || '';
  if (ja.trim()) return ja;
  return fallbackChunkJa(chunk.text);
}

/** Normalize GAS /generate_passage response for useReader. */
export function normalizePassagesFromApi(apiPassages = []) {
  return apiPassages.map((p) => ({
    id: p.passage_id || p.id,
    cefr: p.cefr_band || p.cefr,
    text: p.text_markup || p.text,
    ja: p.ja_translation || p.ja || '',
    chunks: (p.target_chunks || p.chunks || []).map((c) => ({
      id: c.chunk_id || c.id,
      text: c.text,
      ja: resolveChunkJa(c),
      cefr: c.cefr,
      encounters: c.encounters ?? 0,
      stage: c.srs_stage ?? c.stage ?? 0,
      status: c.status || 'new',
      example: c.example_sentence || c.example || '',
    })),
  }));
}
