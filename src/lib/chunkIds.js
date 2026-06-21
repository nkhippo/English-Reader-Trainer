/** Collect unique chunk ids from normalized passage objects. */
export function chunkIdsFromPassages(passages = []) {
  const ids = new Set();
  passages.forEach((p) => {
    (p.chunks || []).forEach((c) => {
      if (c?.id) ids.add(c.id);
    });
  });
  return [...ids];
}
