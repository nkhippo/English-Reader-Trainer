/** Normalize GAS stats/session fields for header progress bars. */
export function normalizeBandStats(res = {}) {
  const graduated = res.graduated ?? 0;
  const reviewing = res.reviewing ?? 0;
  const newCount = res.new ?? 0;

  let total = res.total ?? 0;
  if (!total) {
    total = newCount + reviewing + graduated;
  }

  let encountered = res.encountered;
  if (encountered == null) {
    encountered = Math.max(0, total - newCount);
  }

  return { reviewing, graduated, total, encountered };
}
