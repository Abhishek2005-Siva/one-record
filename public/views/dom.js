// Tiny helpers shared by the views. Data only ever reaches the page through
// textContent / setAttribute, never innerHTML, so a hostile record can't inject markup.

/** el('li', { class: 'alert' }, 'text', otherNode) */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2025-03-12' -> '12 Mar 2025'. Returns null for anything that isn't a date. Avoids Date so timezones can't shift the day. */
export function fmtDate(iso, { year = true } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month}${year ? ` ${m[1]}` : ''}`;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86400000);
}

export const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
