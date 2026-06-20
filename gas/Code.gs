/**
 * English Reader Trainer — Backend (Phase 1)
 *
 * Setup:
 *   1. Create a new Apps Script project (or add to existing).
 *   2. Paste this file as Code.gs.
 *   3. Run setupSheets() once to create the 4 sheet tabs with headers.
 *   4. Script Properties:
 *        SPREADSHEET_ID — Google Sheets ID
 *        DRIVE_ROOT_ID  — Drive folder ID for /EnglishReaderTrainer/
 *   5. Deploy as Web app, "Execute as: Me", "Who has access: Anyone".
 *   6. Copy the /exec URL into the app's Settings (⚙) or VITE_GAS_URL.
 *
 * Request body (JSON, sent as text/plain to avoid CORS preflight):
 *   { action: 'due_chunks'|'generate_passage'|'log_encounter'|'update_progress'|'stats'|'tts', ... }
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
  return jsonResponse({ status: 'ok', service: 'english-reader-trainer', phase: 1 });
}

// ===== Setup =====

function setupSheets() {
  const ss = getSpreadsheet_();
  Object.entries(SHEET_HEADERS).forEach(([name, headers]) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
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

// ===== Phase 1: Mock endpoints =====

function handleDueChunks_(body) {
  const cefr = body.cefr || 'B1';
  const limit = body.limit || 20;

  // Phase 1: return mock data. Phase 3 will query user_progress.
  const mockDue = [
    { chunk_id: 'ch_managed_to', text: 'managed to', cefr: 'B1', srs_stage: 3, last_encountered_at: '2026-06-18T10:00:00Z', status: 'reviewing' },
    { chunk_id: 'ch_picked_up', text: 'picked up', cefr: 'A2', srs_stage: 4, last_encountered_at: '2026-06-17T10:00:00Z', status: 'reviewing' },
    { chunk_id: 'ch_turned_out', text: 'turned out', cefr: 'B1', srs_stage: 1, last_encountered_at: '2026-06-19T10:00:00Z', status: 'learning' },
  ];
  const mockNew = [
    { chunk_id: 'ch_caught_up', text: 'caught up', cefr: cefr, status: 'new' },
    { chunk_id: 'ch_spoke_up', text: 'spoke up', cefr: cefr, status: 'new' },
  ];

  return {
    due_chunks: mockDue.slice(0, limit),
    new_chunks: mockNew,
  };
}

function handleGeneratePassage_(body) {
  // Phase 1: return mock passages. Phase 4 will call Claude.
  return {
    passages: getMockPassages_(),
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
    Utilities.getUuid(),
    userId,
    chunkId,
    passageId,
    now,
    signal,
    timeOnPageMs,
  ]);

  if (rows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  }

  return { ok: true, logged: rows.length };
}

function handleUpdateProgress_(body) {
  // Phase 3: SRS stage updates. Phase 1 stub.
  return { ok: true, phase: 1, message: 'update_progress not yet implemented' };
}

function handleStats_(body) {
  // Phase 6: stats dashboard. Phase 1 stub.
  return {
    reviewing: 147,
    graduated: 23,
    by_cefr: {},
  };
}

// ===== Mock passage data (matches frontend mockPassages.js) =====

function getMockPassages_() {
  return [
    {
      passage_id: 'ps_001',
      cefr: 'B1',
      text: "The restaurant was packed when we arrived, but the host managed to find us a table near the window. We sat down and picked up the menus, scanning the appetizers first. I ordered without much thought. It turned out to be the best meal I'd had all week.",
      ja_translation: '私たちが到着したとき、レストランは混んでいたが、店主はなんとか窓際の席を見つけてくれた。座って、メニューを手に取り、まず前菜から目を通した。あまり考えずに注文した。結果的に、その週で食べた中で最高の食事だった。',
      target_chunks: [
        { chunk_id: 'managed_to', text: 'managed to', char_start: 70, char_end: 80, ja: 'なんとか〜することができた', cefr: 'B1', encounters: 4, stage: 3, example: 'She managed to finish the report by midnight.' },
        { chunk_id: 'picked_up', text: 'picked up', char_start: 120, char_end: 129, ja: '手に取る／拾い上げる', cefr: 'A2', encounters: 6, stage: 4, example: 'He picked up the phone on the first ring.' },
        { chunk_id: 'turned_out', text: 'turned out', char_start: 210, char_end: 220, ja: '結果的に〜だった／判明した', cefr: 'B1', encounters: 2, stage: 1, example: 'It turned out that he was right all along.' },
      ],
    },
    {
      passage_id: 'ps_002',
      cefr: 'B1',
      text: "I had been planning the trip for months, but on the morning of departure, I ran into an old friend at the airport. We hadn't seen each other in years. We caught up over coffee, and I almost missed my flight. Some things, I suppose, are worth the risk.",
      ja_translation: '数か月もかけて旅の計画を立ててきたが、出発の朝、空港で旧友にばったり会った。何年も会っていなかった。コーヒーを飲みながら近況を交わし、もう少しでフライトに乗り遅れるところだった。そういうものなのだろう、リスクに見合う価値のあるものというのは。',
      target_chunks: [
        { chunk_id: 'ran_into', text: 'ran into', ja: '偶然出会う／ばったり会う', cefr: 'B1', encounters: 3, stage: 2, example: 'I ran into my professor at the bookstore yesterday.' },
        { chunk_id: 'caught_up', text: 'caught up', ja: '近況を語り合う', cefr: 'B1', encounters: 1, stage: 0, example: "Let's catch up over lunch sometime." },
        { chunk_id: 'worth_the_risk', text: 'worth the risk', ja: 'リスクに見合う価値がある', cefr: 'B2', encounters: 1, stage: 0, example: 'Starting your own business is worth the risk.' },
      ],
    },
    {
      passage_id: 'ps_003',
      cefr: 'B1',
      text: 'When the meeting started, no one spoke up at first. The room felt heavy with hesitation. Finally, Sarah cleared her throat and laid out her proposal. By the end, everyone agreed it was the most reasonable plan we had come up with in months.',
      ja_translation: '会議が始まったとき、最初は誰も発言しなかった。部屋には躊躇いが重く漂っていた。やがてサラが咳払いをして、彼女の提案を整然と並べた。終わる頃には、ここ数か月で思いついた最も理にかなった計画だと全員が同意していた。',
      target_chunks: [
        { chunk_id: 'spoke_up', text: 'spoke up', ja: '発言する／声を上げる', cefr: 'B1', encounters: 5, stage: 4, example: 'No one spoke up against the decision.' },
        { chunk_id: 'laid_out', text: 'laid out', ja: '整然と提示する／詳しく説明する', cefr: 'B2', encounters: 2, stage: 1, example: 'The document lays out the new policy clearly.' },
        { chunk_id: 'come_up_with', text: 'come up with', ja: '思いつく／考え出す', cefr: 'B1', encounters: 7, stage: 5, example: 'She came up with a brilliant idea on the way home.' },
      ],
    },
  ];
}

// ===== Helpers =====

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
