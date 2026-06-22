/**
 * English Reader Trainer — Backend (Phase 3)
 *
 * Script Properties:
 *   SPREADSHEET_ID, DRIVE_ROOT_ID
 *   ANTHROPIC_API_KEY — for ja_translation / en_translation batches
 *   USE_DYNAMIC_PASSAGES — "hybrid" (default), "true" (always Claude), "false"/"template" (templates only)
 *
 * Manual setup (Apps Script editor):
 *   1. setupSheets() — once
 *   2. importChunksFromCefr() — after cefr_*.json in Drive shared/
 *   3. preparePromptRenewalRefresh() — clears passage cache; bump ENRICH_PROMPT_VERSION + enrich for stale rows
 *   3b. migrateChunksAddEnrichVersionColumn() — once on existing spreadsheets
 *   4. enrichAllTranslations() — runs until remaining = 0
 *   5. migrateChunksAddEnTranslationColumn() — once on existing spreadsheets
 *   6. enrichAllEnglishGlosses() — runs until remaining = 0
 *   7. generateTemplateBatch_(band, count) — optional template samples for review
 *   8. setupNightlyWarmupTrigger() — once, schedules nightly passage warmup
 *   9. reportTokenUsage() — purpose/model token summary from token_usage sheet
 *  9b. reportTokenUsageLastHour() — last 60 min (post-deploy spot check)
 *  9c. reportTokenUsageSinceDeploy() — since TOKEN_USAGE_SINCE_ISO script property
 *  10. Redeploy Web App after code changes
 */

const SHEET_NAMES = {
  CHUNKS: 'chunks_master',
  PROGRESS: 'user_progress',
  PASSAGES: 'passages_meta',
  ENCOUNTERS: 'encounter_log',
  TOKEN_USAGE: 'token_usage',
};

const SHEET_HEADERS = {
  [SHEET_NAMES.CHUNKS]: [
    'chunk_id', 'text', 'type', 'cefr', 'pos', 'ja_translation', 'en_translation',
    'example_sentence', 'audio_drive_url', 'created_at', 'enrich_version',
  ],
  [SHEET_NAMES.PROGRESS]: [
    'user_id', 'chunk_id', 'encounter_count', 'distinct_passages_count',
    'last_encountered_at', 'next_due_at', 'srs_stage', 'status',
    'got_it_count', 'still_hard_count',
  ],
  [SHEET_NAMES.PASSAGES]: [
    'passage_id', 'cefr', 'drive_file_id', 'target_chunk_ids',
    'word_count', 'audio_drive_url', 'generated_at',
    'critique_total', 'critique_verdict',
  ],
  [SHEET_NAMES.ENCOUNTERS]: [
    'event_id', 'user_id', 'chunk_id', 'passage_id',
    'read_at', 'signal', 'time_on_page_ms',
  ],
  [SHEET_NAMES.TOKEN_USAGE]: [
    'ts', 'model', 'purpose', 'input_tokens', 'output_tokens',
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'retry_index',
  ],
};

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_PASSAGE = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH = 'claude-haiku-4-5-20251001';
/** @deprecated Use MODEL_ENRICH / MODEL_PASSAGE / MODEL_CRITIQUE */
const ANTHROPIC_MODEL = MODEL_ENRICH;
/** Items per Claude call — must finish one API round-trip within the GAS 6-min cap. */
const ENRICH_BATCH_SIZE = 150;
/** Output token budget — scale with batch size (Haiku 4.5 max output 64K). */
const ENRICH_JA_MAX_TOKENS = 64000;
const ENRICH_EN_MAX_TOKENS = 64000;
/** Below this, enrich API failures are not split-retried. */
const ENRICH_MIN_SPLIT_SIZE = 50;
/** Soft stop for the enrich loop (leave headroom before the 6-min hard limit). */
const ENRICH_SOFT_LIMIT_MS = 4.5 * 60 * 1000;
/** Do not start another Claude batch unless this much runtime remains. */
const ENRICH_BATCH_RESERVE_MS = 2.5 * 60 * 1000;
/** Safety trigger if a single batch still hits the hard 6-min timeout. */
const ENRICH_SAFETY_CONTINUE_MS = 6.5 * 60 * 1000;
const ENRICH_CONTINUE_DELAY_MS = 30 * 1000;
const ENRICH_CONTINUE_HANDLER = 'enrichAllTranslationsContinue_';
const ENRICH_EN_CONTINUE_HANDLER = 'enrichAllEnglishGlossesContinue_';
/** Bump when ja/en enrich prompts change — only stale rows are re-enriched. */
const ENRICH_PROMPT_VERSION = 1;
const WARMUP_NIGHTLY_HANDLER = 'runNightlyWarmup_';

// ===== Token usage logging =====

function ensureTokenUsageSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAMES.TOKEN_USAGE);
  const headers = SHEET_HEADERS[SHEET_NAMES.TOKEN_USAGE];
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.TOKEN_USAGE);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (existing[0] !== headers[0]) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logTokenUsage_(record) {
  try {
    const sheet = ensureTokenUsageSheet_();
    sheet.appendRow([
      record.ts || new Date().toISOString(),
      record.model || '',
      record.purpose || '',
      record.input_tokens || 0,
      record.output_tokens || 0,
      record.cache_creation_input_tokens || 0,
      record.cache_read_input_tokens || 0,
      record.retry_index != null ? record.retry_index : 0,
    ]);
  } catch (err) {
    Logger.log('logTokenUsage_ failed: ' + err);
  }
}

function recordAnthropicUsage_(body, model, meta) {
  const usage = (body && body.usage) || {};
  logTokenUsage_({
    ts: new Date().toISOString(),
    model: model || '',
    purpose: (meta && meta.purpose) || '',
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    retry_index: meta && meta.retry_index != null ? meta.retry_index : 0,
  });
}

/**
 * Summarize token_usage since an ISO timestamp (default: last 7 days).
 * Run manually in the Apps Script editor.
 */
function reportTokenUsage_(sinceIso) {
  ensureTokenUsageSheet_();
  const sheet = getSheet_(SHEET_NAMES.TOKEN_USAGE);
  if (sheet.getLastRow() < 2) {
    Logger.log('token_usage: no rows yet');
    return { rows: 0, by_purpose: {} };
  }

  const cutoff = sinceIso
    ? new Date(sinceIso).getTime()
    : Date.now() - 7 * 24 * 3600000;
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const agg = {};

  for (let r = 1; r < data.length; r++) {
    const ts = new Date(data[r][col.ts]).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const purpose = String(data[r][col.purpose] || 'unknown');
    const model = String(data[r][col.model] || 'unknown');
    const key = purpose + '\t' + model;
    if (!agg[key]) {
      agg[key] = {
        purpose, model, calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0,
      };
    }
    agg[key].calls += 1;
    agg[key].input_tokens += Number(data[r][col.input_tokens]) || 0;
    agg[key].output_tokens += Number(data[r][col.output_tokens]) || 0;
    agg[key].cache_read += Number(data[r][col.cache_read_input_tokens]) || 0;
  }

  const lines = ['purpose\tmodel\tcalls\tin_tok\tout_tok\tcache_read'];
  Object.keys(agg).sort().forEach((key) => {
    const row = agg[key];
    lines.push([
      row.purpose, row.model, row.calls,
      row.input_tokens, row.output_tokens, row.cache_read,
    ].join('\t'));
  });
  Logger.log(lines.join('\n'));
  return { rows: data.length - 1, by_purpose: agg, table: lines.join('\n') };
}

/** Apps Script editor entry point (functions ending in _ are hidden from the run menu). */
function reportTokenUsage(sinceIso) {
  return reportTokenUsage_(sinceIso);
}

/** Last 60 minutes — no timestamp setup needed. Good for post-deploy spot checks. */
function reportTokenUsageLastHour() {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return reportTokenUsageDetail(since);
}

/**
 * Since Script Property TOKEN_USAGE_SINCE_ISO (ISO8601, e.g. 2026-06-22T18:15:00+09:00).
 * Set in Project Settings → Script properties before running.
 */
function reportTokenUsageSinceDeploy() {
  const since = PropertiesService.getScriptProperties().getProperty('TOKEN_USAGE_SINCE_ISO');
  if (!since) {
    const msg = 'Set Script Property TOKEN_USAGE_SINCE_ISO (ISO8601 deploy time, e.g. 2026-06-22T18:15:00+09:00)';
    Logger.log(msg);
    return { error: msg };
  }
  return reportTokenUsageDetail(since);
}

/**
 * Detailed token_usage breakdown: purpose × retry_index, plus raw row count.
 * @param {string} [sinceIso] ISO8601 lower bound; omit for last 7 days.
 * Example: reportTokenUsageDetail('2026-06-22T17:00:00+09:00')
 */
function reportTokenUsageDetail(sinceIso) {
  ensureTokenUsageSheet_();
  const sheet = getSheet_(SHEET_NAMES.TOKEN_USAGE);
  if (sheet.getLastRow() < 2) {
    Logger.log('token_usage: no rows yet');
    return { rows: 0 };
  }

  const cutoff = sinceIso
    ? new Date(sinceIso).getTime()
    : Date.now() - 7 * 24 * 3600000;
  const data = sheet.getDataRange().getValues();
  const col = indexColumns_(data[0]);
  const byPurposeRetry = {};
  let inWindow = 0;

  for (let r = 1; r < data.length; r++) {
    const ts = new Date(data[r][col.ts]).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    inWindow += 1;
    const purpose = String(data[r][col.purpose] || 'unknown');
    const retry = Number(data[r][col.retry_index]) || 0;
    const key = purpose + '\tretry_' + retry;
    if (!byPurposeRetry[key]) {
      byPurposeRetry[key] = { purpose, retry_index: retry, calls: 0 };
    }
    byPurposeRetry[key].calls += 1;
  }

  const lines = [
    'since\t' + (sinceIso || '(last 7 days)'),
    'rows_in_window\t' + inWindow,
    '',
    'purpose\tretry_index\tcalls\tmeaning',
    'passage\t0\t?\t1回目の Sonnet 生成（別リクエストごとに0からカウント）',
    'passage\t1\t?\t同一 generate_passage 内の2回目リトライ',
    'passage\t2\t?\t同一 generate_passage 内の3回目リトライ',
    '',
    'purpose\tretry_index\tcalls',
  ];
  Object.keys(byPurposeRetry).sort().forEach((key) => {
    const row = byPurposeRetry[key];
    lines.push([row.purpose, row.retry_index, row.calls].join('\t'));
  });
  Logger.log(lines.join('\n'));
  return { rows_in_window: inWindow, by_purpose_retry: byPurposeRetry, table: lines.join('\n') };
}

/**
 * One-shot diagnostic: generate a passage and log validation failures before/after span repair.
 * Run in the editor: debugPassageValidationSample('B1')
 */
function debugPassageValidationSample(band) {
  band = normalizeCefrBand_(band || 'B1');
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_('naoya');
  const dueData = handleDueChunks_({ user_id: 'naoya', cefr: band, limit: 20 });
  const chunks = selectChunksForPassage_(dueData, progressMap, index, band);
  if (chunks.length < 2) throw new Error('Not enough chunks for band ' + band);

  const generated = callClaudeGeneratePassage_(chunks, band, apiKey, index, '', 0, 'passage');
  const before = describePassageQualityFailure_(generated);
  const missingChunks = !validatePassageChunks_(generated.text, chunks);
  repairPassageTargetChunkSpans_(generated, chunks);
  const afterRepair = describePassageQualityFailure_(generated);

  const result = {
    band,
    chunks: chunks.map((c) => c.text),
    missing_target_chunks: missingChunks,
    failures_before_repair: before,
    failures_after_repair: afterRepair,
    would_pass_after_repair: afterRepair.length === 0 && !missingChunks,
    self_check: generated.self_check || null,
    word_count: String(generated.text || '').split(/\s+/).filter(Boolean).length,
    sentence_count: String(generated.text || '').split(/[.!?]+/).filter((s) => s.trim()).length,
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function anthropicRequestHeaders_(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  };
}

function fetchAnthropicBody_(payload, apiKey, usageMeta) {
  const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: anthropicRequestHeaders_(apiKey),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Anthropic ${res.getResponseCode()}: ${res.getContentText().slice(0, 400)}`);
  }

  const body = JSON.parse(res.getContentText());
  if (usageMeta) {
    recordAnthropicUsage_(body, payload.model, usageMeta);
  }
  return body;
}

function passageSystemBlocks_() {
  return [{
    type: 'text',
    text: PASSAGE_SYSTEM_PROMPT_,
    cache_control: { type: 'ephemeral' },
  }];
}

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
    '',
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
  return runEnrichJob_({
    logLabel: 'enrichAllTranslations',
    continueHandler: ENRICH_CONTINUE_HANDLER,
    clearTriggersFn: clearEnrichContinueTriggers_,
    scheduleContinueFn: scheduleEnrichContinue_,
    runBatchFn: () => enrichTranslationsBatch_(ENRICH_BATCH_SIZE),
    countRemainingFn: countMissingTranslations_,
  });
}

function canStartEnrichBatch_(startedAt) {
  const elapsed = Date.now() - startedAt;
  return elapsed + ENRICH_BATCH_RESERVE_MS <= ENRICH_SOFT_LIMIT_MS;
}

/** Shared enrich loop: multiple small batches per run, auto-continue via trigger. */
function runEnrichJob_(opts) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log(opts.logLabel + ': another run is active; skipping.');
    return { skipped: true, remaining: opts.countRemainingFn() };
  }

  try {
    scheduleEnrichSafetyContinue_(opts.continueHandler);
    const started = Date.now();
    let totalProcessed = 0;
    let batches = 0;
    let last = { processed: 0, remaining: -1, done: false };

    while (Date.now() - started < ENRICH_SOFT_LIMIT_MS) {
      if (!canStartEnrichBatch_(started)) {
        Logger.log(opts.logLabel + ': stopping before next batch (runtime headroom)');
        break;
      }

      try {
        last = opts.runBatchFn();
      } catch (err) {
        Logger.log(opts.logLabel + ' batch failed: ' + err);
        last = {
          processed: 0,
          remaining: opts.countRemainingFn(),
          done: false,
        };
        Utilities.sleep(2000);
      }
      totalProcessed += last.processed;
      batches += 1;

      if (last.remaining === 0) {
        opts.clearTriggersFn();
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
    if (continued) opts.scheduleContinueFn();

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
  } finally {
    lock.releaseLock();
  }
}

function scheduleEnrichContinue_() {
  scheduleEnrichDelayedContinue_(ENRICH_CONTINUE_HANDLER, ENRICH_CONTINUE_DELAY_MS);
}

function scheduleEnrichSafetyContinue_(handler) {
  scheduleEnrichDelayedContinue_(handler, ENRICH_SAFETY_CONTINUE_MS);
}

function scheduleEnrichDelayedContinue_(handler, delayMs) {
  clearEnrichTriggersForHandler_(handler);
  ScriptApp.newTrigger(handler)
    .timeBased()
    .after(delayMs)
    .create();
}

function clearEnrichTriggersForHandler_(handler) {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function clearEnrichContinueTriggers_() {
  clearEnrichTriggersForHandler_(ENRICH_CONTINUE_HANDLER);
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
    enrich_prompt_version: ENRICH_PROMPT_VERSION,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function enrichTranslationsBatch_(batchSize) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  ensureChunksEnrichVersionColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const pending = [];

  for (let r = 1; r < data.length && pending.length < batchSize; r++) {
    if (!rowNeedsJaEnrich_(data[r], col)) continue;
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
    if (item.ja_translation) {
      sheet.getRange(row.row, col.enrich_version + 1).setValue(ENRICH_PROMPT_VERSION);
    }
  });

  const remaining = countMissingTranslations_();
  return { processed: enriched.length, remaining, done: remaining === 0 };
}

/** Extract the first complete JSON array from Claude text (ignores trailing prose / fences). */
function extractJsonArrayFromText_(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '');
  const start = s.indexOf('[');
  if (start < 0) throw new Error('No JSON array in Claude response');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('Truncated JSON array — reduce ENRICH_BATCH_SIZE or raise max_tokens');
}

function fetchAnthropicEnrichArray_(payload, apiKey, usageMeta) {
  const body = fetchAnthropicBody_(payload, apiKey, usageMeta);
  if (!body.content || !body.content.length) throw new Error('Empty Claude response');
  const stopReason = body.stop_reason || '';
  if (stopReason === 'max_tokens') {
    Logger.log('Warning: enrich response hit max_tokens (may be truncated)');
  }
  const items = extractJsonArrayFromText_(body.content[0].text);
  return { items, stopReason };
}

function callClaudeEnrichWithSplitRetry_(items, apiKey, buildPayload, purpose, retryIndex) {
  try {
    const result = fetchAnthropicEnrichArray_(buildPayload(items), apiKey, {
      purpose: purpose,
      retry_index: retryIndex || 0,
    });
    return result.items;
  } catch (err) {
    if (items.length <= ENRICH_MIN_SPLIT_SIZE) throw err;
    Logger.log('Enrich batch failed — retrying as two halves: ' + err);
    const mid = Math.ceil(items.length / 2);
    return callClaudeEnrichWithSplitRetry_(items.slice(0, mid), apiKey, buildPayload, purpose, 1)
      .concat(callClaudeEnrichWithSplitRetry_(items.slice(mid), apiKey, buildPayload, purpose, 1));
  }
}

/** Fetch enrich results; retry any pending chunk_ids that were omitted from the response. */
function fetchEnrichBatchResults_(pending, apiKey, buildPayload, purpose) {
  let enriched = callClaudeEnrichWithSplitRetry_(pending, apiKey, buildPayload, purpose, 0);
  let attempts = 0;

  while (attempts < 3) {
    const got = {};
    enriched.forEach((item) => {
      if (item && item.chunk_id) got[item.chunk_id] = true;
    });
    const missing = pending.filter((p) => !got[p.chunk_id]);
    if (missing.length === 0) break;

    Logger.log('Enrich incomplete: got ' + enriched.length + '/' + pending.length
      + ' — retrying ' + missing.length + ' missing items');
    const more = callClaudeEnrichWithSplitRetry_(missing, apiKey, buildPayload, purpose, attempts + 1);
    if (!more.length) break;
    enriched = enriched.concat(more);
    attempts += 1;
  }

  return enriched;
}

function buildJaEnrichPayload_(batch) {
  const input = batch.map((i) => ({
    chunk_id: i.chunk_id,
    text: i.text,
    type: i.type,
    example_sentence: i.example_sentence || null,
  }));

  return {
    model: MODEL_ENRICH,
    max_tokens: ENRICH_JA_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `You are a bilingual English–Japanese lexicographer creating entries for a chunk-learning app. For each item, provide:

- ja_translation: the CORE meaning in concise, natural Japanese. Capture the functional nucleus of the chunk, not a word-by-word gloss. If the chunk is polysemous, give the SINGLE most frequent sense only (the app stores one sense per chunk). Use 〜 to mark where words attach (e.g. "〜を引き受ける", "〜のおかげで").
- example_sentence: keep the existing one if it is provided and good; otherwise write ONE natural, CONCRETE sentence (8–18 words) showing the chunk in its most typical context — a specific situation the learner can picture, never a generic statement.

Keep the Japanese clear and natural for a general adult learner (avoid overly literary vocabulary).

Return ONLY a JSON array, no markdown, no commentary before or after:
[{"chunk_id":"...","ja_translation":"...","example_sentence":"..."}]

Items:
${JSON.stringify(input)}`,
    }],
  };
}

function buildEnEnrichPayload_(batch) {
  const input = batch.map((i) => ({
    chunk_id: i.chunk_id,
    text: i.text,
    type: i.type,
    cefr: i.cefr,
    ja_translation: i.ja_translation || null,
  }));

  return {
    model: MODEL_ENRICH,
    max_tokens: ENRICH_EN_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: `You are writing English-in-English glosses for a chunk-learning app used by Japanese learners. The gloss's job is to let a learner understand the item's meaning WITHOUT translating to Japanese — building a direct English-to-meaning pathway. Optimize for "a learner reads this and instantly gets it."

For each item, provide:

- en_translation: a short English gloss (about 6–15 words) capturing the single most frequent sense.

Rules the gloss MUST follow:
1. SIMPLER THAN THE HEADWORD. Use only words that are clearly easier than the item itself — roughly one to two CEFR levels below it. A learner who needs this gloss does not know hard words, so the gloss must not contain any.
2. NO CIRCULAR DEFINITION. Never use the headword or its derivatives in the gloss (do not gloss "manage" with "to manage to...").
3. SHOW HOW IT IS USED, not just what it means. For phrasal verbs and collocations, include the typical object or situation so the learner sees the chunk in action — e.g. "pick up" → "to lift something from the ground, or collect a person"; "make a decision" → "to choose what to do after thinking".
4. EVOKE A SITUATION. Prefer wording that brings a concrete action or scene to mind over an abstract dictionary phrase.
5. ONE SENSE ONLY. If the item is polysemous, gloss only its most frequent sense.

If ja_translation is provided, use it only as private context for picking the right sense. Write the gloss in English only.

Return ONLY a JSON array, no markdown, no commentary before or after:
[{"chunk_id":"...","en_translation":"..."}]

Items:
${JSON.stringify(input)}`,
    }],
  };
}

function callClaudeEnrich_(items, apiKey) {
  return fetchEnrichBatchResults_(items, apiKey, buildJaEnrichPayload_, 'enrich_ja');
}

function callClaudeEnrichEnglish_(items, apiKey) {
  return fetchEnrichBatchResults_(items, apiKey, buildEnEnrichPayload_, 'enrich_en');
}

function ensureChunksEnrichVersionColumn_() {
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('enrich_version') >= 0) return false;
  sheet.insertColumnAfter(headers.length);
  sheet.getRange(1, headers.length + 1).setValue('enrich_version');
  Logger.log('Added enrich_version column to chunks_master.');
  return true;
}

/** Run once on existing spreadsheets missing enrich_version. */
function migrateChunksAddEnrichVersionColumn() {
  ensureChunksEnrichVersionColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const col = indexColumns_(data[0]);
  let backfilled = 0;
  for (let r = 1; r < data.length; r++) {
    const ver = Number(data[r][col.enrich_version]) || 0;
    if (ver > 0) continue;
    const ja = String(data[r][col.ja_translation] || '').trim();
    if (ja) {
      sheet.getRange(r + 1, col.enrich_version + 1).setValue(ENRICH_PROMPT_VERSION);
      backfilled += 1;
    }
  }
  Logger.log(JSON.stringify({
    ok: true,
    enrich_prompt_version: ENRICH_PROMPT_VERSION,
    backfilled,
  }));
  return { ok: true, enrich_prompt_version: ENRICH_PROMPT_VERSION, backfilled };
}

function rowNeedsJaEnrich_(row, col) {
  const ja = String(row[col.ja_translation] || '').trim();
  const ver = Number(row[col.enrich_version]) || 0;
  return !ja || ver !== ENRICH_PROMPT_VERSION;
}

function rowNeedsEnEnrich_(row, col) {
  const en = String(row[col.en_translation] || '').trim();
  const ver = Number(row[col.enrich_version]) || 0;
  return !en || ver !== ENRICH_PROMPT_VERSION;
}

function countMissingTranslations_() {
  ensureChunksEnrichVersionColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const col = indexColumns_(data[0]);
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (rowNeedsJaEnrich_(data[r], col)) count++;
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
  return runEnrichJob_({
    logLabel: 'enrichAllEnglishGlosses',
    continueHandler: ENRICH_EN_CONTINUE_HANDLER,
    clearTriggersFn: clearEnrichEnglishContinueTriggers_,
    scheduleContinueFn: scheduleEnrichEnglishContinue_,
    runBatchFn: () => enrichEnglishGlossesBatch_(ENRICH_BATCH_SIZE),
    countRemainingFn: countMissingEnglishGlosses_,
  });
}

function scheduleEnrichEnglishContinue_() {
  scheduleEnrichDelayedContinue_(ENRICH_EN_CONTINUE_HANDLER, ENRICH_CONTINUE_DELAY_MS);
}

function clearEnrichEnglishContinueTriggers_() {
  clearEnrichTriggersForHandler_(ENRICH_EN_CONTINUE_HANDLER);
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
    enrich_prompt_version: ENRICH_PROMPT_VERSION,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function enrichEnglishGlossesBatch_(batchSize) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  ensureChunksEnTranslationColumn_();
  ensureChunksEnrichVersionColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const pending = [];

  for (let r = 1; r < data.length && pending.length < batchSize; r++) {
    if (!rowNeedsEnEnrich_(data[r], col)) continue;
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
      sheet.getRange(row.row, col.enrich_version + 1).setValue(ENRICH_PROMPT_VERSION);
    }
  });

  const remaining = countMissingEnglishGlosses_();
  return { processed: enriched.length, remaining, done: remaining === 0 };
}

function countMissingEnglishGlosses_() {
  ensureChunksEnTranslationColumn_();
  ensureChunksEnrichVersionColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const data = sheet.getDataRange().getValues();
  const col = indexColumns_(data[0]);
  let count = 0;
  for (let r = 1; r < data.length; r++) {
    if (rowNeedsEnEnrich_(data[r], col)) count++;
  }
  return count;
}

// ===== Phase 3: SRS Engine (§4.2–4.4) =====

/** Days until next encounter by SRS stage (index = stage). */
const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];

/** Graduation requires active got_it signals across time and contexts — not passive timer alone. */
const GRADUATION_MIN_GOT_IT = 6;
const GRADUATION_MIN_DISTINCT_PASSAGES = 5;
const GRADUATION_MIN_SPAN_DAYS = 3;

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

function shouldGraduate_(prog, userId, chunkId) {
  const gotIt = prog.got_it_count || 0;
  if (gotIt < GRADUATION_MIN_GOT_IT) return false;
  if (prog.distinct_passages_count < GRADUATION_MIN_DISTINCT_PASSAGES) return false;
  if (gotIt === 0) return false;
  if (prog.still_hard_count / gotIt >= 0.3) return false;
  const firstAt = getFirstEncounteredAt_(userId, chunkId);
  if (!firstAt) return false;
  const spanDays = (Date.now() - firstAt.getTime()) / 86400000;
  return spanDays >= GRADUATION_MIN_SPAN_DAYS;
}

function getFirstEncounteredAt_(userId, chunkId) {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  if (sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  let earliest = null;
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] !== userId || data[r][2] !== chunkId) continue;
    const readAt = new Date(data[r][4]);
    if (isNaN(readAt.getTime())) continue;
    if (!earliest || readAt < earliest) earliest = readAt;
  }
  return earliest;
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

/** Hours to look back when deprioritizing chunks already seen in this session. */
const RECENT_CHUNK_HOURS = 24;

function getRecentChunkIds_(userId, hours) {
  const sheet = getSheet_(SHEET_NAMES.ENCOUNTERS);
  if (sheet.getLastRow() < 2) return [];
  const cutoff = Date.now() - (hours || RECENT_CHUNK_HOURS) * 3600000;
  const data = sheet.getDataRange().getValues();
  const ids = {};
  for (let r = 1; r < data.length; r++) {
    if (data[r][1] !== userId || !data[r][2]) continue;
    const readAt = new Date(data[r][4]).getTime();
    if (!isNaN(readAt) && readAt >= cutoff) ids[data[r][2]] = true;
  }
  return Object.keys(ids);
}

function resolveChunkIdForText_(text, index) {
  const key = String(text).toLowerCase().trim();
  const row = index[key];
  if (row && row.chunk_id) return row.chunk_id;
  return makeChunkId_(text);
}

function chunkIdsForPassageTemplates_(passageIds, band, index) {
  const exclude = {};
  if (!passageIds || !passageIds.length || !band || !index) return exclude;
  const templates = getPassageTemplatesForBand_(band);
  const byId = {};
  templates.forEach((tpl) => { byId[tpl.passage_id] = tpl; });
  passageIds.forEach((passageId) => {
    const tpl = byId[passageId];
    if (!tpl) return;
    (tpl.chunk_texts || []).forEach((text) => {
      exclude[resolveChunkIdForText_(text, index)] = true;
    });
  });
  return exclude;
}

function buildExcludeChunkMap_(userId, clientIds, band, index, excludePassageIds) {
  const exclude = {};
  getRecentChunkIds_(userId, RECENT_CHUNK_HOURS).forEach((id) => { exclude[id] = true; });
  (clientIds || []).forEach((id) => { if (id) exclude[id] = true; });
  Object.assign(exclude, chunkIdsForPassageTemplates_(excludePassageIds, band, index));
  return exclude;
}

/** For template scoring: also treat not-yet-due progress chunks as excluded. */
function buildTemplateExcludeMap_(userId, clientIds, progressMap, now, band, index, excludePassageIds) {
  const exclude = buildExcludeChunkMap_(userId, clientIds, band, index, excludePassageIds);
  Object.keys(progressMap || {}).forEach((chunkId) => {
    const prog = progressMap[chunkId];
    if (prog && !isDue_(prog.next_due_at, now)) exclude[chunkId] = true;
  });
  return exclude;
}

function bandCefrPriority_(band) {
  if (band === 'A1A2') return ['A2', 'A1'];
  if (band === 'B1') return ['B1', 'A2', 'A1'];
  return ['B2', 'B1', 'A2', 'A1'];
}

function orderNewChunksForBand_(newChunks, band) {
  const used = {};
  const ordered = [];
  bandCefrPriority_(band).forEach((level) => {
    const pool = newChunks.filter((c) => c.cefr === level && !used[c.chunk_id]);
    shuffleArrayInPlace_(pool);
    pool.forEach((c) => {
      used[c.chunk_id] = true;
      ordered.push(c);
    });
  });
  const rest = newChunks.filter((c) => !used[c.chunk_id]);
  shuffleArrayInPlace_(rest);
  rest.forEach((c) => ordered.push(c));
  return ordered;
}

function filterExcludedChunks_(items, excludeMap) {
  if (!excludeMap || !Object.keys(excludeMap).length) return items;
  return items.filter((c) => !excludeMap[c.chunk_id]);
}

function templateRecentChunkOverlap_(tpl, index, excludeMap) {
  if (!excludeMap || !Object.keys(excludeMap).length) return 0;
  let overlap = 0;
  (tpl.chunk_texts || []).forEach((text) => {
    if (excludeMap[resolveChunkIdForText_(text, index)]) overlap += 1;
  });
  return overlap;
}

function isPassageBlockedForSession_(passage, excludePassageIds, excludeMap) {
  if (!passage) return true;
  const blockedPassage = {};
  (excludePassageIds || []).forEach((id) => { if (id) blockedPassage[id] = true; });
  if (blockedPassage[passage.passage_id]) return true;
  const targets = passage.target_chunks || [];
  for (let i = 0; i < targets.length; i++) {
    if (excludeMap[targets[i].chunk_id]) return true;
  }
  return false;
}

function finalizePassageForRequest_(
  passage, userId, band, index, progressMap, excludePassageIds, excludeChunkIds, now,
) {
  const excludeMap = buildTemplateExcludeMap_(
    userId, excludeChunkIds, progressMap, now, band, index, excludePassageIds,
  );
  if (!isPassageBlockedForSession_(passage, excludePassageIds, excludeMap)) return passage;

  Logger.log('Passage blocked for session (id=' + (passage && passage.passage_id) + '), repicking');
  const retry = pickTemplatePassage_(band, index, progressMap, excludePassageIds, excludeMap);
  if (!isPassageBlockedForSession_(retry, excludePassageIds, excludeMap)) return retry;
  return null;
}

function filterTemplatesWithoutExcludedChunks_(templates, index, excludeMap) {
  if (!excludeMap || !Object.keys(excludeMap).length) return templates;
  return templates.filter((tpl) => templateRecentChunkOverlap_(tpl, index, excludeMap) === 0);
}

function pickTemplateFromPool_(candidates, index, excludeMap, excludePassageIds, band) {
  let pool = filterTemplatesWithoutExcludedChunks_(candidates, index, excludeMap);
  if (!pool.length && band) {
    const allBand = getPassageTemplatesForBand_(band);
    if (candidates.length !== allBand.length) {
      pool = filterTemplatesWithoutExcludedChunks_(allBand, index, excludeMap);
    }
  }
  if (!pool.length) return null;

  const lastTense = band ? getLastPassageTense_(excludePassageIds, band) : null;
  if (lastTense) {
    const altTense = pool.filter((tpl) => templateTenseHint_(tpl) !== lastTense);
    if (altTense.length) pool = altTense;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function templateTenseHint_(tpl) {
  const t = String(tpl.text_markup || '').toLowerCase();
  if (/\b(yesterday|last |ago|was |were |had |did |walked|stopped|decided)\b/.test(t)) return 'past';
  if (/\b(will |going to |tomorrow)\b/.test(t)) return 'future';
  return 'present';
}

function getLastPassageTense_(excludePassageIds, band) {
  const templates = getPassageTemplatesForBand_(band);
  const byId = {};
  templates.forEach((tpl) => { byId[tpl.passage_id] = tpl; });
  const ids = excludePassageIds || [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const tpl = byId[ids[i]];
    if (tpl) return templateTenseHint_(tpl);
  }
  return null;
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
    got_it_count,
    distinct_passages_count: distinctPassages,
    still_hard_count,
  };
  const graduated = shouldGraduate_(progSnapshot, userId, chunkId);
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
  const excludePassageIds = mergeExcludePassageIds_(userId, body.exclude_passage_ids);
  const excludeMap = buildExcludeChunkMap_(
    userId, body.exclude_chunk_ids, band, index, excludePassageIds,
  );

  const due = [];
  const newChunks = [];

  Object.values(index).forEach((chunk) => {
    if (!chunkInSrsScope_(chunk.cefr, band)) return;
    const prog = progressMap[chunk.chunk_id];
    if (!prog) {
      if (excludeMap[chunk.chunk_id]) return;
      newChunks.push({
        chunk_id: chunk.chunk_id,
        text: chunk.text,
        cefr: chunk.cefr,
        status: 'new',
      });
      return;
    }
    // SRS gate: in-progress chunks appear only when formally due.
    if (!isDue_(prog.next_due_at, now)) return;
    if (excludeMap[chunk.chunk_id]) return;
    due.push({
      chunk_id: chunk.chunk_id,
      text: chunk.text,
      cefr: chunk.cefr,
      srs_stage: prog.srs_stage,
      last_encountered_at: prog.last_encountered_at,
      status: prog.status,
      still_hard_count: prog.still_hard_count,
    });
  });

  due.sort((a, b) => (b.still_hard_count || 0) - (a.still_hard_count || 0));
  shuffleArrayInPlace_(due);

  let dueOut = due.slice(0, limit);

  if (dueOut.length === 0) {
    dueOut = collectMaintenanceDueChunks_(index, progressMap, band, now, limit, excludeMap);
  }

  const orderedNew = orderNewChunksForBand_(newChunks, band);
  const remaining = limit - dueOut.length;
  const newOut = orderedNew.slice(0, Math.max(remaining, 0));

  return { due_chunks: dueOut, new_chunks: newOut, cefr_band: band };
}

/** Minimum hours since last encounter before a non-due chunk enters maintenance rotation. */
const MAINTENANCE_MIN_HOURS = 24;

function collectMaintenanceDueChunks_(index, progressMap, band, now, limit, excludeMap) {
  const cutoff = now.getTime() - MAINTENANCE_MIN_HOURS * 3600000;
  const candidates = [];

  Object.values(index).forEach((chunk) => {
    if (!chunkInSrsScope_(chunk.cefr, band)) return;
    if (excludeMap && excludeMap[chunk.chunk_id]) return;
    const prog = progressMap[chunk.chunk_id];
    if (!prog || prog.status !== 'graduated') return;
    if (isDue_(prog.next_due_at, now)) return;
    const lastMs = new Date(prog.last_encountered_at).getTime();
    if (isNaN(lastMs) || lastMs > cutoff) return;
    candidates.push({ chunk, prog, lastMs });
  });

  candidates.sort((a, b) => a.lastMs - b.lastMs);
  shuffleArrayInPlace_(candidates);

  return candidates.slice(0, limit).map(({ chunk, prog }) => ({
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    cefr: chunk.cefr,
    srs_stage: prog.srs_stage,
    last_encountered_at: prog.last_encountered_at,
    status: prog.status,
    still_hard_count: prog.still_hard_count,
    maintenance: true,
  }));
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
  const excludeChunkIds = body.exclude_chunk_ids || [];
  const passage = buildPassageForUser_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds);
  return { passages: [passage], cefr_band: band };
}

/** Single round-trip for initial app load (one passage + header stats). */
function handleSession_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);
  const excludePassageIds = mergeExcludePassageIds_(userId, body.exclude_passage_ids);
  const excludeChunkIds = body.exclude_chunk_ids || [];
  const passage = buildPassageForUser_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds);
  const stats = computeStatsFromIndex_(index, progressMap, band);
  return { passages: [passage], cefr_band: band, ...stats };
}

function getPassageMode_() {
  const v = String(
    PropertiesService.getScriptProperties().getProperty('USE_DYNAMIC_PASSAGES') || '',
  ).toLowerCase();
  if (v === 'false' || v === 'template') return 'template';
  if (v === 'true') return 'dynamic';
  // Default hybrid so SRS due/new chunks drive passage selection.
  return 'hybrid';
}

function buildPassageForUser_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds) {
  const now = new Date();
  const templateExcludeMap = buildTemplateExcludeMap_(
    userId, excludeChunkIds, progressMap, now, band, index, excludePassageIds,
  );
  const mode = getPassageMode_();

  const dueData = handleDueChunks_({
    user_id: userId,
    cefr: band,
    limit: 20,
    exclude_chunk_ids: excludeChunkIds,
    exclude_passage_ids: excludePassageIds,
  });
  const chunks = selectChunksForPassage_(
    dueData, progressMap, index, band, templateExcludeMap, excludePassageIds,
  );
  let passage = null;

  if (mode === 'template') {
    passage = pickTemplatePassage_(band, index, progressMap, excludePassageIds, templateExcludeMap)
      || tryClaudePassageFallback_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds, chunks);
  } else if (mode === 'hybrid') {
    if (chunks.length >= 2) {
      const cacheKey = chunksCacheKey_(chunks);
      passage = findCachedPassage_(cacheKey, index, band, progressMap, excludePassageIds)
        || findCachedPassageContainingChunks_(chunks, index, band, progressMap, excludePassageIds)
        || pickTemplateCoveringChunks_(band, index, progressMap, excludePassageIds, chunks, templateExcludeMap);
    }

    if (!passage && needsNewPassageContext_(chunks, progressMap)) {
      try {
        passage = generateDynamicPassageClaude_(
          userId, band, index, progressMap, excludePassageIds, chunks, excludeChunkIds,
        );
      } catch (err) {
        Logger.log('Hybrid Claude generation failed: ' + err);
      }
    }

    if (!passage) {
      passage = pickTemplatePassage_(band, index, progressMap, excludePassageIds, templateExcludeMap)
        || tryClaudePassageFallback_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds, chunks);
    }
  } else {
    try {
      passage = generateDynamicPassage_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds);
    } catch (err) {
      Logger.log('Dynamic passage failed, using template: ' + err);
    }
    if (!passage) {
      passage = pickTemplatePassage_(band, index, progressMap, excludePassageIds, templateExcludeMap)
        || tryClaudePassageFallback_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds, chunks);
    }
  }

  return finalizePassageForRequest_(
    passage, userId, band, index, progressMap, excludePassageIds, excludeChunkIds, now,
  );
}

function isDynamicPassagesEnabled_() {
  return getPassageMode_() === 'dynamic';
}

function pickTemplateCoveringChunks_(band, index, progressMap, excludePassageIds, chunks, excludeMap) {
  const chunkTexts = {};
  chunks.forEach((c) => { chunkTexts[String(c.text).toLowerCase().trim()] = true; });
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { exclude[id] = true; });

  const templates = getPassageTemplatesForBand_(band);
  let bestScore = 0;
  let bestPool = [];

  templates.forEach((tpl) => {
    if (exclude[tpl.passage_id]) return;
    if (templateRecentChunkOverlap_(tpl, index, excludeMap) > 0) return;
    const texts = tpl.chunk_texts || [];
    let score = 0;
    texts.forEach((text) => {
      if (chunkTexts[String(text).toLowerCase().trim()]) score += 1;
    });
    if (score === 0) return;
    if (score > bestScore) {
      bestScore = score;
      bestPool = [tpl];
    } else if (score === bestScore) {
      bestPool.push(tpl);
    }
  });

  if (!bestPool.length || bestScore === 0) return null;
  const best = pickTemplateFromPool_(bestPool, index, excludeMap, excludePassageIds, band);
  if (!best) return null;
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

function generateDynamicPassageClaude_(userId, band, index, progressMap, excludePassageIds, chunks, excludeChunkIds) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const excludeMap = buildTemplateExcludeMap_(
    userId, excludeChunkIds, progressMap, new Date(), band, index, excludePassageIds,
  );
  if (!chunks || chunks.length < 2) {
    chunks = selectChunksForPassage_(
      handleDueChunks_({
        user_id: userId,
        cefr: band,
        limit: 20,
        exclude_chunk_ids: excludeChunkIds,
        exclude_passage_ids: excludePassageIds,
      }),
      progressMap,
      index,
      band,
      excludeMap,
    );
  }
  if (chunks.length < 2) throw new Error('Not enough chunks to generate passage');

  const cacheKey = chunksCacheKey_(chunks);
  const cached = findCachedPassage_(cacheKey, index, band, progressMap, excludePassageIds)
    || findCachedPassageContainingChunks_(chunks, index, band, progressMap, excludePassageIds);
  if (cached) return cached;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let generated = null;
    try {
      generated = callClaudeGeneratePassage_(chunks, band, apiKey, index, '', attempt, 'passage');
      validateGeneratedPassageOrThrow_(generated, chunks);
      const passage = buildPassageOutput_(generated, chunks, index, band, progressMap);
      if (excludePassageIds.indexOf(passage.passage_id) >= 0) {
        passage.passage_id = makePassageId_(chunks);
      }
      savePassageToDrive_(passage);
      registerPassageMeta_(passage, chunks);
      return passage;
    } catch (err) {
      lastErr = err;
      logPassageGenerationFailure_(attempt, err, generated, chunks);
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

function selectChunksForPassage_(dueData, progressMap, index, band, excludeMap, excludePassageIds) {
  const due = filterExcludedChunks_(dueData.due_chunks || [], excludeMap);
  const newChunks = filterExcludedChunks_(dueData.new_chunks || [], excludeMap);
  const selected = [];
  const used = {};
  let newCount = 0;

  function isNewChunk(item) {
    const prog = progressMap[item.chunk_id];
    return !prog || prog.status === 'new' || prog.srs_stage === 0;
  }

  function add(item) {
    if (!item || used[item.chunk_id]) return;
    if (excludeMap && excludeMap[item.chunk_id]) return;
    const row = index[String(item.text).toLowerCase().trim()] || item;
    const chunkId = row.chunk_id || item.chunk_id;
    if (isNewChunk({ chunk_id: chunkId }) && newCount >= 2) return;
    used[chunkId] = true;
    if (isNewChunk({ chunk_id: chunkId })) newCount += 1;
    selected.push({
      chunk_id: chunkId,
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
    due.filter((c) => !isNewChunk(c)).slice(0, 4).forEach(add);
  }
  if (selected.length < 2 && newChunks.length > 1) {
    add(newChunks[1]);
  }
  if (selected.length < 2) {
    due.slice(0, 4).forEach(add);
  }
  if (selected.length < 2) {
    const templates = getPassageTemplatesForBand_(band);
    const tpl = pickTemplateFromPool_(templates, index, excludeMap, excludePassageIds || [], band);
    if (tpl) {
      (tpl.chunk_texts || []).forEach((text) => {
        add(index[String(text).toLowerCase().trim()] || fallbackChunk_(text, band));
      });
    }
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
    const verdict = col.critique_verdict !== undefined
      ? String(data[r][col.critique_verdict] || '').toLowerCase()
      : '';
    if (verdict === 'revise') continue;
    const fileId = data[r][col.drive_file_id];
    if (!fileId) continue;
    try {
      const json = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'));
      const hydrated = hydratePassageFromJson_(json, index, band, progressMap);
      hydrated._critique_verdict = verdict;
      candidates.push(hydrated);
    } catch (e) { /* skip bad cache */ }
  }

  if (candidates.length === 0) return null;
  const passed = candidates.filter((c) => c._critique_verdict === 'pass');
  const pool = passed.length ? passed : candidates;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  delete pick._critique_verdict;
  return pick;
}

/**
 * Reuse a cached passage whose target chunks are a superset of the requested set.
 * Preserves contextual variety: extra chunks in cache do not block reuse for due subsets.
 */
function findCachedPassageContainingChunks_(chunks, index, band, progressMap, excludePassageIds) {
  const requested = {};
  (chunks || []).forEach((c) => { if (c && c.chunk_id) requested[c.chunk_id] = true; });
  const requestedIds = Object.keys(requested);
  if (requestedIds.length < 2) return null;

  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  if (sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { if (id) exclude[id] = true; });
  const candidates = [];

  for (let r = data.length - 1; r >= 1; r--) {
    const passageId = String(data[r][col.passage_id] || '');
    if (exclude[passageId]) continue;
    const cachedIds = String(data[r][col.target_chunk_ids] || '').split(',').filter(Boolean);
    if (cachedIds.length < requestedIds.length) continue;
    const hasAll = requestedIds.every((id) => cachedIds.indexOf(id) >= 0);
    if (!hasAll) continue;
    const exactKey = cachedIds.slice().sort().join(',');
    const requestKey = requestedIds.slice().sort().join(',');
    if (exactKey === requestKey) continue;

    const verdict = col.critique_verdict !== undefined
      ? String(data[r][col.critique_verdict] || '').toLowerCase()
      : '';
    if (verdict === 'revise') continue;
    const fileId = data[r][col.drive_file_id];
    if (!fileId) continue;
    try {
      const json = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'));
      const hydrated = hydratePassageFromJson_(json, index, band, progressMap);
      hydrated._critique_verdict = verdict;
      candidates.push(hydrated);
    } catch (e) { /* skip bad cache */ }
  }

  if (candidates.length === 0) return null;
  const passed = candidates.filter((c) => c._critique_verdict === 'pass');
  const pool = passed.length ? passed : candidates;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  delete pick._critique_verdict;
  return pick;
}

function generateDynamicPassage_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const excludeMap = buildTemplateExcludeMap_(
    userId, excludeChunkIds, progressMap, new Date(), band, index, excludePassageIds,
  );

  const dueData = handleDueChunks_({
    user_id: userId,
    cefr: band,
    limit: 20,
    exclude_chunk_ids: excludeChunkIds,
    exclude_passage_ids: excludePassageIds,
  });
  const chunks = selectChunksForPassage_(dueData, progressMap, index, band, excludeMap);
  if (chunks.length < 2) throw new Error('Not enough chunks to generate passage');

  const cacheKey = chunksCacheKey_(chunks);
  const cached = findCachedPassage_(cacheKey, index, band, progressMap, excludePassageIds)
    || findCachedPassageContainingChunks_(chunks, index, band, progressMap, excludePassageIds);
  if (cached) return cached;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let generated = null;
    try {
      generated = callClaudeGeneratePassage_(chunks, band, apiKey, index, '', attempt, 'passage');
      validateGeneratedPassageOrThrow_(generated, chunks);
      const passage = buildPassageOutput_(generated, chunks, index, band, progressMap);
      if (excludePassageIds.indexOf(passage.passage_id) >= 0) {
        passage.passage_id = makePassageId_(chunks);
      }
      savePassageToDrive_(passage);
      registerPassageMeta_(passage, chunks);
      return passage;
    } catch (err) {
      lastErr = err;
      logPassageGenerationFailure_(attempt, err, generated, chunks);
      Utilities.sleep(400);
    }
  }
  throw lastErr || new Error('Passage generation failed');
}

function callClaudeGeneratePassage_(chunks, band, apiKey, index, revisionHint, retryIndex, purpose) {
  const payload = {
    model: MODEL_PASSAGE,
    max_tokens: 4096,
    system: passageSystemBlocks_(),
    messages: [{
      role: 'user',
      content: buildPassageUserPrompt_(chunks, band, index, revisionHint),
    }],
  };

  return callAnthropicJson_(payload, apiKey, {
    purpose: purpose || 'passage',
    retry_index: retryIndex || 0,
  });
}

const PASSAGE_SYSTEM_PROMPT_ = [
  'You are an expert writer of graded reading passages for Japanese learners of English. Your passages power a spaced-repetition reading app whose single goal is to automatize knowledge of multi-word chunks (phrasal verbs, collocations, idioms, discourse markers) through repeated encounters in DIFFERENT contexts.',
  '',
  'Follow these principles without exception:',
  '',
  '1. COMPREHENSIBLE INPUT (true i+1). The words AROUND the target chunks must be ones the learner already knows — at or below the stated CEFR band. The target chunks are the ONLY new or practiced element (the "+1"). Never place an unknown word next to a target chunk; the learner must be able to lean on known context.',
  '',
  '2. INFERABILITY. For each target chunk, the situation must give concrete cues to its meaning, so a learner who does not yet know the chunk could reasonably guess it from context — without a dictionary.',
  '',
  '3. NATURAL USE. Each chunk must appear in the grammatical frame and with the typical collocates a fluent writer would actually use. Never twist a sentence just to fit a chunk. If two chunks cannot co-occur naturally, prioritize naturalness and say so in self_check.',
  '',
  '4. CONCRETE AND MEMORABLE. Write a vivid, specific scene — a particular person doing a particular thing in a particular place. Concrete, imageable situations are remembered far better than abstract statements. Never write generic filler such as "Many people think that..." or "In today\'s society...".',
  '',
  '5. CONTEXTUAL VARIETY. You will be told how each chunk appeared in PREVIOUS passages. Make THIS passage genuinely different: a different scenario, different collocates, a different sentence structure. Reusing a prior context defeats the entire purpose of the app.',
  '',
  '6. REGISTER AND LINGUISTIC VARIETY BY CEFR BAND.',
  '',
  'Each band has a target distribution. Across many passages your output should hit these distributions on average. Within a single passage, prefer ONE or TWO tenses for coherence — but do not default to present simple every time.',
  '',
  'A1/A2:',
  '- Topics: everyday concrete scenes (home, shopping, travel, daily routine, school).',
  '- Tenses: present simple AND past simple, both common. Occasionally present continuous. Do not write only in present.',
  '- Subjects: vary across I, you, he, she, we, they, and named people. About one third of passages should feature a third-person singular subject so the learner meets -s/-es marking.',
  '- Voice: active only.',
  '- Connectors: and, but, so, then, because, when.',
  '',
  'B1:',
  '- Topics: everyday plus light work, study, and social topics.',
  '- Tenses: present simple, past simple, present continuous, present perfect, past continuous all in play. Roughly half the passages should be in past time frames.',
  '- Subjects: full range of persons; third-person singular routinely.',
  '- Voice: mostly active; a simple passive may appear when natural (e.g. "the package was delivered").',
  '- Connectors: also use although, while, since, however, as a result, in addition.',
  '',
  'B2:',
  '- Topics: may include abstract, argumentative, or reporting register.',
  '- Tenses: full range including past perfect, present perfect continuous, used to, conditional forms. Tense should serve the narrative, not avoid difficulty.',
  '- Subjects: full range, including impersonal it / there constructions.',
  '- Voice: active and passive both used naturally; report register may use passive ("it has been argued that ...").',
  '- Connectors: full range of cohesive devices including despite, nevertheless, on the other hand, given that.',
  '',
  'ABSOLUTE RULES (all bands):',
  '- Target chunks themselves are NEVER altered. If a chunk is "managed to", write "managed to" (or "I/he/she managed to", "had managed to" if natural) — never rewrite the chunk into a different form.',
  '- Do not force a tense in just to display variety. Pick the tense that makes the scene most natural, but actively resist defaulting to present simple.',
  '- Keep tense usage coherent WITHIN a passage (don\'t randomly flip tenses sentence by sentence).',
  '',
  'Output ONLY valid JSON (no markdown fences), in exactly this shape:',
  '{',
  '  "text": "the passage as plain text",',
  '  "ja_translation": "natural Japanese translation faithful to the English",',
  '  "target_chunks": [',
  '    {"chunk_id": "...", "text": "exact substring as it appears in text", "char_start": 0, "char_end": 0}',
  '  ],',
  '  "self_check": {',
  '    "all_chunks_used_naturally": true,',
  '    "surrounding_vocab_within_band": true,',
  '    "each_chunk_inferable_from_context": true,',
  '    "different_from_prior_contexts": true,',
  '    "tense_appropriate_for_scene": true,',
  '    "notes": "one short sentence; flag any compromise you had to make"',
  '  }',
  '}',
  '',
  'char_start and char_end are 0-based, end-exclusive indices into the "text" field.',
].join('\n');

function buildPassageUserPrompt_(chunks, band, index, revisionHint) {
  const cefrHint = band === 'A1A2' ? 'A1/A2' : band;
  const lines = [
    `CEFR band: ${cefrHint}`,
    'Length: 3 to 6 sentences, 60 to 120 words total.',
    '',
    'Target chunks (embed ALL of them, each at least once):',
    '',
  ];

  chunks.forEach((c) => {
    const row = index[String(c.text).toLowerCase().trim()] || c;
    const meaning = String(row.ja_translation || row.en_translation || '').trim();
    lines.push(`- "${c.text}"  (chunk_id: ${c.chunk_id})`);
    if (meaning) lines.push(`    intended meaning: ${meaning}`);
    const priors = getChunkPriorContexts_(c.chunk_id, index, 3);
    if (priors.length) {
      lines.push('    previously appeared as:');
      priors.forEach((snippet) => { lines.push(`      • ${snippet}`); });
      lines.push('    make this encounter clearly different from the above.');
      if (priors.length > 1) lines.push('    if the prior contexts all share a tense or subject person, prefer a different one here.');
    } else {
      lines.push('    this is the learner\'s FIRST encounter — introduce it in an especially clear, self-explaining context.');
    }
    lines.push('');
  });

  lines.push('Write the passage now.');
  if (revisionHint) {
    lines.push('');
    lines.push(`Revision instruction: ${revisionHint}`);
  }
  return lines.join('\n');
}

function getChunkPriorContexts_(chunkId, index, limit) {
  limit = limit || 3;
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  if (sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = indexColumns_(headers);
  const snippets = [];
  const seen = {};

  for (let r = data.length - 1; r >= 1 && snippets.length < limit; r--) {
    const ids = String(data[r][col.target_chunk_ids] || '').split(',');
    if (ids.indexOf(chunkId) < 0) continue;
    const fileId = data[r][col.drive_file_id];
    if (!fileId || seen[fileId]) continue;
    seen[fileId] = true;
    try {
      const json = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8'));
      const text = json.text || '';
      const chunkText = findChunkTextForId_(chunkId, json, index);
      if (!chunkText) continue;
      const snippet = extractSentenceContainingChunk_(text, chunkText);
      if (snippet && snippets.indexOf(snippet) < 0) snippets.push(snippet);
    } catch (e) { /* skip */ }
  }
  return snippets;
}

function findChunkTextForId_(chunkId, passageJson, index) {
  const targets = passageJson.target_chunks || [];
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].chunk_id === chunkId) return targets[i].text;
  }
  for (const key in index) {
    if (index[key].chunk_id === chunkId) return index[key].text;
  }
  return '';
}

function extractSentenceContainingChunk_(text, chunkText) {
  const lower = String(text).toLowerCase();
  const needle = String(chunkText).toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return String(text).slice(0, 120).trim();
  let start = idx;
  let end = idx + chunkText.length;
  while (start > 0 && !'.!?'.includes(text[start - 1])) start -= 1;
  while (end < text.length && !'.!?'.includes(text[end])) end += 1;
  if (end < text.length) end += 1;
  return text.slice(start, end).trim();
}

function callClaudeCritiquePassage_(generated, chunks, band, index, apiKey, retryIndex, purpose) {
  const cefrHint = band === 'A1A2' ? 'A1/A2' : band;
  const chunkLines = chunks.map((c) => {
    const row = index[String(c.text).toLowerCase().trim()] || c;
    const meaning = String(row.ja_translation || row.en_translation || '').trim();
    const priors = getChunkPriorContexts_(c.chunk_id, index, 3);
    return `- "${c.text}"${meaning ? ` (${meaning})` : ''}${priors.length ? `\n  prior: ${priors.join(' | ')}` : ''}`;
  }).join('\n');

  const variableText = [
    `CEFR band for this passage: ${cefrHint}`,
    '',
    'Passage:',
    generated.text,
    '',
    'Japanese translation:',
    generated.ja_translation,
    '',
    'Target chunks (with intended meaning):',
    chunkLines,
  ].join('\n');

  const payload = {
    model: MODEL_CRITIQUE,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: CRITIQUE_CACHED_PROMPT_,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: variableText },
      ],
    }],
  };

  return callAnthropicJson_(payload, apiKey, {
    purpose: purpose || 'critique',
    retry_index: retryIndex || 0,
  });
}

const CRITIQUE_CACHED_PROMPT_ = [
  'You are a strict reviewer of graded reading passages for English learners. Score the passage on each criterion from 0 to 2 (0 = fails, 1 = weak, 2 = good). Be honest; this gates what learners see.',
  '',
  'Criteria:',
  '- naturalness: reads like authentic English; no chunk was forced in awkwardly',
  '- comprehensibility: surrounding vocabulary is within CEFR band; nothing harder than the target chunks themselves',
  '- inferability: each target chunk\'s meaning can be guessed from the surrounding context',
  '- chunk_integrity: every target chunk appears verbatim and is used correctly',
  '- variety: genuinely different scenario/collocates/structure from the prior contexts (score 2 if no prior contexts were given)',
  '- linguistic_variety: tense/person/voice fit the scene and CEFR band; not a default present-simple I-narrator',
  '- concreteness: a vivid, specific situation rather than abstract filler',
  '- translation_fidelity: the Japanese is accurate and natural',
  '',
  'Output ONLY JSON:',
  '{',
  '  "scores": {',
  '    "naturalness": 0,',
  '    "comprehensibility": 0,',
  '    "inferability": 0,',
  '    "chunk_integrity": 0,',
  '    "variety": 0,',
  '    "linguistic_variety": 0,',
  '    "concreteness": 0,',
  '    "translation_fidelity": 0',
  '  },',
  '  "total": 0,',
  '  "verdict": "pass" or "revise",',
  '  "problems": ["short bullet per issue"],',
  '  "revision_hint": "one concrete instruction for regeneration, if verdict is revise"',
  '}',
  '',
  'Pass threshold: total >= 13 AND no single criterion scores 0.',
].join('\n');

function critiquePasses_(critique) {
  if (!critique || !critique.scores) return false;
  const scores = critique.scores;
  const keys = ['naturalness', 'comprehensibility', 'inferability', 'chunk_integrity',
    'variety', 'linguistic_variety', 'concreteness', 'translation_fidelity'];
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const s = Number(scores[keys[i]]);
    if (isNaN(s) || s <= 0) return false;
    total += s;
  }
  if (total < 13) return false;
  if (String(critique.verdict || '').toLowerCase() === 'revise') return false;
  return true;
}

function callAnthropicJson_(payload, apiKey, usageMeta) {
  const body = fetchAnthropicBody_(payload, apiKey, usageMeta);
  if (!body.content || !body.content.length) throw new Error('Empty Claude response');
  const raw = body.content[0].text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(raw);
}

function validatePassageChunks_(text, chunks) {
  const lower = String(text).toLowerCase();
  return chunks.every((c) => lower.indexOf(String(c.text).toLowerCase()) >= 0);
}

/** Fix char_start/char_end from actual passage text (Claude often misreports indices). */
function repairPassageTargetChunkSpans_(generated, chunks) {
  if (!generated || !generated.text) return generated;
  const text = String(generated.text);
  const lower = text.toLowerCase();
  const byId = {};
  (chunks || []).forEach((c) => { if (c && c.chunk_id) byId[c.chunk_id] = c; });

  (generated.target_chunks || []).forEach((tc) => {
    const row = byId[tc.chunk_id] || tc;
    const expected = String(row.text || tc.text || '').trim();
    if (!expected) return;
    const idx = lower.indexOf(expected.toLowerCase());
    if (idx < 0) return;
    tc.text = text.slice(idx, idx + expected.length);
    tc.char_start = idx;
    tc.char_end = idx + expected.length;
  });
  return generated;
}

function describePassageQualityFailure_(generated) {
  const reasons = [];
  const text = String(generated?.text || '').trim();
  const ja = String(generated?.ja_translation || '').trim();
  if (!text) reasons.push('empty text');
  if (!ja) reasons.push('empty ja_translation');

  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3) reasons.push('too few sentences (' + sentences.length + ')');
  if (sentences.length > 6) reasons.push('too many sentences (' + sentences.length + ')');

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 40) reasons.push('too few words (' + words.length + ')');
  if (words.length > 140) reasons.push('too many words (' + words.length + ')');

  const targets = generated?.target_chunks || [];
  if (targets.length < 2) reasons.push('target_chunks < 2');

  targets.forEach((tc, i) => {
    const start = Number(tc.char_start);
    const end = Number(tc.char_end);
    if (isNaN(start) || isNaN(end) || end <= start) {
      reasons.push('chunk[' + i + '] invalid span ' + start + '-' + end);
      return;
    }
    const slice = text.slice(start, end);
    if (!slice || slice.toLowerCase() !== String(tc.text).toLowerCase()) {
      reasons.push('chunk[' + i + '] position mismatch at ' + start + '-' + end
        + ' expected "' + tc.text + '" got "' + slice + '"');
    }
  });

  if (!validatePassageSelfCheck_(generated?.self_check)) {
    reasons.push('self_check: ' + JSON.stringify(generated.self_check));
  }
  return reasons;
}

function validatePassageQuality_(generated) {
  return describePassageQualityFailure_(generated).length === 0;
}

function validateGeneratedPassageOrThrow_(generated, chunks) {
  repairPassageTargetChunkSpans_(generated, chunks);
  if (!validatePassageChunks_(generated.text, chunks)) {
    throw new Error('Generated passage missing target chunks');
  }
  const reasons = describePassageQualityFailure_(generated);
  if (reasons.length) {
    throw new Error('Generated passage failed quality checks: ' + reasons.join('; '));
  }
}

function logPassageGenerationFailure_(attempt, err, generated, chunks) {
  if (generated) repairPassageTargetChunkSpans_(generated, chunks);
  const reasons = generated ? describePassageQualityFailure_(generated) : [];
  const msg = String(err && err.message || err);
  Logger.log('Passage attempt ' + (attempt + 1) + '/3 failed: ' + msg
    + (reasons.length ? ' | detail: ' + reasons.join('; ') : ''));
}

function validatePassageSelfCheck_(selfCheck) {
  if (!selfCheck) return true;
  const flags = [
    'all_chunks_used_naturally',
    'surrounding_vocab_within_band',
    'each_chunk_inferable_from_context',
    'different_from_prior_contexts',
    'tense_appropriate_for_scene',
  ];
  for (let i = 0; i < flags.length; i++) {
    if (selfCheck[flags[i]] === false) return false;
  }
  return true;
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

function registerPassageMeta_(passage, chunks, critique) {
  ensurePassagesCritiqueColumns_();
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  const text = passage.text || passage.text_markup.replace(/\{\{|\}\}/g, '');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const total = critique && critique.total != null ? critique.total : '';
  const verdict = critique && critique.verdict ? critique.verdict : '';
  sheet.appendRow([
    passage.passage_id,
    passage.cefr_band,
    passage.drive_file_id || '',
    chunks.map((c) => c.chunk_id).join(','),
    wordCount,
    '',
    new Date().toISOString(),
    total,
    verdict,
  ]);
}

// ===== Prompt renewal: sheet refresh + critique migration =====

/**
 * Run ONCE before re-running enrich with renewed prompts (§ work-request).
 * Clears legacy passage cache and adds critique columns.
 * Chunk translations: bump ENRICH_PROMPT_VERSION in Code.gs, then enrichAllTranslations().
 */
function preparePromptRenewalRefresh() {
  ensurePassagesCritiqueColumns_();
  ensureChunksEnrichVersionColumn_();
  const passagesCleared = clearPassagesMetaAndDriveCache_();
  Logger.log(JSON.stringify({
    ok: true,
    passages_meta_rows_cleared: passagesCleared,
    enrich_prompt_version: ENRICH_PROMPT_VERSION,
    note: 'Chunk translations are NOT cleared. Bump ENRICH_PROMPT_VERSION to re-enrich stale rows only.',
  }));
  return {
    ok: true,
    passages_meta_rows_cleared: passagesCleared,
    enrich_prompt_version: ENRICH_PROMPT_VERSION,
    next_steps: [
      '1. If enrich prompts changed: increment ENRICH_PROMPT_VERSION in Code.gs, redeploy',
      '2. enrichAllTranslations() until remaining = 0',
      '3. enrichAllEnglishGlosses() until remaining = 0',
      '4. setupNightlyWarmupTrigger() — optional nightly cache warmup',
      '5. generateTemplateBatch_("B1", 1) for sample review',
    ],
  };
}

/** Emergency only: wipe all chunk translations (triggers full re-enrich). */
function clearAllChunkTranslationsForReenrich() {
  const rows = clearChunksTranslationsForReenrich_();
  return { cleared_rows: rows, warning: 'Full re-enrich required. Prefer bumping ENRICH_PROMPT_VERSION instead.' };
}

/** Clear ja_translation, en_translation, example_sentence so enrich re-runs with new prompts. */
function clearChunksTranslationsForReenrich_() {
  ensureChunksEnTranslationColumn_();
  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = indexColumns_(headers);
  const jaCol = col.ja_translation + 1;
  const enCol = col.en_translation + 1;
  const exCol = col.example_sentence + 1;
  const rows = lastRow - 1;
  sheet.getRange(2, jaCol, rows, 1).clearContent();
  sheet.getRange(2, enCol, rows, 1).clearContent();
  sheet.getRange(2, exCol, rows, 1).clearContent();
  Logger.log(`Cleared ja_translation, en_translation, example_sentence on ${rows} rows.`);
  return rows;
}

function ensurePassagesCritiqueColumns_() {
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  if (sheet.getLastRow() < 1) return false;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let changed = false;
  if (headers.indexOf('critique_total') < 0) {
    sheet.insertColumnAfter(headers.length);
    sheet.getRange(1, headers.length + 1).setValue('critique_total');
    changed = true;
  }
  const headers2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers2.indexOf('critique_verdict') < 0) {
    sheet.insertColumnAfter(headers2.length);
    sheet.getRange(1, headers2.length + 1).setValue('critique_verdict');
    changed = true;
  }
  if (changed) Logger.log('Added critique_total / critique_verdict to passages_meta.');
  return true;
}

/** Remove old dynamically generated passages (pre–prompt-renewal cache). */
function clearPassagesMetaAndDriveCache_() {
  const sheet = getSheet_(SHEET_NAMES.PASSAGES);
  const lastRow = sheet.getLastRow();
  let cleared = 0;
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
    cleared = lastRow - 1;
  }
  try {
    const folder = getOrCreateSubfolder_(getDriveRoot_(), 'passages');
    const files = folder.getFiles();
    while (files.hasNext()) {
      files.next().setTrashed(true);
    }
  } catch (e) {
    Logger.log('Drive passages/ clear: ' + e);
  }
  Logger.log(`Cleared ${cleared} passages_meta rows and Drive passages/ cache.`);
  return cleared;
}

/**
 * Background: generate + critique until pass. Stores critique_verdict=pass in passages_meta.
 */
function generatePassageWithCritique_(chunks, band, index, progressMap, apiKey) {
  let revisionHint = '';
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let generated = null;
    try {
      generated = callClaudeGeneratePassage_(chunks, band, apiKey, index, revisionHint, attempt, 'warmup');
      validateGeneratedPassageOrThrow_(generated, chunks);
      const critique = callClaudeCritiquePassage_(generated, chunks, band, index, apiKey, attempt, 'warmup');
      if (!critiquePasses_(critique)) {
        revisionHint = critique.revision_hint || (critique.problems || []).join('; ');
        throw new Error('Critique revise: ' + revisionHint);
      }
      const passage = buildPassageOutput_(generated, chunks, index, band, progressMap);
      savePassageToDrive_(passage);
      registerPassageMeta_(passage, chunks, critique);
      return { passage, critique };
    } catch (err) {
      lastErr = err;
      logPassageGenerationFailure_(attempt, err, generated, chunks);
      Utilities.sleep(600);
    }
  }
  throw lastErr || new Error('generatePassageWithCritique_ failed');
}

/**
 * Generate template candidates for Naoya review. Outputs to Logger + Drive shared/.
 * @param {string} band A1A2 | B1 | B2
 * @param {number} count passages to generate
 */
function generateTemplateBatch_(band, count) {
  band = normalizeCefrBand_(band || 'B1');
  count = Math.max(1, Math.min(count || 1, 5));
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const index = loadChunksIndex_();
  const progressMap = {};
  const pool = Object.values(index).filter((c) => cefrMatchesBand_(c.cefr, band));
  if (pool.length < 4) throw new Error('Not enough chunks for band ' + band);

  const themes = ['daily routine', 'shopping', 'travel', 'work', 'friends and family'];
  const existing = getPassageTemplatesForBand_(band);
  const excludeOpeners = existing.map((t) => String(t.text_markup || '').slice(0, 40));
  const results = [];

  for (let n = 0; n < count; n++) {
    shuffleArrayInPlace_(pool);
    const size = 2 + Math.floor(Math.random() * 3);
    const chunks = pool.slice(0, size).map((c) => ({
      chunk_id: c.chunk_id,
      text: c.text,
      cefr: c.cefr,
    }));
    const themeHint = themes[n % themes.length];
    const revisionHint = `Theme: ${themeHint}. Avoid openings similar to: ${excludeOpeners.join(' | ')}`;

    const generated = callClaudeGeneratePassage_(chunks, band, apiKey, index, revisionHint, 0, 'template_batch');
    repairPassageTargetChunkSpans_(generated, chunks);
    if (!validatePassageQuality_(generated)) {
      Logger.log('Template batch: quality fail, skipping — '
        + describePassageQualityFailure_(generated).join('; '));
      continue;
    }
    const critique = callClaudeCritiquePassage_(generated, chunks, band, index, apiKey, 0, 'template_batch');
    const chunkTexts = (generated.target_chunks || []).map((tc) => tc.text);
    const tpl = {
      passage_id: 'ps_gen_' + band.toLowerCase() + '_' + (n + 1),
      cefr_band: band,
      text_markup: buildTextMarkupFromPositions_(generated.text, generated.target_chunks || []),
      ja_translation: generated.ja_translation || '',
      chunk_texts: chunkTexts,
      critique_total: critique.total,
      critique_verdict: critique.verdict,
    };
    results.push(tpl);
    excludeOpeners.push(String(tpl.text_markup).slice(0, 40));
  }

  const outName = 'template-batch-' + band + '-' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmm') + '.json';
  const payload = {};
  payload[band] = results;
  const shared = getOrCreateSubfolder_(getDriveRoot_(), 'shared');
  shared.createFile(outName, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  Logger.log(JSON.stringify({ band, count: results.length, file: outName, templates: results }, null, 2));
  return { band, count: results.length, drive_file: outName, templates: results };
}

/** Warmup: generate critique-passed passages for due-like chunk sets (offline). */
function warmupPassagesForBand_(band, count) {
  band = normalizeCefrBand_(band || 'B1');
  count = Math.max(1, Math.min(count || 3, 10));
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_('naoya');
  const dueData = handleDueChunks_({ user_id: 'naoya', cefr: band, limit: 20 });
  let generated = 0;
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const chunks = selectChunksForPassage_(dueData, progressMap, index, band);
      if (chunks.length < 2) break;
      generatePassageWithCritique_(chunks, band, index, progressMap, apiKey);
      generated += 1;
      Utilities.sleep(800);
    } catch (e) {
      errors.push(String(e));
    }
  }
  return { band, generated, errors };
}

/** Install a daily trigger (3:00 project timezone) to warmup passages for all bands. Run once manually. */
function setupNightlyWarmupTrigger() {
  clearNightlyWarmupTriggers_();
  ScriptApp.newTrigger(WARMUP_NIGHTLY_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  Logger.log('Nightly warmup trigger installed (3:00 daily).');
  return { ok: true, handler: WARMUP_NIGHTLY_HANDLER, hour: 3 };
}

function clearNightlyWarmupTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === WARMUP_NIGHTLY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** Trigger handler — do not run manually unless testing. */
function runNightlyWarmup_() {
  const bands = ['A1A2', 'B1', 'B2'];
  const results = [];
  bands.forEach((band) => {
    try {
      results.push(warmupPassagesForBand_(band, 3));
    } catch (e) {
      Logger.log('Nightly warmup ' + band + ': ' + e);
      results.push({ band, error: String(e) });
    }
  });
  Logger.log(JSON.stringify({ nightly_warmup: results }));
  return results;
}

function shuffleArrayInPlace_(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function pickTemplatePassage_(band, index, progressMap, excludePassageIds, excludeMap) {
  const templates = getPassageTemplatesForBand_(band);
  const exclude = {};
  (excludePassageIds || []).forEach((id) => { exclude[id] = true; });
  const candidates = templates.filter((t) => !exclude[t.passage_id]);
  const tpl = pickTemplateFromPool_(candidates, index, excludeMap, excludePassageIds, band);
  if (!tpl) return null;
  return enrichPassageTemplate_(tpl, index, band, progressMap);
}

function tryClaudePassageFallback_(userId, band, index, progressMap, excludePassageIds, excludeChunkIds, chunks) {
  if (!chunks || chunks.length < 2) return null;
  try {
    return generateDynamicPassageClaude_(
      userId, band, index, progressMap, excludePassageIds, chunks, excludeChunkIds,
    );
  } catch (err) {
    Logger.log('Claude fallback failed: ' + err);
    return null;
  }
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

  const total = newCount + learning + reviewing + graduated;
  const encountered = total - newCount;

  return {
    reviewing: reviewing + learning,
    graduated,
    learning,
    new: newCount,
    total,
    encountered,
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
        text_markup: 'Yesterday I walked into a small café near my house. I stopped to {{look at}} the menu on the wall and {{pick up}} a cup of hot tea. There were {{a lot of}} people that day, but the waiter smiled and helped me find a seat.',
        ja_translation: '昨日、家の近くの小さなカフェに入った。壁のメニューを見て、温かいお茶を手に取った。その日はたくさん人がいたが、ウェイターは笑顔で席を見つけるのを手伝ってくれた。',
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
        text_markup: 'It was late at night. I had already had dinner when I decided to {{turn on}} the light in my room and {{sit down}} at my desk. I still had {{a few}} books I wanted to finish before bed.',
        ja_translation: '夜遅かった。すでに夕食を済ませたあと、部屋の明かりをつけて机に座った。寝る前に読み終えたい本がまだ数冊あった。',
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
  'looked at': { ja: '見た', en: 'to direct your eyes toward something' },
  'pick up': { ja: '手に取る', en: 'to lift or take something with your hands' },
  'a lot of': { ja: 'たくさんの', en: 'many; a large amount of' },
  'get up': { ja: '起きる', en: 'to rise from bed or a seated position' },
  'got up': { ja: '起きた', en: 'to rise from bed or a seated position' },
  'go out': { ja: '外出する', en: 'to leave home for an activity' },
  'went out': { ja: '外出した', en: 'to leave home for an activity' },
  'a little': { ja: '少し', en: 'a small amount; slightly' },
  'turn on': { ja: 'つける／オンにする', en: 'to switch on (a light, device, etc.)' },
  'turned on': { ja: 'つけた／オンにした', en: 'to switch on (a light, device, etc.)' },
  'sit down': { ja: '座る', en: 'to take a seat' },
  'sat down': { ja: '座った', en: 'to take a seat' },
  'a few': { ja: 'いくつかの／少しの', en: 'a small number of' },
  'wake up': { ja: '目を覚ます／起きる', en: 'to stop sleeping; to get out of bed' },
  'woke up': { ja: '目を覚ました／起きた', en: 'to stop sleeping; to get out of bed' },
  'look for': { ja: '探す', en: 'to try to find something' },
  'looked for': { ja: '探した', en: 'to try to find something' },
  'come back': { ja: '戻ってくる', en: 'to return to a place' },
  'came back': { ja: '戻ってきた', en: 'to return to a place' },
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
