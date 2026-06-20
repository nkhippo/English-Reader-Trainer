/**
 * Fallback ja glosses for passage template chunks when chunks_master
 * has not been enriched yet (empty ja_translation from GAS).
 */
export const CHUNK_JA_FALLBACKS = {
  'look at': '〜を見る',
  'pick up': '手に取る／拾う',
  'a lot of': 'たくさんの',
  'get up': '起きる',
  'go out': '外出する',
  'a little': '少し',
  'turn on': '〜をつける（電気など）',
  'sit down': '座る',
  'a few': 'いくつかの',
  'managed to': 'なんとか〜することができた',
  'picked up': '手に取る／拾い上げる',
  'turned out': '結果的に〜だった／判明した',
  'ran into': '偶然出会う／ばったり会う',
  'caught up': '近況を話す',
  'spoke up': '発言する／声を上げる',
  'laid out': '詳しく説明する／提示する',
  'come up with': '思いつく／考え出す',
  'carried out': '実施する／行う',
  'drew up': '作成する／まとめる',
  'bring about': 'もたらす／引き起こす',
  'set out': '〜し始める／取り組む',
  'bear out': '裏付ける',
  'shed light on': '〜を明らかにする',
  'points out': '指摘する',
  overlooked: '見落とす',
  'follow through': '最後まで実行する',
};

export function fallbackChunkJa(text) {
  if (!text) return '';
  return CHUNK_JA_FALLBACKS[String(text).toLowerCase().trim()] || '';
}
