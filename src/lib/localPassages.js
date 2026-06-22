import passageTemplates from '../../shared/passage-templates.json';
import { resolveChunkEn, resolveChunkJa } from './chunkGlosses.js';
import { makeChunkId } from './chunkId.js';
import { ensureTextMarkup } from './passageMarkup.js';

const CEFR_BY_BAND = {
  A1A2: 'A2',
  B1: 'B1',
  B2: 'B2',
};

export function getBandTemplates(band) {
  return passageTemplates[band] || passageTemplates.B1 || [];
}

function templateHasExcludedChunk(tpl, exclude) {
  if (!exclude?.size) return false;
  return (tpl.chunk_texts || []).some(
    (text) => exclude.has(String(text).toLowerCase().trim()),
  );
}

/** Rough tense label for local template variety when GAS is unavailable. */
function templateTenseHint(tpl) {
  const t = String(tpl.text_markup || '').toLowerCase();
  if (/\b(yesterday|last |ago|was |were |had |did |walked|stopped|decided)\b/.test(t)) return 'past';
  if (/\b(will |going to |tomorrow)\b/.test(t)) return 'future';
  return 'present';
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
    text: ensureTextMarkup(tpl.text_markup, chunks),
    ja: tpl.ja_translation || '',
    chunks,
  };
}

export async function pickUnseenBandTemplate(band, seenIds, excludeTexts = [], lastPassageId = null) {
  const seen = new Set(seenIds);
  const exclude = new Set(
    (excludeTexts || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
  );

  const unseen = getBandTemplates(band).filter((t) => !seen.has(t.passage_id));
  let pool = unseen.filter((t) => !templateHasExcludedChunk(t, exclude));

  if (pool.length === 0) {
    // Never relax chunk exclusion — only allow re-seen passage ids as last resort.
    pool = getBandTemplates(band).filter((t) => !templateHasExcludedChunk(t, exclude));
    if (pool.length === 0) return null;
  }

  const lastTpl = lastPassageId
    ? getBandTemplates(band).find((t) => t.passage_id === lastPassageId)
    : null;
  const lastTense = lastTpl ? templateTenseHint(lastTpl) : null;
  if (lastTense) {
    const altTense = pool.filter((t) => templateTenseHint(t) !== lastTense);
    if (altTense.length) pool = altTense;
  }

  const tpl = pool[Math.floor(Math.random() * pool.length)];
  return templateToPassage(tpl);
}
