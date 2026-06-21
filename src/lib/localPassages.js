import passageTemplates from '../../shared/passage-templates.json';
import { resolveChunkEn, resolveChunkJa } from './chunkGlosses.js';
import { makeChunkId } from './chunkId.js';

const CEFR_BY_BAND = {
  A1A2: 'A2',
  B1: 'B1',
  B2: 'B2',
};

export function getBandTemplates(band) {
  return passageTemplates[band] || passageTemplates.B1 || [];
}

export async function templateToPassage(tpl) {
  const defaultCefr = CEFR_BY_BAND[tpl.cefr_band] || 'B1';
  const chunks = await Promise.all(
    (tpl.chunk_texts || []).map(async (text) => ({
      id: await makeChunkId(text),
      text,
      ja: resolveChunkJa(text, ''),
      en: resolveChunkEn(text, ''),
      cefr: defaultCefr,
      encounters: 0,
      stage: 0,
      status: 'new',
      example: '',
    })),
  );

  return {
    id: tpl.passage_id,
    cefr: tpl.cefr_band,
    text: tpl.text_markup,
    ja: tpl.ja_translation || '',
    chunks,
  };
}

export async function pickUnseenBandTemplate(band, seenIds) {
  const seen = new Set(seenIds);
  const candidates = getBandTemplates(band).filter((t) => !seen.has(t.passage_id));
  if (candidates.length === 0) {
    const all = getBandTemplates(band);
    if (all.length === 0) return null;
    return templateToPassage(all[Math.floor(Math.random() * all.length)]);
  }
  const tpl = candidates[Math.floor(Math.random() * candidates.length)];
  return templateToPassage(tpl);
}
