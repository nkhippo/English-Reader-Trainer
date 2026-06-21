/**
 * English Reader Trainer — Backend (Phase 3)
 *
 * Script Properties:
 *   SPREADSHEET_ID, DRIVE_ROOT_ID
 *   ANTHROPIC_API_KEY — for ja_translation / en_translation batches
 *   USE_DYNAMIC_PASSAGES — set to "true" to enable Claude passage generation (Phase 4)
 *
 * Manual setup (Apps Script editor):
 *   1. setupSheets() — once
 *   2. importChunksFromCefr() — after cefr_*.json in Drive shared/
 *   3. enrichAllTranslations() — runs until remaining = 0 (auto-continues via trigger if needed)
 *   4. migrateChunksAddEnTranslationColumn() — once on existing spreadsheets
 *   5. enrichAllEnglishGlosses() — runs until remaining = 0
 *   6. Redeploy Web App after code changes
 */

const SHEET_NAMES = {
  CHUNKS: 'chunks_master',
  PROGRESS: 'user_progress',
  PASSAGES: 'passages_meta',
  ENCOUNTERS: 'encounter_log',
};

const SHEET_HEADERS = {
  [SHEET_NAMES.CHUNKS]: [
    'chunk_id', 'text', 'type', 'cefr', 'pos', 'ja_translation', 'en_translation',
    'example_sentence', 'audio_drive_url', 'created_at',
  ],
  [SHEET_NAMES.PROGRESS]: [
    'user_id', 'chunk_id', 'encounter_count', 'distinct_passages_count',
    'last_encountered_at', 'next_due_at', 'srs_stage', 'status',
    'got_it_count', 'still_hard_count',
  ],
  [SHEET_NAMES.PASSAGES]: [
    'passage_id', 'cefr', 'drive_file_id', 'target_chunk_ids',
    'word_count', 'audio_drive_url', 'generated_at',
  ],
  [SHEET_NAMES.ENCOUNTERS]: [
    'event_id', 'user_id', 'chunk_id', 'passage_id',
    'read_at', 'signal', 'time_on_page_ms',
  ],
};

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
/** Items per Claude call for ja/en enrichment batches (was 25). */
const ENRICH_BATCH_SIZE = 125;
/** Output token budget — scale with batch size to avoid truncated JSON. */
const ENRICH_JA_MAX_TOKENS = 16384;
const ENRICH_EN_MAX_TOKENS = 8192;
/** Stop batching slightly before the 6-min GAS limit and chain a trigger. */
const ENRICH_MAX_RUNTIME_MS = 5.5 * 60 * 1000;
const ENRICH_CONTINUE_DELAY_MS = 30 * 1000;
const ENRICH_CONTINUE_HANDLER = 'enrichAllTranslationsContinue_';
const ENRICH_EN_CONTINUE_HANDLER = 'enrichAllEnglishGlossesContinue_';

// ===== HTTP =====

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return jsonResponse(dispatchAction_(body));
  } catch (err) {
    return jsonResponse({ error: String(err && err.message || err) });
  }
}

function doGet(e) {
  if (e.parameter.data) {
    try {
      const body = JSON.parse(e.parameter.data);
      return jsonResponse(dispatchAction_(body));
    } catch (err) {
      return jsonResponse({ error: String(err && err.message || err) });
    }
  }

  let chunksCount = 0;
  try {
    chunksCount = Math.max(0, getSheet_(SHEET_NAMES.CHUNKS).getLastRow() - 1);
  } catch (err) { /* sheet not ready */ }
  return jsonResponse({
    status: 'ok',
    service: 'english-reader-trainer',
    phase: 4,
    chunks_master_count: chunksCount,
  });
}

function dispatchAction_(body) {
  const action = body.action;
  if (action === 'session') return handleSession_(body);
  if (action === 'due_chunks') return handleDueChunks_(body);
  if (action === 'generate_passage') return handleGeneratePassage_(body);
  if (action === 'log_encounter') return handleLogEncounter_(body);
  if (action === 'update_progress') return handleUpdateProgress_(body);
  if (action === 'stats') return handleStats_(body);
  return { error: `Unknown action: ${action}` };
}

// ===== Setup =====

function setupSheets() {
  const ss = getSpreadsheet_();
  Object.entries(SHEET_HEADERS).forEach(([name, headers]) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  });
  setupDriveFolders_();
  Logger.log('Sheets and Drive folders initialized.');
}

function setupDriveFolders_() {
  const root = getDriveRoot_();
  ['passages', 'audio', 'manifest', 'shared'].forEach((name) => {
    getOrCreateSubfolder_(root, name);
  });
}

// ===== Phase 2: Import from Drive shared/ =====

/** Run manually after uploading cefr_words.json & cefr_chunks.json to shared/ */
function importChunksFromCefr() {
  const wordsData = readSharedJson_('cefr_words.json');
  const chunksData = readSharedJson_('cefr_chunks.json');
  const wordEntries = wordsData.entries || [];
  const chunkEntries = chunksData.entries || [];
  const now = new Date().toISOString();
  const rows = [];

  wordEntries.forEach((entry) => {
    rows.push(buildChunkRow_(entry, entry.type || 'word', entry.pos || '', '', now));
  });
  chunkEntries.forEach((entry) => {
    rows.push(buildChunkRow_(entry, entry.type || 'chunk', '', entry.example || '', now));
  });

  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }

  writeRowsInBatches_(sheet, rows);
  Logger.log(`Imported ${rows.length} entries (${wordEntries.length} words, ${chunkEntries.length} chunks).`);
  return { imported: rows.length, words: wordEntries.length, chunks: chunkEntries.length };
}

function buildChunkRow_(entry, type, pos, example, now) {
  const text = entry.text;
  return [
    makeChunkId_(text),
    text,
    type,
    entry.cefr,
    pos || entry.pos || '',
    '',
    '',
    example || entry.example || '',
    '',
    now,
  ];
}

function writeRowsInBatches_(sheet, rows) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, batch.length, batch[0].length).setValues(batch);
  }
}

// ===== Phase 2: Claude ja_translation enrichment =====

/** Process up to ENRICH_BATCH_SIZE rows missing ja_translation. */
function enrichTranslationsBatch() {
  return enrichTranslationsBatch_(ENRICH_BATCH_SIZE);
}

/**
 * Enrich all chunks_master rows until remaining = 0.
 * Runs as many batches as fit in one execution, then schedules itself to continue.
 * Call stopEnrichAllTranslations() to cancel a queued continuation.
 */
function enrichAllTranslations() {
  clearEnrichContinueTriggers_();
  return enrichAllTranslationsRun_();
}

/** @deprecated Use enrichAllTranslations() — maxBatches is ignored; runs until done. */
function enrichAllTranslationsLegacy(maxBatches) {
  Logger.log('enrichAllTranslationsLegacy: use enrichAllTranslations() instead.');
  return enrichAllTranslations();
}

/** Trigger handler — do not run manually. */
function enrichAllTranslationsContinue_() {
  return enrichAllTranslationsRun_();
}

/** Cancel any scheduled enrichment continuation. */
function stopEnrichAllTranslations() {
  clearEnrichContinueTriggers_();
  const coverage = auditTranslationCoverage();
  Logger.log('Enrichment continuation stopped.');
  return { stopped: true, coverage };
}

function enrichAllTranslationsRun_() {
  const started = Date.now();
  let totalProcessed = 0;
  let batches = 0;
  let last = { processed: 0, remaining: -1, done: false };

  while (Date.now() - started < ENRICH_MAX_RUNTIME_MS) {
    last = enrichTranslationsBatch_(ENRICH_BATCH_SIZE);
    totalProcessed += last.processed;
    batches += 1;

    if (last.remaining === 0) {
      clearEnrichContinueTriggers_();
      const result = {
        processed: totalProcessed,
        batches,
        remaining: 0,
        done: true,
        continued: false,
      };
      Logger.log(JSON.stringify(result));
      return result;
    }

    if (last.processed === 0) break;
    Utilities.sleep(800);
  }

  const continued = last.remaining > 0;
  if (continued) scheduleEnrichContinue_();

  const result = {
    processed: totalProcessed,
    batches,
    remaining: last.remaining,
    done: !continued,
    continued,
    next_run_in_sec: continued ? ENRICH_CONTINUE_DELAY_MS / 1000 : 0,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function scheduleEnrichContinue_() {
  clearEnrichContinueTriggers_();
  ScriptApp.newTrigger(ENRICH_CONTINUE_HANDLER)
    .timeBased()
    .after(ENRICH_CONTINUE_DELAY_MS)
    .create();
}

function clearEnrichContinueTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === ENRICH_CONTINUE_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** Manual: report ja_translation coverage on chunks_master. */
function auditTranslationCoverage() {
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const total = Math.max(0, sheet.getLastRow() - 1);
  const remaining = countMissingTranslations_();
  const result = {
    total,
    covered: total - remaining,
    remaining,
    percent: total ? Math.round(((total - remaining) / total) * 100) : 100,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function enrichTranslationsBatch_(batchSize) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const pending = [];

  for (let r = 1; r < data.length && pending.length < batchSize; r++) {
    const ja = String(data[r][col.ja_translation] || '').trim();
    if (ja) continue;
    pending.push({
      row: r + 1,
      chunk_id: data[r][col.chunk_id],
      text: data[r][col.text],
      type: data[r][col.type],
      example_sentence: data[r][col.example_sentence] || '',
    });
  }

  if (pending.length === 0) {
    return { processed: 0, remaining: 0, done: true };
  }

  const enriched = callClaudeEnrich_(pending, apiKey);
  enriched.forEach((item) => {
    const row = pending.find((p) => p.chunk_id === item.chunk_id);
    if (!row) return;
    if (item.ja_translation) {
      sheet.getRange(row.row, col.ja_translation + 1).setValue(item.ja_translation);
    }
    if (item.example_sentence && !row.example_sentence) {
      sheet.getRange(row.row, col.example_sentence + 1).setValue(item.example_sentence);
    }
  });

  const remaining = countMissingTranslations_();
  return { processed: enriched.length, remaining, done: remaining === 0 };
}

function callClaudeEnrich_(items, apiKey) {
  const input = items.map((i) => ({
    chunk_id: i.chunk_id,
    text: i.text,
    type: i.type,
    example_sentence: i.example_sentence || null,
  }));

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: ENRICH_JA_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `You are a bilingual English-Japanese lexicographer. For each item, provide:
- ja_translation: concise natural Japanese (for chunks include 〜 where needed)
- example_sentence: English example (keep existing if provided, else create one natural 8-18 word sentence)

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","ja_translation":"...","example_sentence":"..."}]

Items:
${JSON.stringify(input)}`,
    }],
  };

  const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Anthropic ${res.getResponseCode()}: ${res.getContentText().slice(0, 400)}`);
  }

  const body = JSON.parse(res.getContentText());
  const text = body.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(jsonStr);
}

function countMissingTranslations_() {
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const jaCol = data[0].indexOf('ja_translation');
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (!String(data[r][jaCol] || '').trim()) count++;
  }
  return count;
}

// ===== Phase 2b: chunks_master schema + en_translation enrichment =====

/** Add en_translation column to an existing chunks_master sheet (safe to run multiple times). */
function migrateChunksAddEnTranslationColumn() {
  ensureChunksEnTranslationColumn_();
  return { ok: true };
}

function ensureChunksEnTranslationColumn_() {
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  if (sheet.getLastRow() < 1) return false;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('en_translation') >= 0) return true;
  const jaIdx = headers.indexOf('ja_translation');
  if (jaIdx < 0) throw new Error('chunks_master: ja_translation column not found');
  sheet.insertColumnAfter(jaIdx + 1);
  sheet.getRange(1, jaIdx + 2).setValue('en_translation');
  Logger.log('Added en_translation column to chunks_master.');
  return true;
}

/** Process up to ENRICH_BATCH_SIZE rows missing en_translation. */
function enrichEnglishGlossesBatch() {
  return enrichEnglishGlossesBatch_(ENRICH_BATCH_SIZE);
}

/** Enrich all rows until en_translation remaining = 0 (auto-continues via trigger). */
function enrichAllEnglishGlosses() {
  clearEnrichEnglishContinueTriggers_();
  return enrichAllEnglishGlossesRun_();
}

/** Trigger handler — do not run manually. */
function enrichAllEnglishGlossesContinue_() {
  return enrichAllEnglishGlossesRun_();
}

/** Cancel any scheduled English-gloss enrichment continuation. */
function stopEnrichAllEnglishGlosses() {
  clearEnrichEnglishContinueTriggers_();
  const coverage = auditEnglishGlossCoverage();
  Logger.log('English gloss enrichment continuation stopped.');
  return { stopped: true, coverage };
}

function enrichAllEnglishGlossesRun_() {
  const started = Date.now();
  let totalProcessed = 0;
  let batches = 0;
  let last = { processed: 0, remaining: -1, done: false };

  while (Date.now() - started < ENRICH_MAX_RUNTIME_MS) {
    last = enrichEnglishGlossesBatch_(ENRICH_BATCH_SIZE);
    totalProcessed += last.processed;
    batches += 1;

    if (last.remaining === 0) {
      clearEnrichEnglishContinueTriggers_();
      const result = {
        processed: totalProcessed,
        batches,
        remaining: 0,
        done: true,
        continued: false,
      };
      Logger.log(JSON.stringify(result));
      return result;
    }

    if (last.processed === 0) break;
    Utilities.sleep(800);
  }

  const continued = last.remaining > 0;
  if (continued) scheduleEnrichEnglishContinue_();

  const result = {
    processed: totalProcessed,
    batches,
    remaining: last.remaining,
    done: !continued,
    continued,
    next_run_in_sec: continued ? ENRICH_CONTINUE_DELAY_MS / 1000 : 0,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function scheduleEnrichEnglishContinue_() {
  clearEnrichEnglishContinueTriggers_();
  ScriptApp.newTrigger(ENRICH_EN_CONTINUE_HANDLER)
    .timeBased()
    .after(ENRICH_CONTINUE_DELAY_MS)
    .create();
}

function clearEnrichEnglishContinueTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === ENRICH_EN_CONTINUE_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** Manual: report en_translation coverage on chunks_master. */
function auditEnglishGlossCoverage() {
  ensureChunksEnTranslationColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const total = Math.max(0, sheet.getLastRow() - 1);
  const remaining = countMissingEnglishGlosses_();
  const result = {
    total,
    covered: total - remaining,
    remaining,
    percent: total ? Math.round(((total - remaining) / total) * 100) : 100,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function enrichEnglishGlossesBatch_(batchSize) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  ensureChunksEnTranslationColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const pending = [];

  for (let r = 1; r < data.length && pending.length < batchSize; r++) {
    const en = String(data[r][col.en_translation] || '').trim();
    if (en) continue;
    pending.push({
      row: r + 1,
      chunk_id: data[r][col.chunk_id],
      text: data[r][col.text],
      type: data[r][col.type],
      cefr: data[r][col.cefr],
      ja_translation: String(data[r][col.ja_translation] || '').trim(),
    });
  }

  if (pending.length === 0) {
    return { processed: 0, remaining: 0, done: true };
  }

  const enriched = callClaudeEnrichEnglish_(pending, apiKey);
  enriched.forEach((item) => {
    const row = pending.find((p) => p.chunk_id === item.chunk_id);
    if (!row) return;
    if (item.en_translation) {
      sheet.getRange(row.row, col.en_translation + 1).setValue(item.en_translation);
    }
  });

  const remaining = countMissingEnglishGlosses_();
  return { processed: enriched.length, remaining, done: remaining === 0 };
}

function callClaudeEnrichEnglish_(items, apiKey) {
  const input = items.map((i) => ({
    chunk_id: i.chunk_id,
    text: i.text,
    type: i.type,
    cefr: i.cefr,
    ja_translation: i.ja_translation || null,
  }));

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: ENRICH_EN_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `You are an English lexicographer writing learner-friendly glosses for CEFR vocabulary items.
For each item, provide:
- en_translation: a concise English gloss (about 6-15 words)
  - For single words: a brief definition using simple language
  - For phrasal verbs / multi-word chunks: explain the meaning plainly (e.g. "to switch on a device")
  - Match complexity to the CEFR level shown
If ja_translation is provided, use it only as context. Write the gloss in English only.

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","en_translation":"..."}]

Items:
${JSON.stringify(input)}`,
    }],
  };

  const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Anthropic ${res.getResponseCode()}: ${res.getContentText().slice(0, 400)}`);
  }

  const body = JSON.parse(res.getContentText());
  const text = body.content[0].text.trim();
  const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(jsonStr);
}

function countMissingEnglishGlosses_() {
  ensureChunksEnTranslationColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const enCol = data[0].indexOf('en_translation');
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (!String(data[r][enCol] || '').trim()) count++;
  }
  return count;
}

// ===== Phase 3: SRS Engine (§4.2–4.4) =====

/** Days until next encounter by SRS stage (index = stage). */
const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];

function computeNextDueAt_(stage) {
  const days = SRS_INTERVAL_DAYS[Math.min(Math.max(stage, 0), 5)];
  const d = new Date();
  if (days <= 0) return d.toISOString();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function applySignalToStage_(stage, signal) {
  if (signal === 'got_it') return Math.min(stage + 1, 5);
  if (signal === 'still_hard') return Math.max(stage - 1, 0);
  return stage;
}

function computeNextDueAfterSignal_(stage, signal, existingNextDue) {
  if (signal === 'skipped' && existingNextDue) return existingNextDue;
  if (signal === 'passive') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return computeNextDueAt_(stage);
}

function shouldGraduate_(prog) {
  if (prog.encounter_count < 5) return false;
  if (prog.distinct_passages_count < 3) return false;
  if (prog.encounter_count === 0) return false;
  return prog.still_hard_count / prog.encounter_count < 0.3;
}

function deriveStatus_(stage, graduated, encounterCount) {
  if (graduated) return 'graduated';
  if (!encounterCount) return 'new';
  if (stage <= 2) return 'learning';
  return 'reviewing';
}

function isDue_(nextDueAt, now) {
  if (!nextDueAt) return true;
  const due = new Date(nextDueAt);
  return isNaN(due.getTime()) || due <= now;
}

/** CEFR levels included for SRS (band + all lower levels). */
function cefrLevelsForBand_(band) {
  if (band === 'A1A2') return ['A1', 'A2'];
  if (band === 'B1') return ['A1', 'A2', 'B1'];
  return ['A1', 'A2', 'B1', 'B2'];
}

function chunkInSrsScope_(cefr, band) {
  return cefrLevelsForBand_(band).indexOf(cefr) >= 0;
}

function loadUserProgressMap_(userId) {
  const sheet = getSheet_(SHEET_NAMES.PROGRESS);
  if (sheet.getLastRow() < 2) return {};
  const data = sheet.getDataRange().getValues();
  const col = indexColumns_(data[0]);
  const map = {};
  for (let r = 1; r < data.length; r++) {
    if (data[r][col.user_id] !== userId) continue;
    const chunkId = data[r][col.chunk_id];
    map[chunkId] = {
      row: r + 1,
      user_id: data[r][col.user_id],
      chunk_id: chunkId,
      encounter_count: Number(data[r][col.encounter_count]) || 0,
      distinct_passages_count: Number(data[r][col.distinct_passages_count]) || 0,
      last_encountered_at: data[r][col.last_encountered_at],
      next_due_at: data[r][col.next_due_at],
      srs_stage: Number(data[r][col.srs_stage]) || 0,
      status: data[r][col.status] || 'new',
      got_it_count: Number(data[r][col.got_it_count]) || 0,
      still_hard_count: Number(data[r][col.still_hard_count]) || 0,
    };
  }
  return map;
}

function countDistinctPassagesForChunk_(userId, chunkId) {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  if (sheet.getLastRow() < 2) return 0;
  const data = sheet.getDataRange().getValues();
  const passages = {};
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] === userId && data[r][2] === chunkId && data[r][3]) {
      passages[data[r][3]] = true;
    }
  }
  return Object.keys(passages).length;
}

function updateProgressForChunk_(userId, chunkId, passageId, signal) {
  const sheet = getSheet_(SHEET_NAMES.PROGRESS);
  const map = loadUserProgressMap_(userId);
  const nowIso = new Date().toISOString();
  const distinctPassages = countDistinctPassagesForChunk_(userId, chunkId);
  const existing = map[chunkId];

  const encounter_count = (existing ? existing.encounter_count : 0) + 1;
  const got_it_count = (existing ? existing.got_it_count : 0) + (signal === 'got_it' ? 1 : 0);
  const still_hard_count = (existing ? existing.still_hard_count : 0) + (signal === 'still_hard' ? 1 : 0);
  const prevStage = existing ? existing.srs_stage : 0;
  const srs_stage = applySignalToStage_(prevStage, signal);
  const next_due_at = computeNextDueAfterSignal_(
    srs_stage,
    signal,
    existing ? existing.next_due_at : null,
  );

  const progSnapshot = {
    encounter_count,
    distinct_passages_count: distinctPassages,
    still_hard_count,
  };
  const graduated = shouldGraduate_(progSnapshot);
  const status = deriveStatus_(srs_stage, graduated, encounter_count);

  const row = [
    userId,
    chunkId,
    encounter_count,
    distinctPassages,
    nowIso,
    graduated ? computeNextDueAt_(5) : next_due_at,
    graduated ? 5 : srs_stage,
    status,
    got_it_count,
    still_hard_count,
  ];

  if (existing) {
    sheet.getRange(existing.row, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

/** Rebuild user_progress rows from encounter_log (run once if progress sheet is empty). */
function rebuildUserProgressFromEncounters() {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  if (sheet.getLastRow() < 2) {
    Logger.log('No encounters to rebuild from.');
    return { rebuilt: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const seen = {};
  let rebuilt = 0;

  for (let r = 1; r < data.length; r++) {
    const userId = data[r][1];
    const chunkId = data[r][2];
    const passageId = data[r][3] || '';
    const signal = data[r][5] || 'passive';
    const key = `${userId}|${chunkId}|${passageId}|${signal}|${r}`;
    if (seen[key]) continue;
    seen[key] = true;
    updateProgressForChunk_(userId, chunkId, passageId, signal);
    rebuilt++;
  }

  Logger.log(`Rebuilt ${rebuilt} progress updates from encounter_log.`);
  return { rebuilt };
}

function handleDueChunks_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const limit = body.limit || 20;
  const now = new Date();
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);

  const due = [];
  const newChunks = [];

  Object.values(index).forEach((chunk) => {
    if (!chunkInSrsScope_(chunk.cefr, band)) return;
    const prog = progressMap[chunk.chunk_id];
    if (!prog) {
      newChunks.push({
        chunk_id: chunk.chunk_id,
        text: chunk.text,
        cefr: chunk.cefr,
        status: 'new',
      });
      return;
    }
    if (isDue_(prog.next_due_at, now)) {
      due.push({
        chunk_id: chunk.chunk_id,
        text: chunk.text,
        cefr: chunk.cefr,
        srs_stage: prog.srs_stage,
        last_encountered_at: prog.last_encountered_at,
        status: prog.status,
        still_hard_count: prog.still_hard_count,
      });
    }
  });

  due.sort((a, b) => (b.still_hard_count || 0) - (a.still_hard_count || 0));

  const dueOut = due.slice(0, limit);
  const remaining = limit - dueOut.length;
  const newOut = newChunks.slice(0, Math.max(remaining, 0));

  return { due_chunks: dueOut, new_chunks: newOut, cefr_band: band };
}

function mergeExcludePassageIds_(userId, clientIds) {
  const exclude = {};
  getRecentPassageIds_(userId, 24).forEach((id) => { exclude[id] = true; });
  (clientIds || []).forEach((id) => {
    if (id) exclude[id] = true;
  });
  return Object.keys(exclude);
}

function handleGeneratePassage_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);
  const excludePassageIds = mergeExcludePassageIds_(userId, body.exclude_passage_ids);
  const passage = buildPassageForUser_(userId, band, index, progressMap, excludePassageIds);
  return { passages: [passage], cefr_band: band };
}

/** Single round-trip for initial app load (one passage + header stats). */
function handleSession_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);
  const excludePassageIds = mergeExcludePassageIds_(userId, body.exclude_passage_ids);
  const passage = buildPassageForUser_(userId, band, index, progressMap, excludePassageIds);
  const stats = computeStatsFromIndex_(index, progressMap, band);
  return { passages: [passage], cefr_band: band, ...stats };
}

function getPassageMode_() {
  const v = String(
    PropertiesService.getScriptProperties().getProperty('USE_DYNAMIC_PASSAGES') || '',
  ).toLowerCase();
  if (v === 'true') return 'dynamic';
  if (v === 'hybrid') return 'hybrid';
  return 'template';
}

function buildPassageForUser_(userId, band, index, progressMap, excludePassageIds) {
  const mode = getPassageMode_();
  if (mode === 'template') {
    return pickTemplatePassage_(band, index, progressMap, excludePassageIds);
  }

  const dueData = handleDueChunks_({ user_id: userId, cefr: band, limit: 20 });
  const chunks = selectChunksForPassage_(dueData, progressMap, index, band);

  if (mode === 'hybrid') {
    if (chunks.length >= 2) {
      const cacheKey = chunksCacheKey_(chunks);
      const cached = findCachedPassage_(cacheKey, index, band, progressMap, excludePassageIds);
      if (cached) return cached;

      const tpl = pickTemplateCoveringChunks_(band, index, progressMap, excludePassageIds, chunks);
      if (tpl) return tpl;
    }

    if (needsNewPassageContext_(chunks, progressMap)) {
      try {
        return generateDynamicPassageClaude_(userId, band, index, progressMap, excludePassageIds, chunks);
      } catch (err) {
        Logger.log('Hybrid Claude generation failed: ' + err);
      }
    }

    return pickTemplatePassage_(band, index, progressMap, excludePassageIds);
  }

  try {
    return generateDynamicPassage_(userId, band, index, progressMap, excludePassageIds);
  } catch (err) {
    Logger.log('Dynamic passage failed, using template: ' + err);
  }
  return pickTemplatePassage_(band, index, progressMap, excludePassageIds);
}

function isDynamicPassagesEnabled_() {
  return getPassageMode_() === 'dynamic';
}

function pickTemplateCoveringChunks_(band, index, progressMap, excludePassageIds, chunks) {
  const chunkTexts = {};
  chunks.forEach((c) => { chunkTexts[String(c.text).toLowerCase().trim()] = true; });
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { exclude[id] = true; });

  const templates = getPassageTemplatesForBand_(band);
  let best = null;
  let bestScore = 0;

  templates.forEach((tpl) => {
    if (exclude[tpl.passage_id]) return;
    const texts = tpl.chunk_texts || [];
    let score = 0;
    texts.forEach((text) => {
      if (chunkTexts[String(text).toLowerCase().trim()]) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  });

  if (!best || bestScore === 0) return null;
  return enrichPassageTemplate_(best, index, band, progressMap);
}

function needsNewPassageContext_(chunks, progressMap) {
  if (!chunks || chunks.length === 0) return false;
  return chunks.some((c) => {
    const prog = progressMap[c.chunk_id];
    if (!prog) return true;
    if (prog.status === 'new' || prog.srs_stage === 0) return true;
    return prog.distinct_passages_count < 3;
  });
}

function generateDynamicPassageClaude_(userId, band, index, progressMap, excludePassageIds, chunks) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!chunks || chunks.length < 2) {
    chunks = selectChunksForPassage_(
      handleDueChunks_({ user_id: userId, cefr: band, limit: 20 }),
      progressMap,
      index,
      band,
    );
  }
  if (chunks.length < 2) throw new Error('Not enough chunks to generate passage');

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const generated = callClaudeGeneratePassage_(chunks, band, apiKey);
      if (!validatePassageChunks_(generated.text, chunks)) {
        throw new Error('Generated passage missing target chunks');
      }
      if (!validatePassageQuality_(generated)) {
        throw new Error('Generated passage failed quality checks');
      }
      const passage = buildPassageOutput_(generated, chunks, index, band, progressMap);
      if (excludePassageIds.indexOf(passage.passage_id) >= 0) {
        passage.passage_id = makePassageId_(chunks);
      }
      savePassageToDrive_(passage);
      registerPassageMeta_(passage, chunks);
      return passage;
    } catch (err) {
      lastErr = err;
      Utilities.sleep(400);
    }
  }
  throw lastErr || new Error('Passage generation failed');
}

function getRecentPassageIds_(userId, hours) {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  if (sheet.getLastRow() < 2) return [];
  const cutoff = Date.now() - hours * 3600000;
  const data = sheet.getDataRange().getValues();
  const ids = {};
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] !== userId || !data[r][3]) continue;
    const readAt = new Date(data[r][4]).getTime();
    if (!isNaN(readAt) && readAt >= cutoff) ids[data[r][3]] = true;
  }
  return Object.keys(ids);
}

function selectChunksForPassage_(dueData, progressMap, index, band) {
  const due = dueData.due_chunks || [];
  const newChunks = dueData.new_chunks || [];
  const selected = [];
  const used = {};

  function add(item) {
    if (!item || used[item.chunk_id]) return;
    const row = index[String(item.text).toLowerCase().trim()] || item;
    used[row.chunk_id || item.chunk_id] = true;
    selected.push({
      chunk_id: row.chunk_id || item.chunk_id,
      text: row.text || item.text,
      cefr: row.cefr || item.cefr,
    });
  }

  if (newChunks.length) add(newChunks[0]);

  due.filter((c) => {
    const prog = progressMap[c.chunk_id];
    return prog && prog.srs_stage >= 1 && prog.srs_stage <= 3;
  }).slice(0, 2).forEach(add);

  due.filter((c) => {
    const prog = progressMap[c.chunk_id];
    return prog && prog.srs_stage >= 4;
  }).slice(0, 1).forEach(add);

  if (selected.length < 2) {
    newChunks.slice(1, 4).forEach(add);
  }
  if (selected.length < 2) {
    due.slice(0, 4).forEach(add);
  }
  if (selected.length < 2) {
    getPassageTemplatesForBand_(band)[0].chunk_texts.forEach((text) => {
      add(index[text.toLowerCase().trim()] || fallbackChunk_(text, band));
    });
  }

  return selected.slice(0, 4);
}

function chunksCacheKey_(chunks) {
  return chunks.map((c) => c.chunk_id).sort().join(',');
}

function findCachedPassage_(chunkKey, index, band, progressMap, excludePassageIds) {
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  if (sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { if (id) exclude[id] = true; });
  const candidates = [];

  for (let r = data.length - 1; r >= 1; r--) {
    const ids = String(data[r][col.target_chunk_ids] || '').split(',').sort().join(',');
    if (ids !== chunkKey) continue;
    const passageId = String(data[r][col.passage_id] || '');
    if (exclude[passageId]) continue;
    const fileId = data[r][col.drive_file_id];
    if (!fileId) continue;
    try {
      const json = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'));
      candidates.push(hydratePassageFromJson_(json, index, band, progressMap));
    } catch (e) { /* skip bad cache */ }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function generateDynamicPassage_(userId, band, index, progressMap, excludePassageIds) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const dueData = handleDueChunks_({ user_id: userId, cefr: band, limit: 20 });
  const chunks = selectChunksForPassage_(dueData, progressMap, index, band);
  if (chunks.length < 2) throw new Error('Not enough chunks to generate passage');

  const cacheKey = chunksCacheKey_(chunks);
  const cached = findCachedPassage_(cacheKey, index, band, progressMap, excludePassageIds);
  if (cached) return cached;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const generated = callClaudeGeneratePassage_(chunks, band, apiKey);
      if (!validatePassageChunks_(generated.text, chunks)) {
        throw new Error('Generated passage missing target chunks');
      }
      if (!validatePassageQuality_(generated)) {
        throw new Error('Generated passage failed quality checks');
      }
      const passage = buildPassageOutput_(generated, chunks, index, band, progressMap);
      if (excludePassageIds.indexOf(passage.passage_id) >= 0) {
        passage.passage_id = makePassageId_(chunks);
      }
      savePassageToDrive_(passage);
      registerPassageMeta_(passage, chunks);
      return passage;
    } catch (err) {
      lastErr = err;
      Utilities.sleep(400);
    }
  }
  throw lastErr || new Error('Passage generation failed');
}

function callClaudeGeneratePassage_(chunks, band, apiKey) {
  const chunkList = chunks.map((c) => ({ chunk_id: c.chunk_id, text: c.text, cefr: c.cefr }));
  const cefrHint = band === 'A1A2' ? 'A1/A2' : band;
  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Write a natural English reading passage for CEFR ${cefrHint} learners.

Requirements:
- 3 to 6 sentences, 60-120 words total
- Use ONLY vocabulary appropriate for CEFR ${cefrHint} and below (i+1 principle)
- Naturally embed ALL target chunks below (no forced or awkward insertion)
- Provide accurate Japanese translation
- For each chunk, report exact char_start and char_end (0-based, end exclusive) in the English text

Return ONLY JSON, no markdown:
{
  "text": "full English passage as plain text",
  "ja_translation": "natural Japanese translation",
  "target_chunks": [
    {"chunk_id":"...","text":"exact substring","char_start":0,"char_end":0}
  ]
}

Target chunks:
${JSON.stringify(chunkList)}`,
    }],
  };

  const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Anthropic ${res.getResponseCode()}: ${res.getContentText().slice(0, 400)}`);
  }

  const body = JSON.parse(res.getContentText());
  const raw = body.content[0].text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(raw);
}

function validatePassageChunks_(text, chunks) {
  const lower = String(text).toLowerCase();
  return chunks.every((c) => lower.indexOf(String(c.text).toLowerCase()) >= 0);
}

function validatePassageQuality_(generated) {
  const text = String(generated.text || '').trim();
  const ja = String(generated.ja_translation || '').trim();
  if (!text || !ja) return false;

  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3 || sentences.length > 6) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 40 || words.length > 140) return false;

  const targets = generated.target_chunks || [];
  if (targets.length < 2) return false;

  return targets.every((tc) => {
    const start = Number(tc.char_start);
    const end = Number(tc.char_end);
    if (isNaN(start) || isNaN(end) || end <= start) return false;
    const slice = text.slice(start, end);
    return slice && slice.toLowerCase() === String(tc.text).toLowerCase();
  });
}

function buildTextMarkupFromPositions_(text, targetChunks) {
  const sorted = targetChunks.slice().sort((a, b) => b.char_start - a.char_start);
  let markup = text;
  sorted.forEach((c) => {
    const start = Number(c.char_start);
    const end = Number(c.char_end);
    if (isNaN(start) || isNaN(end) || end <= start) return;
    const slice = markup.slice(start, end);
    if (!slice) return;
    markup = markup.slice(0, start) + '{{' + slice + '}}' + markup.slice(end);
  });
  return markup;
}

function makePassageId_(chunks) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    chunks.map((c) => c.chunk_id).sort().join('|') + '|' + Date.now(),
  );
  const hex = digest.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return 'ps_' + hex.substring(0, 8);
}

function buildPassageOutput_(generated, chunks, index, band, progressMap) {
  const target_chunks = (generated.target_chunks || []).map((tc) => {
    const row = index[String(tc.text).toLowerCase().trim()] || chunks.find((c) => c.chunk_id === tc.chunk_id) || tc;
    const prog = progressMap[row.chunk_id || tc.chunk_id];
    return {
      chunk_id: row.chunk_id || tc.chunk_id,
      text: row.text || tc.text,
      cefr: row.cefr || tc.cefr,
      char_start: tc.char_start,
      char_end: tc.char_end,
      ja_translation: resolveChunkJa_(row.text, row.ja_translation),
      en_translation: resolveChunkEn_(row.text, row.en_translation),
      example_sentence: row.example_sentence || '',
      encounters: prog ? prog.encounter_count : 0,
      srs_stage: prog ? prog.srs_stage : 0,
      status: prog ? prog.status : 'new',
    };
  });

  const textMarkup = buildTextMarkupFromPositions_(generated.text, target_chunks);
  return {
    passage_id: makePassageId_(chunks),
    cefr_band: band,
    text: generated.text,
    text_markup: textMarkup,
    ja_translation: generated.ja_translation || '',
    target_chunks,
  };
}

function hydratePassageFromJson_(json, index, band, progressMap) {
  const chunks = (json.target_chunks || []).map((tc) => {
    const row = index[String(tc.text).toLowerCase().trim()] || tc;
    const prog = progressMap[row.chunk_id || tc.chunk_id];
    return {
      chunk_id: row.chunk_id || tc.chunk_id,
      text: row.text || tc.text,
      cefr: row.cefr || tc.cefr,
      ja_translation: resolveChunkJa_(row.text, row.ja_translation),
      en_translation: resolveChunkEn_(row.text, row.en_translation),
      example_sentence: row.example_sentence || '',
      encounters: prog ? prog.encounter_count : 0,
      srs_stage: prog ? prog.srs_stage : 0,
      status: prog ? prog.status : 'new',
    };
  });
  return {
    passage_id: json.passage_id,
    cefr_band: json.cefr_band || band,
    text_markup: json.text_markup || buildTextMarkupFromPositions_(json.text, json.target_chunks || []),
    ja_translation: json.ja_translation || '',
    target_chunks: chunks,
  };
}

function savePassageToDrive_(passage) {
  const folder = getOrCreateSubfolder_(getDriveRoot_(), 'passages');
  const payload = {
    passage_id: passage.passage_id,
    cefr_band: passage.cefr_band,
    text: passage.text || passage.text_markup.replace(/\{\{|\}\}/g, ''),
    text_markup: passage.text_markup,
    ja_translation: passage.ja_translation,
    target_chunks: passage.target_chunks,
    generated_at: new Date().toISOString(),
  };
  const existing = folder.getFilesByName(passage.passage_id + '.json');
  while (existing.hasNext()) existing.next().setTrashed(true);
  const file = folder.createFile(
    passage.passage_id + '.json',
    JSON.stringify(payload, null, 2),
    MimeType.PLAIN_TEXT,
  );
  passage.drive_file_id = file.getId();
  return file.getId();
}

function registerPassageMeta_(passage, chunks) {
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  const text = passage.text || passage.text_markup.replace(/\{\{|\}\}/g, '');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  sheet.appendRow([
    passage.passage_id,
    passage.cefr_band,
    passage.drive_file_id || '',
    chunks.map((c) => c.chunk_id).join(','),
    wordCount,
    '',
    new Date().toISOString(),
  ]);
}

function pickTemplatePassage_(band, index, progressMap, excludePassageIds) {
  const templates = getPassageTemplatesForBand_(band);
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { exclude[id] = true; });
  let candidates = templates.filter((t) => !exclude[t.passage_id]);
  if (candidates.length === 0) candidates = templates;
  const tpl = candidates[Math.floor(Math.random() * candidates.length)];
  return enrichPassageTemplate_(tpl, index, band, progressMap);
}

function computeStatsFromIndex_(index, progressMap, band) {
  const levels = cefrLevelsForBand_(band);
  let reviewing = 0;
  let graduated = 0;
  let learning = 0;
  let newCount = 0;

  Object.values(index).forEach((chunk) => {
    if (levels.indexOf(chunk.cefr) < 0) return;
    const prog = progressMap[chunk.chunk_id];
    if (!prog) {
      newCount++;
      return;
    }
    if (prog.status === 'graduated') graduated++;
    else if (prog.status === 'learning') learning++;
    else reviewing++;
  });

  return {
    reviewing: reviewing + learning,
    graduated,
    learning,
    new: newCount,
  };
}

function handleLogEncounter_(body) {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  const userId = body.user_id || 'naoya';
  const passageId = body.passage_id || '';
  const signal = body.signal || 'passive';
  const timeOnPageMs = body.time_on_page_ms || 0;
  const chunkIds = body.chunk_ids || (body.chunk_id ? [body.chunk_id] : []);
  const now = new Date().toISOString();

  const rows = chunkIds.map((chunkId) => [
    Utilities.getUuid(), userId, chunkId, passageId, now, signal, timeOnPageMs,
  ]);

  if (rows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
    if (signal === 'got_it' || signal === 'still_hard' || signal === 'passive' || signal === 'skipped') {
      chunkIds.forEach((chunkId) => {
        updateProgressForChunk_(userId, chunkId, passageId, signal);
      });
    }
  }
  return { ok: true, logged: rows.length };
}

function handleUpdateProgress_(body) {
  const userId = body.user_id || 'naoya';
  const passageId = body.passage_id || '';
  const signal = body.signal || 'passive';
  const chunkIds = body.chunk_ids || [];
  chunkIds.forEach((chunkId) => {
    updateProgressForChunk_(userId, chunkId, passageId, signal);
  });
  return { ok: true, updated: chunkIds.length };
}

function handleStats_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);
  return { ...computeStatsFromIndex_(index, progressMap, band), cefr_band: band };
}

// ===== Passage templates (Phase 2 — Phase 4 replaces with Claude generation) =====

function getPassageTemplatesForBand_(band) {
  try {
    const all = readSharedJson_('passage-templates.json');
    if (all[band] && all[band].length) return all[band];
  } catch (err) {
    Logger.log('passage-templates.json not loaded, using inline fallback: ' + err);
  }
  return getPassageTemplatesInline_(band);
}

/** Legacy inline templates (fallback if shared/passage-templates.json is not on Drive). */
function getPassageTemplatesInline_(band) {
  const T = {
    A1A2: [
      {
        passage_id: 'ps_a1_01',
        cefr_band: 'A1A2',
        text_markup: 'I walk into a small café near my house. I {{look at}} the menu on the wall and {{pick up}} a cup of hot tea. There are {{a lot of}} people here today, but the waiter smiles and helps me find a seat.',
        ja_translation: '家の近くの小さなカフェに入る。壁のメニューを見て、温かいお茶を手に取る。今日はたくさん人がいるが、ウェイターは笑顔で席を見つけるのを手伝ってくれる。',
        chunk_texts: ['look at', 'pick up', 'a lot of'],
      },
      {
        passage_id: 'ps_a1_02',
        cefr_band: 'A1A2',
        text_markup: 'We {{get up}} early on Saturday morning. We {{go out}} for a short walk in the park. I feel {{a little}} tired, but the morning air feels nice and fresh.',
        ja_translation: '土曜の朝、私たちは早く起きる。公園へ少し散歩に出かける。少し疲れているが、朝の空気は気持ちよくて清々しい。',
        chunk_texts: ['get up', 'go out', 'a little'],
      },
      {
        passage_id: 'ps_a1_03',
        cefr_band: 'A1A2',
        text_markup: 'It is late at night. I {{turn on}} the light in my room and {{sit down}} at my desk. I have {{a few}} books to read tonight. I want to finish them before I go to bed.',
        ja_translation: '夜遅い。部屋の明かりをつけて、机に座る。今夜読む本が数冊ある。寝る前に読み終えたい。',
        chunk_texts: ['turn on', 'sit down', 'a few'],
      },
    ],
    B1: [
      {
        passage_id: 'ps_001',
        cefr_band: 'B1',
        text_markup: "The restaurant was packed when we arrived, but the host {{managed to}} find us a table near the window. We sat down and {{picked up}} the menus, scanning the appetizers first. I ordered without much thought. It {{turned out}} to be the best meal I'd had all week.",
        ja_translation: '私たちが到着したとき、レストランは混んでいたが、店主はなんとか窓際の席を見つけてくれた。座って、メニューを手に取り、まず前菜から目を通した。あまり考えずに注文した。結果的に、その週で食べた中で最高の食事だった。',
        chunk_texts: ['managed to', 'picked up', 'turned out'],
      },
      {
        passage_id: 'ps_002',
        cefr_band: 'B1',
        text_markup: "I had been planning the trip for months, but on the morning of departure, I {{ran into}} an old friend at the airport. We {{caught up}} over coffee, and I almost missed my flight.",
        ja_translation: '数か月もかけて旅の計画を立ててきたが、出発の朝、空港で旧友にばったり会った。コーヒーを飲みながら近況を交わし、もう少しでフライトに乗り遅れるところだった。',
        chunk_texts: ['ran into', 'caught up'],
      },
      {
        passage_id: 'ps_003',
        cefr_band: 'B1',
        text_markup: 'When the meeting started, no one {{spoke up}} at first. Finally, Sarah {{laid out}} her proposal. By the end, everyone agreed it was the best plan we had {{come up with}} in months.',
        ja_translation: '会議が始まったとき、最初は誰も発言しなかった。やがてサラが提案を整然と並べた。終わる頃には、ここ数か月で思いついた最良の計画だと全員が同意していた。',
        chunk_texts: ['spoke up', 'laid out', 'come up with'],
      },
    ],
    B2: [
      {
        passage_id: 'ps_b2_01',
        cefr_band: 'B2',
        text_markup: 'The committee {{carried out}} a thorough review and {{drew up}} a new policy. Critics argued the plan would {{bring about}} significant changes across the industry.',
        ja_translation: '委員会は徹底的な見直しを行い、新しい方針を作成した。批評家は、その計画が業界全体に大きな変化をもたらすだろうと主張した。',
        chunk_texts: ['carried out', 'drew up', 'bring about'],
      },
      {
        passage_id: 'ps_b2_02',
        cefr_band: 'B2',
        text_markup: 'She {{set out}} to prove her theory, but the data did not {{bear out}} her assumptions. Still, the findings {{shed light on}} a problem no one had noticed.',
        ja_translation: '彼女は自分の理論を証明しようと取り組んだが、データはその仮定を裏付けなかった。それでも、調査結果は誰も気づかなかった問題を明らかにした。',
        chunk_texts: ['set out', 'bear out', 'shed light on'],
      },
      {
        passage_id: 'ps_b2_03',
        cefr_band: 'B2',
        text_markup: 'The report {{points out}} several risks that leaders have {{overlooked}} for years. Unless teams {{follow through}} on these recommendations, little will change.',
        ja_translation: '報告書は、リーダーが長年見落としてきたいくつかのリスクを指摘している。チームがこれらの提言を最後まで実行しない限り、状況はほとんど変わらないだろう。',
        chunk_texts: ['points out', 'overlooked', 'follow through'],
      },
    ],
  };
  return T[band] || T.B1;
}

function resolveChunkJa_(text, ja) {
  const trimmed = String(ja || '').trim();
  if (trimmed) return trimmed;
  const key = String(text || '').toLowerCase().trim();
  return CHUNK_GLOSS_FALLBACKS_[key] ? CHUNK_GLOSS_FALLBACKS_[key].ja : '';
}

function resolveChunkEn_(text, en) {
  const trimmed = String(en || '').trim();
  if (trimmed) return trimmed;
  const key = String(text || '').toLowerCase().trim();
  return CHUNK_GLOSS_FALLBACKS_[key] ? CHUNK_GLOSS_FALLBACKS_[key].en : '';
}

/** Fallback glosses when chunks_master translations are not yet enriched. */
var CHUNK_GLOSS_FALLBACKS_ = {
  'look at': { ja: '見る', en: 'to direct your eyes toward something' },
  'pick up': { ja: '手に取る', en: 'to lift or take something with your hands' },
  'a lot of': { ja: 'たくさんの', en: 'many; a large amount of' },
  'get up': { ja: '起きる', en: 'to rise from bed or a seated position' },
  'go out': { ja: '外出する', en: 'to leave home for an activity' },
  'a little': { ja: '少し', en: 'a small amount; slightly' },
  'turn on': { ja: 'つける／オンにする', en: 'to switch on (a light, device, etc.)' },
  'sit down': { ja: '座る', en: 'to take a seat' },
  'a few': { ja: 'いくつかの／少しの', en: 'a small number of' },
  'managed to': { ja: 'なんとか〜することができた', en: 'to succeed in doing something difficult' },
  'picked up': { ja: '手に取る／拾い上げる', en: 'to take hold of; to collect' },
  'turned out': { ja: '結果的に〜だった／判明した', en: 'to prove to be; to end up being' },
  'ran into': { ja: '偶然出会う／ばったり会う', en: 'to meet someone by chance' },
  'caught up': { ja: '近況を語り合う', en: 'to share recent news with someone' },
  'spoke up': { ja: '発言する／声を上げる', en: 'to express an opinion aloud' },
  'laid out': { ja: '整然と提示する／詳しく説明する', en: 'to present or explain clearly' },
  'come up with': { ja: '思いつく／考え出す', en: 'to think of; to devise' },
  'carried out': { ja: '実行する／行う', en: 'to perform or complete (a task)' },
  'drew up': { ja: '作成する／まとめる', en: 'to prepare in written form' },
  'bring about': { ja: 'もたらす／引き起こす', en: 'to cause something to happen' },
  'set out': { ja: '〜しようと取り組む', en: 'to begin with a specific aim' },
  'bear out': { ja: '裏付ける', en: 'to support or confirm' },
  'shed light on': { ja: '明らかにする', en: 'to clarify; to make clearer' },
  'points out': { ja: '指摘する', en: 'to indicate or mention' },
  'overlooked': { ja: '見落とした', en: 'failed to notice' },
  'follow through': { ja: '最後まで実行する', en: 'to complete what was started' },
};

function enrichPassageTemplate_(tpl, index, band, progressMap) {
  progressMap = progressMap || {};
  const target_chunks = tpl.chunk_texts.map((text) => {
    const key = text.toLowerCase().trim();
    const row = index[key] || fallbackChunk_(text, band);
    const prog = progressMap[row.chunk_id];
    return {
      chunk_id: row.chunk_id,
      text: row.text,
      cefr: row.cefr,
      ja_translation: resolveChunkJa_(row.text, row.ja_translation),
      en_translation: resolveChunkEn_(row.text, row.en_translation),
      example_sentence: row.example_sentence || '',
      encounters: prog ? prog.encounter_count : 0,
      srs_stage: prog ? prog.srs_stage : 0,
      status: prog ? prog.status : 'new',
    };
  });
  return {
    passage_id: tpl.passage_id,
    cefr_band: tpl.cefr_band,
    text_markup: tpl.text_markup,
    ja_translation: tpl.ja_translation,
    target_chunks,
  };
}

function fallbackChunk_(text, band) {
  return {
    chunk_id: makeChunkId_(text),
    text,
    cefr: band === 'A1A2' ? 'A2' : band === 'B2' ? 'B2' : 'B1',
    ja_translation: '',
    en_translation: '',
    example_sentence: '',
  };
}

// ===== CEFR helpers =====

function normalizeCefrBand_(cefr) {
  const v = String(cefr || 'B1').toUpperCase().replace(/\+/g, '');
  if (v === 'A1A2' || v === 'A1' || v === 'A2') return 'A1A2';
  if (v === 'B2') return 'B2';
  return 'B1';
}

function cefrMatchesBand_(cefr, band) {
  if (band === 'A1A2') return cefr === 'A1' || cefr === 'A2';
  if (band === 'B1') return cefr === 'B1';
  if (band === 'B2') return cefr === 'B2';
  return true;
}

function loadChunksIndex_() {
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  if (sheet.getLastRow() < 2) return {};

  ensureChunksEnTranslationColumn_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const index = {};

  for (let r = 1; r < data.length; r++) {
    const text = String(data[r][col.text] || '');
    if (!text) continue;
    index[text.toLowerCase().trim()] = {
      chunk_id: data[r][col.chunk_id],
      text,
      cefr: data[r][col.cefr],
      ja_translation: data[r][col.ja_translation],
      en_translation: col.en_translation !== undefined ? data[r][col.en_translation] : '',
      example_sentence: data[r][col.example_sentence],
    };
  }

  return index;
}

function indexColumns_(headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  return idx;
}

function makeChunkId_(text) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text).toLowerCase().trim(),
  );
  const hex = digest.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return 'ch_' + hex.substring(0, 8);
}

function readSharedJson_(filename) {
  const shared = getOrCreateSubfolder_(getDriveRoot_(), 'shared');
  const files = shared.getFilesByName(filename);
  if (!files.hasNext()) {
    throw new Error(`File not found in shared/: ${filename}`);
  }
  return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
}

// ===== Sheet / Drive helpers =====

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`Sheet "${name}" not found. Run setupSheets() first.`);
  return sheet;
}

function getDriveRoot_() {
  const id = PropertiesService.getScriptProperties().getProperty('DRIVE_ROOT_ID');
  if (!id) throw new Error('DRIVE_ROOT_ID not set in Script Properties');
  return DriveApp.getFolderById(id);
}

function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
