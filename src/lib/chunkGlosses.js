/**
 * Fallback glosses when chunks_master translations are not yet enriched.
 */
const CHUNK_GLOSSES = {
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
  overlooked: { ja: '見落とした', en: 'failed to notice' },
  'follow through': { ja: '最後まで実行する', en: 'to complete what was started' },
  'stayed up': { ja: '夜更かしする', en: 'to remain awake late into the night' },
  'made up': { ja: '決心する（make up one\'s mind）', en: 'to decide firmly (make up one\'s mind)' },
  'took it well': { ja: 'うまく受け止めた／冷静に受け止めた', en: 'to accept something calmly' },
  'worth the risk': { ja: 'リスクに見合う価値がある', en: 'worth the possible danger or cost' },
};

function glossKey(text) {
  return String(text || '').toLowerCase().trim();
}

export function resolveChunkJa(text, ja) {
  const trimmed = String(ja || '').trim();
  if (trimmed) return trimmed;
  return CHUNK_GLOSSES[glossKey(text)]?.ja || '';
}

export function resolveChunkEn(text, en) {
  const trimmed = String(en || '').trim();
  if (trimmed) return trimmed;
  return CHUNK_GLOSSES[glossKey(text)]?.en || '';
}

export function resolveChunkGloss(text, { ja = '', en = '' } = {}, locale = 'ja') {
  const resolvedJa = resolveChunkJa(text, ja);
  const resolvedEn = resolveChunkEn(text, en);
  return locale === 'en' ? resolvedEn : resolvedJa;
}
