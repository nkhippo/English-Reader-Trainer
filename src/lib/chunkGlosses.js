/**
 * Fallback glosses when chunks_master translations are not yet enriched.
 * Prefer API values from en_translation / ja_translation once batches complete.
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
  'wake up': { ja: '目を覚ます／起きる', en: 'to stop sleeping; to get out of bed' },
  'look for': { ja: '探す', en: 'to try to find something' },
  'come back': { ja: '戻ってくる', en: 'to return to a place' },
  'turn off': { ja: '消す／オフにする', en: 'to switch off (a light, device, etc.)' },
  'stand up': { ja: '立ち上がる', en: 'to rise to a standing position' },
  'hurry up': { ja: '急ぐ', en: 'to move or act more quickly' },
  'wait for': { ja: '待つ', en: 'to stay until someone or something arrives' },
  'go back': { ja: '戻る', en: 'to return to a place you were before' },
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
  'figure out': { ja: '理解する／解明する', en: 'to understand or solve something' },
  'work out': { ja: '解決する／うまくいく', en: 'to solve; to succeed or go well' },
  'end up': { ja: '結局〜になる', en: 'to finally be in a particular state or place' },
  'give up': { ja: '諦める', en: 'to stop trying' },
  'keep up': { ja: 'ついていく／維持する', en: 'to continue at the same rate' },
  'deal with': { ja: '対処する', en: 'to handle or manage a problem' },
  'look forward to': { ja: '〜を楽しみにする', en: 'to feel excited about something in the future' },
  'find out': { ja: '調べてわかる', en: 'to discover information' },
  'turn out': { ja: '結果的に〜になる', en: 'to prove to be; to happen in a particular way' },
  'take part in': { ja: '参加する', en: 'to join in an activity' },
  'pay attention': { ja: '注意する／集中する', en: 'to listen or watch carefully' },
  'call for': { ja: '必要とする／求める', en: 'to require or demand' },
  'account for': { ja: '説明する／占める', en: 'to explain; to form a particular amount of' },
  'rule out': { ja: '除外する', en: 'to decide that something is not possible' },
  'stem from': { ja: '〜に由来する', en: 'to originate from' },
  'give rise to': { ja: '引き起こす', en: 'to cause something to happen' },
  'hinge on': { ja: '〜次第である', en: 'to depend entirely on' },
  'take for granted': { ja: '当たり前だと思う', en: 'to assume something without thinking' },
  'fall short of': { ja: '〜に届かない', en: 'to fail to reach a level or standard' },
  'live up to': { ja: '〜に応える／期待に沿う', en: 'to be as good as expected' },
  'boil down to': { ja: '要するに〜だ', en: 'to be explained or summarized as' },
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
