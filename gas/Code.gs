/**
 * English Reader Trainer — Backend (Phase 3)
 *
 * Script Properties:
 *   SPREADSHEET_ID, DRIVE_ROOT_ID
 *   ANTHROPIC_API_KEY — for ja_translation batch (enrichTranslationsBatch)
 *
 * Manual setup (Apps Script editor):
 *   1. setupSheets() — once
 *   2. importChunksFromCefr() — after cefr_*.json in Drive shared/
 *   3. enrichAllTranslations(10) — repeat until remaining = 0
 *   4. Redeploy Web App after code changes
 */

const SHEET_NAMES = {
  CHUNKS: 'chunks_master',
  PROGRESS: 'user_progress',
  PASSAGES: 'passages_meta',
  ENCOUNTERS: 'encounter_log',
};

const SHEET_HEADERS = {
  [SHEET_NAMES.CHUNKS]: [
    'chunk_id', 'text', 'type', 'cefr', 'pos', 'ja_translation',
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
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ENRICH_BATCH_SIZE = 25;

// ===== HTTP =====

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    if (action === 'due_chunks') return jsonResponse(handleDueChunks_(body));
    if (action === 'generate_passage') return jsonResponse(handleGeneratePassage_(body));
    if (action === 'log_encounter') return jsonResponse(handleLogEncounter_(body));
    if (action === 'update_progress') return jsonResponse(handleUpdateProgress_(body));
    if (action === 'stats') return jsonResponse(handleStats_(body));

    return jsonResponse({ error: `Unknown action: ${action}` });
  } catch (err) {
    return jsonResponse({ error: String(err && err.message || err) });
  }
}

function doGet() {
  let chunksCount = 0;
  try {
    chunksCount = Math.max(0, getSheet_(SHEET_NAMES.CHUNKS).getLastRow() - 1);
  } catch (e) { /* sheet not ready */ }
  return jsonResponse({
    status: 'ok',
    service: 'english-reader-trainer',
    phase: 3,
    chunks_master_count: chunksCount,
  });
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
  CacheService.getScriptCache().remove('chunks_index_v1');
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

/** Process up to ENRICH_BATCH_SIZE rows missing ja_translation. Run repeatedly. */
function enrichTranslationsBatch() {
  return enrichTranslationsBatch_(ENRICH_BATCH_SIZE);
}

/** Run multiple batches in one execution (respect 6-min limit). */
function enrichAllTranslations(maxBatches) {
  const limit = maxBatches || 8;
  let last = { processed: 0, remaining: -1 };
  for (let i = 0; i < limit; i++) {
    last = enrichTranslationsBatch_(ENRICH_BATCH_SIZE);
    if (last.remaining === 0) break;
    Utilities.sleep(800);
  }
  Logger.log(JSON.stringify(last));
  return last;
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
    max_tokens: 4096,
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
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, 1, row.length).setValues([row]);
  }
}

// ===== API handlers =====

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

function handleGeneratePassage_(body) {
  const userId = body.user_id || 'naoya';
  const band = normalizeCefrBand_(body.cefr || 'B1');
  const index = loadChunksIndex_();
  const progressMap = loadUserProgressMap_(userId);
  const templates = getPassageTemplatesForBand_(band);
  const passages = templates.map((tpl) => enrichPassageTemplate_(tpl, index, band, progressMap));
  return { passages, cefr_band: band };
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
    cefr_band: band,
  };
}

// ===== Passage templates (Phase 2 — Phase 4 replaces with Claude generation) =====

function getPassageTemplatesForBand_(band) {
  const T = {
    A1A2: [
      {
        passage_id: 'ps_a1_01',
        cefr_band: 'A1A2',
        text_markup: 'I {{look at}} the menu and {{pick up}} a cup of tea. There are {{a lot of}} people here today, but the waiter is friendly.',
        ja_translation: 'メニューを見て、お茶を手に取った。今日はたくさん人がいるが、ウェイターは親切だ。',
        chunk_texts: ['look at', 'pick up', 'a lot of'],
      },
      {
        passage_id: 'ps_a1_02',
        cefr_band: 'A1A2',
        text_markup: 'We {{get up}} early and {{go out}} for a walk. I feel {{a little}} tired, but the air is nice.',
        ja_translation: '早く起きて、散歩に出かけた。少し疲れているが、空気は気持ちいい。',
        chunk_texts: ['get up', 'go out', 'a little'],
      },
      {
        passage_id: 'ps_a1_03',
        cefr_band: 'A1A2',
        text_markup: 'She {{turn on}} the light and {{sit down}} at the desk. She has {{a few}} books to read tonight.',
        ja_translation: '彼女は明かりをつけて、机に座った。今夜読む本が数冊ある。',
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
      ja_translation: row.ja_translation || '',
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
  const cache = CacheService.getScriptCache();
  const cached = cache.get('chunks_index_v1');
  if (cached) return JSON.parse(cached);

  const sheet = getSheet_(SHEET_NAMES.CHUNKS);
  if (sheet.getLastRow() < 2) return {};

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
      type: data[r][col.type],
      cefr: data[r][col.cefr],
      pos: data[r][col.pos],
      ja_translation: data[r][col.ja_translation],
      example_sentence: data[r][col.example_sentence],
    };
  }

  cache.put('chunks_index_v1', JSON.stringify(index), 300);
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
