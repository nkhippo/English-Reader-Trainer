/**
 * Fallback Japanese glosses when chunks_master.ja_translation is not yet enriched.
 * Used only when the API returns an empty ja_translation.
 */
const CHUNK_JA_FALLBACKS = {
  'look at': '見る',
  'pick up': '手に取る',
  'a lot of': 'たくさんの',
  'get up': '起きる',
  'go out': '外出する',
  'a little': '少し',
  'turn on': 'つける／オンにする',
  'sit down': '座る',
  'a few': 'いくつかの／少しの',
  'managed to': 'なんとか〜することができた',
  'picked up': '手に取る／拾い上げる',
  'turned out': '結果的に〜だった／判明した',
  'ran into': '偶然出会う／ばったり会う',
  'caught up': '近況を語り合う',
  'spoke up': '発言する／声を上げる',
  'laid out': '整然と提示する／詳しく説明する',
  'come up with': '思いつく／考え出す',
  'carried out': '実行する／行う',
  'drew up': '作成する／まとめる',
  'bring about': 'もたらす／引き起こす',
  'set out': '〜しようと取り組む',
  'bear out': '裏付ける',
  'shed light on': '明らかにする',
  'points out': '指摘する',
  overlooked: '見落とした',
  'follow through': '最後まで実行する',
};

export function resolveChunkJa(text, ja) {
  const trimmed = String(ja || '').trim();
  if (trimmed) return trimmed;
  const key = String(text || '').toLowerCase().trim();
  return CHUNK_JA_FALLBACKS[key] || '';
}
