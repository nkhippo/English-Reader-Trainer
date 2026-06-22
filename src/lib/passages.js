import { resolveChunkEn, resolveChunkJa } from './chunkGlosses.js';
import { ensureTextMarkup } from './passageMarkup.js';

/** Normalize GAS /generate_passage response for useReader. */
export function normalizePassagesFromApi(apiPassages = []) {
  return apiPassages.map((p) => {
    const chunks = (p.target_chunks || p.chunks || []).map((c) => ({
      id: c.chunk_id || c.id,
      text: c.text,
      ja: resolveChunkJa(c.text, c.ja_translation || c.ja),
      en: resolveChunkEn(c.text, c.en_translation || c.en),
      cefr: c.cefr,
      encounters: c.encounters ?? 0,
      stage: c.srs_stage ?? c.stage ?? 0,
      status: c.status || 'new',
      example: c.example_sentence || c.example || '',
    }));
    return {
      id: p.passage_id || p.id,
      cefr: p.cefr_band || p.cefr,
      text: ensureTextMarkup(p.text_markup || p.text, chunks),
      ja: p.ja_translation || p.ja || '',
      chunks,
    };
  });
}
