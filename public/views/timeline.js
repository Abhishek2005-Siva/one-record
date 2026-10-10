// renderTimeline(container, events): everything on one page, newest first,
// grouped by year, filterable by type. `events` use the shape from src/fhir.js.

import { el, fmtDate, daysBetween, plural } from './dom.js';

const KINDS = {
  visit: { filter: 'Visits', one: 'Visit' },
  discharge: { filter: 'Hospital stays', one: 'Hospital stay' },
  lab: { filter: 'Tests', one: 'Test' },
  scan: { filter: 'Scans', one: 'Scan' },
  medicine: { filter: 'Medicines', one: 'Medicine' },
  vaccine: { filter: 'Vaccines', one: 'Vaccine' },
  document: { filter: 'Documents', one: 'Document' },
};

const PAGE = 40; // keep the first paint light on a low-end phone

const FLAGS = { H: 'High', HH: 'Very high', L: 'Low', LL: 'Very low', A: 'Abnormal', AA: 'Very abnormal' };

const STATUS_NOTE = { completed: 'Course finished', stopped: 'Stopped', cancelled: 'Cancelled', 'on-hold': 'On hold' };

// newest first; records with no date go last instead of vanishing
const newestFirst = (a, b) => (a.date && b.date ? (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) : a.date ? -1 : b.date ? 1 : 0);

export function renderTimeline(container, events) {
  const all = [...(events ?? [])].sort(newestFirst);

  if (all.length === 0) {
    container.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', null, 'No records yet.'),
        'Visits, tests, scans and medicines will appear here, in date order, as hospitals and labs add them.'),
    );
    return;
  }

  let filter = 'all';
  let limit = PAGE;

  const present = Object.keys(KINDS).filter((k) => all.some((e) => e.kind === k));
  const filterBar = el('div', { class: 'filters', role: 'group', 'aria-label': 'Show only' });
  const count = el('p', { class: 'meta count', 'aria-live': 'polite' });
  const list = el('div');

  const options = [['all', 'All'], ...present.map((k) => [k, KINDS[k].filter])];
  const buttons = options.map(([key, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': key === filter }, label);
    b.addEventListener('click', () => {
      filter = key;
      limit = PAGE;
      draw();
    });
    return [key, b];
  });
  filterBar.append(...buttons.map(([, b]) => b));

  function draw() {
    for (const [key, b] of buttons) b.setAttribute('aria-pressed', String(key === filter));

    const shown = filter === 'all' ? all : all.filter((e) => e.kind === filter);
    const visible = shown.slice(0, limit);

    const nodes = [];
    let group = null;
    let ul = null;
    for (const ev of visible) {
      const heading = ev.date ? ev.date.slice(0, 4) : 'Date not recorded';
      if (heading !== group) {
        group = heading;
        nodes.push(el('h2', { class: 'year' }, heading));
        ul = el('ul', { class: 'rows' });
        nodes.push(ul);
      }
      ul.append(row(ev));
    }

    if (shown.length === 0) {
      nodes.push(el('div', { class: 'empty' }, `Nothing in ${KINDS[filter].filter.toLowerCase()} yet.`));
    }
    if (visible.length < shown.length) {
      const more = el('button', { type: 'button', class: 'btn quiet more' }, `Show ${Math.min(PAGE, shown.length - visible.length)} earlier`);
      more.addEventListener('click', () => {
        limit += PAGE;
        draw();
        // the button that was pressed is gone, so put focus on the first newly shown row
        const next = list.querySelectorAll('ul.rows .title')[visible.length];
        next?.setAttribute('tabindex', '-1');
        next?.focus();
      });
      nodes.push(more);
    }

    count.textContent = visible.length < shown.length ? `Showing ${visible.length} of ${shown.length}` : plural(shown.length, 'record');
    list.replaceChildren(...nodes);
  }

  container.replaceChildren(filterBar, count, list);
  draw();
}

function row(ev) {
  const body = [
    el('div', { class: 'kind' }, KINDS[ev.kind]?.one ?? 'Record'),
    el('div', { class: 'title' }, ev.title || 'Untitled record'),
  ];

  const who = [ev.place, ev.clinician, ev.byHospital ? 'Added by hospital' : null].filter(Boolean).join(' · ');
  if (who) body.push(el('div', { class: 'meta' }, who));

  if (ev.kind === 'medicine' && ev.times > 1) {
    // repeat prescriptions arrive collapsed: dose in `dose`, the count and first date in `times` / `since`
    if (ev.dose) body.push(el('div', { class: 'meta' }, ev.dose));
    body.push(el('div', { class: 'meta' }, `Prescribed ${plural(ev.times, 'time')}${fmtDate(ev.since) ? ` since ${fmtDate(ev.since)}` : ''}`));
  } else if (ev.detail) {
    body.push(el('div', { class: 'meta' }, ev.detail));
  }
  if (ev.kind === 'medicine' && STATUS_NOTE[ev.status]) body.push(el('div', { class: 'meta' }, STATUS_NOTE[ev.status]));
  if (ev.kind === 'lab' && ev.results?.length) body.push(results(ev.results));
  if (ev.kind === 'discharge' && ev.stay) body.push(...stay(ev.stay));

  return el('li', null, el('div', { class: 'date' }, fmtDate(ev.date, { year: false }) ?? ''), el('div', { class: 'body' }, body));
}

function stay({ from, to, given }) {
  const out = [];
  if (from && to) {
    const days = daysBetween(from, to);
    const span = from === to ? 'Same-day stay' : `In hospital ${fmtDate(from, { year: false })} to ${fmtDate(to)} (${plural(days, 'day')})`;
    out.push(el('div', { class: 'meta' }, span));
  }
  if (given?.length) {
    out.push(el('details', null, el('summary', null, `Given in hospital (${given.length})`), el('ul', { class: 'results' }, given.map((g) => el('li', null, g)))));
  }
  return out;
}

function results(list) {
  const line = (r) => {
    const value = r.value == null ? '' : `${r.value}${r.unit ? ` ${r.unit.replace(/[{}]/g, '')}` : ''}`;
    const flag = FLAGS[r.flag];
    return el('li', { class: flag ? 'abnormal' : null },
      el('span', null, r.name ?? 'Result'),
      el('span', { class: 'value' }, value, flag ? el('span', { class: 'flag' }, ` ${flag}`) : null));
  };
  if (list.length === 1) return el('ul', { class: 'results' }, line(list[0]));
  return el('details', null, el('summary', null, plural(list.length, 'result')), el('ul', { class: 'results' }, list.map(line)));
}
