// renderMedicines(container, { active, past }): one reconciled list.
// Each group is one ingredient; if several brands or sources hit the same ingredient
// the server sets `flag`, and we show it as a single calm line above the entries.

import { el, fmtDate, upperFirst, plural } from './dom.js';

export function renderMedicines(container, { active = [], past = [] } = {}) {
  if (active.length === 0 && past.length === 0) {
    container.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', null, 'No medicines on file.'),
        'When a hospital or pharmacy adds a prescription, it will show up here.'),
    );
    return;
  }

  const nodes = [];

  nodes.push(el('h2', { class: 'year' }, active.length ? `Taking now (${active.length})` : 'Taking now'));
  if (active.length) {
    nodes.push(el('ul', { class: 'rows stacked' }, active.map((g) => group(g, true))));
  } else {
    nodes.push(el('div', { class: 'empty' }, 'Nothing current. Earlier medicines are listed below.'));
  }

  if (past.length) {
    // the server sends past medicines as plain entries; accept grouped ones too
    nodes.push(el('details', { class: 'earlier' },
      el('summary', null, `Earlier medicines (${past.length})`),
      el('ul', { class: 'rows stacked' }, past.map((p) => group(p.entries ? p : { entries: [p] }, false)))));
  }

  container.replaceChildren(...nodes);
}

function group(g, current) {
  const entries = g.entries ?? [];
  const body = g.ingredient ? [el('div', { class: 'title' }, upperFirst(g.ingredient))] : [];

  if (g.flag?.text) {
    // same ingredient under two brands is the one that can hurt someone, so it is the only one in red
    body.push(el('p', { class: `notice${g.flag.type === 'same-ingredient' ? ' warn' : ''}`, role: 'note' }, g.flag.text));
  }

  body.push(el('ul', { class: 'entries' }, entries.map((e) => entry(e, current))));
  return el('li', { class: entries.length === 1 && !g.flag ? 'solo' : null }, body);
}

function entry(e, current) {
  const dose = [e.dose, e.frequency].filter(Boolean).join(', ');
  const bits = [];
  if (e.times > 1 && e.since) bits.push(`Prescribed ${plural(e.times, 'time')} since ${fmtDate(e.since)}`);
  else if (e.date) bits.push(`${current ? 'Prescribed' : 'Last prescribed'} ${fmtDate(e.date)}`);
  if (e.times > 1 && e.date) bits.push(`latest ${fmtDate(e.date)}`);
  if (e.place) bits.push(e.place);

  return el('li', null,
    el('div', null, el('span', { class: 'name' }, upperFirst(e.name) || 'Medicine'), dose ? el('span', { class: 'meta' }, ` · ${dose}`) : null),
    bits.length ? el('div', { class: 'meta' }, bits.join(' · ')) : null);
}
