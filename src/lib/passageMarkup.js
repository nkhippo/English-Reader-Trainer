/** Strip {{chunk}} markers from passage markup. */
export function stripPassageMarkup(markup) {
  return String(markup || '').replace(/\{\{([^}]+)\}\}/g, '$1');
}

/**
 * Locate chunk text in passage. Mirrors GAS findChunkSpanInPassage_.
 * @returns {{start:number,end:number,matched:string}|null}
 */
export function findChunkSpanInPassage(text, chunkText) {
  const expected = String(chunkText || '').trim();
  if (!expected) return null;
  const haystack = String(text);
  const lower = haystack.toLowerCase();
  const needle = expected.toLowerCase();
  let idx = lower.indexOf(needle);
  if (idx >= 0) {
    return {
      start: idx,
      end: idx + expected.length,
      matched: haystack.slice(idx, idx + expected.length),
    };
  }

  const words = expected.split(/\s+/);
  if (words.length >= 2) {
    const tail = words.slice(1).join(' ');
    if (tail.length >= 5) {
      const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b\\w+\\s+${esc}\\b`, 'i');
      const m = haystack.match(re);
      if (m && m.index != null) {
        return { start: m.index, end: m.index + m[0].length, matched: m[0] };
      }
    }
  }
  return null;
}

function buildTextMarkupFromPositions(text, spans) {
  const sorted = spans
    .filter((c) => c.char_end > c.char_start)
    .slice()
    .sort((a, b) => b.char_start - a.char_start);
  let markup = text;
  sorted.forEach((c) => {
    const { char_start: start, char_end: end } = c;
    const slice = markup.slice(start, end);
    if (!slice) return;
    markup = `${markup.slice(0, start)}{{${slice}}}${markup.slice(end)}`;
  });
  return markup;
}

/** Rebuild {{markers}} for every target chunk when markup is missing or incomplete. */
export function ensureTextMarkup(textOrMarkup, chunks = []) {
  const raw = String(textOrMarkup || '');
  const plain = /\{\{[^}]+\}\}/.test(raw) ? stripPassageMarkup(raw) : raw;
  if (!plain || !chunks.length) return raw;

  const spans = [];
  chunks.forEach((chunk) => {
    const span = findChunkSpanInPassage(plain, chunk.text);
    if (!span) return;
    spans.push({
      char_start: span.start,
      char_end: span.end,
      chunk_id: chunk.id || chunk.chunk_id,
    });
  });

  if (spans.length < chunks.length) return raw;
  return buildTextMarkupFromPositions(plain, spans);
}

const INFLECTION_SUFFIX_RE = /^('s|s|ed|ing|es|d|er|est)\b/i;

function findChunkForMarker(markerText, chunks) {
  const inner = String(markerText || '').trim();
  if (!inner) return null;
  const lower = inner.toLowerCase();

  let chunk = chunks.find((c) => c.text.toLowerCase() === lower);
  if (chunk) return { chunk, displayText: chunk.text };

  chunk = chunks.find((c) => {
    const ct = c.text.toLowerCase();
    return ct.startsWith(lower) && ct.length > inner.length;
  });
  if (chunk) return { chunk, displayText: chunk.text };

  chunk = chunks.find((c) => {
    const ct = c.text.toLowerCase();
    return lower.startsWith(ct) && inner.length > ct.length;
  });
  if (chunk) return { chunk, displayText: inner };

  return null;
}

/**
 * Parse passage markup into render segments. Handles inflected forms like {{wheel}}s.
 */
export function parsePassageText(text, chunks) {
  const parts = String(text || '').split(/(\{\{[^}]+\}\})/);
  const segments = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (part.startsWith('{{') && part.endsWith('}}')) {
      const inner = part.slice(2, -2);
      let match = findChunkForMarker(inner, chunks);
      let displayText = match?.displayText ?? inner;
      let suffix = '';

      if (!match && parts[i + 1]) {
        const suffixMatch = parts[i + 1].match(INFLECTION_SUFFIX_RE);
        if (suffixMatch) {
          const combined = inner + suffixMatch[0];
          match = findChunkForMarker(combined, chunks);
          if (match) {
            suffix = suffixMatch[0];
            displayText = match.displayText;
            parts[i + 1] = parts[i + 1].slice(suffix.length);
          }
        }
      }

      if (match) {
        segments.push({
          type: 'chunk',
          key: `${match.chunk.id}-${i}`,
          chunk: match.chunk,
          displayText: suffix ? displayText : (displayText || match.chunk.text),
        });
      } else {
        segments.push({ type: 'text', key: `text-${i}`, content: inner });
      }
      continue;
    }

    segments.push({ type: 'text', key: `text-${i}`, content: part });
  }

  return segments;
}
