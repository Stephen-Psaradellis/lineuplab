// LineupLab front end. Vanilla JS, no build step. All server text is inserted with
// textContent, never innerHTML.
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CEILINGS = { small: 0.6, medium: 0.8, large: 0.92 };
  const EXAMPLE = {
    venueName: 'The Lantern Room',
    location: 'Wicker Park, Chicago',
    capacity: 'small',
    age: '25_to_29',
    genres: 'dream pop, shoegaze, neo soul',
    pastActs: ['', '', ''],
    dates: 3,
  };

  const state = { result: null, lastBody: null, controller: null, steps: 0 };

  // ---------- element helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const f2 = (n) => (typeof n === 'number' ? n.toFixed(2) : 'n/a');

  // ---------- theme ----------
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {
      return null;
    }
    return null;
  }
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(store('lineuplab-theme'));
  function currentTheme() {
    const set = document.documentElement.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) {
      t = h('div', { class: 'toast', role: 'status' });
      document.body.append(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    } catch {
      const ta = h('textarea', { class: 'visually-hidden' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      toast(ok ? `${label} copied` : 'Copy failed: select the text manually');
    }
  }

  // ---------- form ----------
  const form = $('#venue-form');
  function readForm() {
    const fd = new FormData(form);
    return {
      venueName: String(fd.get('venueName') || '').trim(),
      location: String(fd.get('location') || '').trim(),
      capacity: String(fd.get('capacity') || ''),
      age: String(fd.get('age') || 'any'),
      genres: String(fd.get('genres') || '').trim(),
      pastActs: fd.getAll('pastAct').map((s) => String(s).trim()).filter(Boolean),
      dates: Number.parseInt(String(fd.get('dates') || '0'), 10),
    };
  }
  function fillForm(v) {
    form.venueName.value = v.venueName;
    form.location.value = v.location;
    form.querySelector(`input[name="capacity"][value="${v.capacity}"]`).checked = true;
    form.age.value = v.age;
    form.genres.value = v.genres;
    form.querySelectorAll('input[name="pastAct"]').forEach((el, i) => (el.value = v.pastActs[i] || ''));
    form.dates.value = v.dates;
    updateCapHint();
  }
  function updateCapHint() {
    const c = form.querySelector('input[name="capacity"]:checked');
    if (c) $('#cap-hint').textContent = `Qloo will only return acts with popularity up to ${CEILINGS[c.value].toFixed(2)}.`;
  }
  function validate(body) {
    const errs = [];
    form.location.removeAttribute('aria-invalid');
    form.dates.removeAttribute('aria-invalid');
    if (!body.location) {
      errs.push('Add the neighbourhood and city.');
      form.location.setAttribute('aria-invalid', 'true');
    }
    if (!(body.dates >= 1 && body.dates <= 6)) {
      errs.push('Dates to fill must be between 1 and 6.');
      form.dates.setAttribute('aria-invalid', 'true');
    }
    return errs;
  }
  function showFormErrors(errs) {
    const box = $('#form-errors');
    box.replaceChildren();
    if (!errs.length) {
      box.hidden = true;
      return;
    }
    box.append(h('ul', null, errs.map((e) => h('li', { text: e }))));
    box.hidden = false;
  }

  // ---------- trace ----------
  function laneLabel(l) {
    return { qloo: 'Qloo', llm: 'LLM', agent: 'Agent', baseline: 'No Qloo' }[l] || l;
  }
  function requestNode(req) {
    // Highlight the Qloo parameter names so the call reads at a glance.
    const node = h('div', { class: 'step-req' });
    const m = req.match(/^(GET \S+?)(\?(.*))?$/);
    if (!m) {
      node.textContent = req;
      return node;
    }
    node.append(m[1]);
    if (m[3]) {
      node.append('?');
      m[3].split('&').forEach((pair, i) => {
        const eq = pair.indexOf('=');
        if (i) node.append('&');
        node.append(h('b', { text: pair.slice(0, eq) }), pair.slice(eq));
      });
    }
    return node;
  }
  function addStep(ev) {
    state.steps++;
    const badge =
      ev.status === 'empty' ? h('span', { class: 'step-badge badge-empty', text: 'empty 200' }) :
      ev.status === 'fallback' ? h('span', { class: 'step-badge badge-fallback', text: 'fallback' }) :
      ev.status === 'error' ? h('span', { class: 'step-badge badge-error', text: 'error' }) :
      ev.status === 'cached' || ev.replay ? h('span', { class: 'step-badge badge-cached', text: ev.replay ? 'replayed' : 'cached' }) : null;
    const li = h(
      'li',
      { class: 'step' },
      h('span', { class: `lane lane-${ev.lane}`, text: laneLabel(ev.lane) }),
      h('div', { class: 'step-title' }, ev.title, badge, typeof ev.ms === 'number' && !ev.replay ? h('span', { class: 'step-ms', text: `${ev.ms} ms` }) : null),
      ev.detail ? h('div', { class: 'step-detail', text: ev.detail }) : null,
      ev.request ? requestNode(ev.request) : null,
      ev.stats && ev.stats.length ? h('div', { class: 'stats' }, ev.stats.map((s) => h('span', { class: 'stat' }, `${s.label} `, h('b', { text: s.value })))) : null,
    );
    const list = $('#trace-list');
    list.append(li);
    list.scrollTop = list.scrollHeight;
    setTraceMeta(true);
  }
  function setTraceMeta(running) {
    const meta = $('#trace-meta');
    meta.replaceChildren();
    if (running) meta.append(h('span', { class: 'live', text: `running, ${state.steps} steps` }));
    else meta.append(`${state.steps} steps`);
  }

  // ---------- render: shared bits ----------
  function meter(label, v) {
    const fill = h('span', { class: 'meter-fill' });
    if (typeof v === 'number') fill.style.setProperty('--v', String(Math.max(0, Math.min(1, v))));
    return h('div', { class: 'meter' }, h('span', { text: label }), h('span', { class: 'meter-track', 'aria-hidden': 'true' }, fill), h('span', { class: 'meter-val', text: f2(v) }));
  }
  function fitChip(fit, pop, band) {
    if (!fit || fit.ok === null) return h('span', { class: 'chip', text: 'No Qloo popularity' });
    return h('span', { class: `chip ${fit.ok ? 'chip-good' : 'chip-bad'}` }, `Popularity `, h('b', { text: f2(pop) }), ` ${band}, ${fit.ok ? 'fits your room' : 'too big'}`);
  }
  function actBlock(a, role) {
    return h(
      'div',
      { class: `act ${role}` },
      h('div', { class: 'role', text: role === 'headliner' ? 'Headliner' : 'Support' }),
      h('div', { class: 'act-name', text: a.name }),
      meter('Qloo affinity', a.affinity),
      h(
        'div',
        { class: 'chips' },
        fitChip(a.fit, a.popularity, a.popularity_band),
        a.local.inert ? null : h('span', { class: `chip ${a.local.label === 'Broad appeal' ? '' : 'chip-accent'}`, title: a.local.text }, h('b', { text: a.local.label }), a.local.general == null ? ` #${a.local.here}` : ` #${a.local.here} vs #${a.local.general}`),
        a.trend.inert ? null : h('span', { class: 'chip', title: a.trend.text }, 'Trend ', h('b', { text: a.trend.label })),
      ),
      a.tags && a.tags.length ? h('p', { class: 'tags', text: a.tags.join(' / ') }) : null,
      h('p', { class: 'why', text: a.why }),
      a.why !== a.evidence ? h('p', { class: 'evidence', text: `Qloo evidence: ${a.evidence}` }) : null,
    );
  }

  function renderLineup(r) {
    const box = $('#lineup');
    box.replaceChildren();
    for (const d of r.lineup) {
      box.append(
        h(
          'article',
          { class: 'date-card', 'aria-label': `Date ${d.date}` },
          h('div', { class: 'date-head' }, h('span', { class: 'date-label', text: `Date ${d.date}` }), d.theme ? h('span', { class: 'date-theme', text: d.theme }) : null),
          h('div', { class: 'acts-grid' }, actBlock(d.headliner, 'headliner'), actBlock(d.support, 'support')),
          h(
            'div',
            { class: 'blurb' },
            h('div', { class: 'blurb-label' }, h('span', { text: 'Announcement' }), h('button', { type: 'button', class: 'link-btn', onclick: () => copyText(d.blurb, `Date ${d.date} announcement`), 'aria-label': `Copy the announcement for date ${d.date}` }, 'Copy')),
            h('p', { text: d.blurb }),
          ),
        ),
      );
    }
  }

  function partnerItem(p) {
    return h(
      'li',
      { class: 'partner' },
      h('div', { class: 'partner-top' }, h('span', { class: 'partner-name', text: p.name }), p.category ? h('span', { class: 'partner-cat', text: p.category }) : null),
      meter('Fan affinity', p.affinity),
      h('p', { class: 'partner-idea', text: p.idea }),
    );
  }
  function renderPartners(r) {
    for (const [id, list, empty] of [
      ['#places', r.copromote.places, 'Qloo found no nearby places for this audience.'],
      ['#brands', r.copromote.brands, 'Qloo found no brand affinities for this audience.'],
    ]) {
      const ul = $(id);
      ul.replaceChildren(...(list.length ? list.map(partnerItem) : [h('li', { class: 'none', text: empty })]));
    }
  }

  function baseCheck(side, ceiling) {
    const q = side.qloo || {};
    if (!q.found) return h('span', { class: 'chip', text: 'Not found in Qloo' });
    const ok = q.fit && q.fit.ok;
    return h('span', { class: `chip ${ok ? 'chip-good' : 'chip-bad'}` }, 'Qloo popularity ', h('b', { text: f2(q.popularity) }), ok ? ` ${q.band}, fits` : ` ${q.band}, ${q.fit && q.fit.ratio ? q.fit.ratio.toFixed(1) + 'x' : 'over'} your ${f2(ceiling)} ceiling`);
  }
  function renderBaseline(r) {
    const box = $('#baseline');
    box.replaceChildren();
    const b = r.baseline;
    const ceiling = r.venue.capacity.popMax;
    if (!b || !b.lineup.length) {
      box.append(h('p', { class: 'none', text: 'The model returned no usable lineup on its own.' }));
      return;
    }
    $('#base-note').textContent = `The same model, given the same brief, with no Qloo data. Each name was then looked up in Qloo: ${b.too_big} of ${b.checked} sit above this room's popularity ceiling of ${f2(ceiling)}.`;
    for (const d of b.lineup) {
      const act = (s, role) =>
        h('div', { class: `act ${role}` }, h('div', { class: 'role', text: role === 'headliner' ? 'Headliner' : 'Support' }), h('div', { class: 'act-name', text: s.name }), h('div', { class: 'chips' }, baseCheck(s, ceiling)), s.reason ? h('p', { class: 'why', text: s.reason }) : null);
      box.append(h('article', { class: 'date-card base', 'aria-label': `Without Qloo, date ${d.date}` }, h('div', { class: 'date-head' }, h('span', { class: 'date-label', text: `Date ${d.date}` }), h('span', { class: 'date-theme', text: 'LLM alone' })), h('div', { class: 'acts-grid' }, act(d.headliner, 'headliner'), act(d.support, 'support'))));
    }
  }

  function renderSide(r) {
    const box = $('#side');
    box.replaceChildren();
    const ceiling = r.venue.capacity.popMax;
    const fits = r.lineup.flatMap((d) => [d.headliner, d.support]).filter((a) => a.fit && a.fit.ok).length;
    const total = r.lineup.length * 2;
    const b = r.baseline;
    box.append(
      h('p', { class: 'side-verdict' }, `With Qloo, ${fits} of ${total} acts fit your room (capacity ${r.venue.capacity.label.toLowerCase()}) and each one is ranked for ${r.venue.location}. `, b ? `Without Qloo, ${b.too_big} of ${b.checked} suggestions are bigger than the room can hold, and none is tied to the neighbourhood.` : 'The without-Qloo run did not return.'),
      h('div', { class: 'side-head', 'aria-hidden': 'true' }, h('span', { text: 'Date' }), h('span', { text: 'With Qloo' }), h('span', { text: 'Without Qloo' })),
    );
    r.lineup.forEach((d, i) => {
      const bd = b && b.lineup[i];
      const qCell = h('div', { class: 'side-cell', 'data-label': 'With Qloo' }, h('div', { class: 'nm', text: `${d.headliner.name} + ${d.support.name}` }), h('div', { class: 'sm', text: `affinity ${f2(d.headliner.affinity)} / ${f2(d.support.affinity)}; popularity ${f2(d.headliner.popularity)} / ${f2(d.support.popularity)} (ceiling ${f2(ceiling)}); ${d.headliner.local.label.toLowerCase()}` }));
      const bCell = bd
        ? h('div', { class: 'side-cell', 'data-label': 'Without Qloo' }, h('div', { class: 'nm', text: `${bd.headliner.name} + ${bd.support.name}` }), h('div', { class: 'sm' }, bd.headliner.qloo && bd.headliner.qloo.found ? `popularity ${f2(bd.headliner.qloo.popularity)} / ${bd.support.qloo && bd.support.qloo.found ? f2(bd.support.qloo.popularity) : 'n/a'}; no local signal` : 'not found in Qloo; no local signal'))
        : h('div', { class: 'side-cell', 'data-label': 'Without Qloo' }, h('div', { class: 'sm', text: 'No suggestion' }));
      box.append(h('div', { class: 'side-row' }, h('div', { class: 'side-date', text: `Date ${d.date}` }), qCell, bCell));
    });
  }

  function renderSummary(r) {
    const bits = [`${r.lineup.length} date${r.lineup.length === 1 ? '' : 's'}`, `${r.stats.candidates} Qloo candidates`, `${r.stats.qloo_calls} Qloo calls`, `ceiling ${f2(r.venue.capacity.popMax)}`, `location "${r.plan.location_query}"`];
    if (r.plan.tags.length) bits.push(`tags: ${r.plan.tags.map((t) => t.name).join(', ')}`);
    if (r.meta && r.meta.cached) bits.push('cached result');
    $('#summary').textContent = bits.join(' · ');
  }

  function render(r) {
    state.result = r;
    renderSummary(r);
    renderLineup(r);
    renderPartners(r);
    renderBaseline(r);
    renderSide(r);
    $('#output').hidden = false;
  }

  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = tabs.length - 1;
      if (j !== null) {
        e.preventDefault();
        selectTab(tabs[j], true);
      }
    });
  });

  // ---------- export ----------
  function briefText(r) {
    const L = [];
    L.push(`LINEUPLAB BOOKING BRIEF: ${r.venue.name}`);
    L.push(`${r.venue.location} · ${r.venue.capacity.label} capacity · crowd ${r.venue.age.label} · Qloo popularity ceiling ${f2(r.venue.capacity.popMax)}`);
    L.push('');
    for (const d of r.lineup) {
      L.push(`DATE ${d.date}${d.theme ? `: ${d.theme}` : ''}`);
      for (const [role, a] of [['Headliner', d.headliner], ['Support', d.support]]) {
        L.push(`  ${role}: ${a.name} (affinity ${f2(a.affinity)}, popularity ${f2(a.popularity)} ${a.popularity_band}, ${a.local.inert ? 'no location comparison' : a.local.label.toLowerCase()}${a.trend.inert ? '' : `, trend ${a.trend.label.toLowerCase()}`})`);
        L.push(`    Why: ${a.why}`);
      }
      L.push(`  Announcement: ${d.blurb}`);
      L.push('');
    }
    L.push('CO-PROMOTE WITH');
    for (const p of [...r.copromote.places, ...r.copromote.brands]) L.push(`  - ${p.name}${p.category ? ` (${p.category})` : ''}, fan affinity ${f2(p.affinity)}: ${p.idea}`);
    L.push('');
    L.push(`Generated by LineupLab from Qloo taste data${r.meta && r.meta.mode && r.meta.mode.demo ? ' (DEMO DATA: synthetic, fictional names)' : ''}.`);
    return L.join('\n');
  }
  function buildPrintBrief(r) {
    const b = $('#brief');
    b.replaceChildren();
    const demo = r.meta && r.meta.mode && r.meta.mode.demo;
    b.append(
      h('h1', { text: `Booking brief: ${r.venue.name}` }),
      h('p', { class: 'b-sub', text: `${r.venue.location} · ${r.venue.capacity.label} capacity · crowd ${r.venue.age.label} · Qloo popularity ceiling ${f2(r.venue.capacity.popMax)}${demo ? ' · DEMO DATA (synthetic names)' : ''}` }),
      h('h2', { text: 'Lineup' }),
    );
    const rows = r.lineup.flatMap((d) => [
      h('tr', null, h('td', { text: `Date ${d.date}` }), h('td', null, h('strong', { text: d.headliner.name }), h('br'), d.headliner.why), h('td', { text: `${f2(d.headliner.affinity)} / ${f2(d.headliner.popularity)}` }), h('td', null, h('strong', { text: d.support.name }), h('br'), d.support.why), h('td', { text: `${f2(d.support.affinity)} / ${f2(d.support.popularity)}` })),
    ]);
    b.append(h('table', null, h('thead', null, h('tr', null, ['Date', 'Headliner', 'Aff / Pop', 'Support', 'Aff / Pop'].map((t) => h('th', { text: t })))), h('tbody', null, rows)));
    b.append(
      h('div', { class: 'b-cols' },
        h('div', null, h('h2', { text: 'Co-promote: places' }), h('ul', null, r.copromote.places.map((p) => h('li', null, h('strong', { text: p.name }), ` (${p.category || 'place'}, ${f2(p.affinity)}): ${p.idea}`)))),
        h('div', null, h('h2', { text: 'Co-promote: brands' }), h('ul', null, r.copromote.brands.map((p) => h('li', null, h('strong', { text: p.name }), ` (${p.category || 'brand'}, ${f2(p.affinity)}): ${p.idea}`))))),
      h('h2', { text: 'Announcements' }),
      r.lineup.map((d) => h('p', { class: 'b-blurb' }, h('strong', { text: `Date ${d.date}: ` }), d.blurb)),
      h('p', { class: 'b-foot', text: `Generated ${new Date().toLocaleDateString()} by LineupLab from Qloo taste data (affinity = how strongly this audience over-indexes; popularity = Qloo percentile, kept under the room's ceiling).` }),
    );
  }

  // ---------- run ----------
  function setBusy(busy) {
    const btn = $('#build-btn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Building...' : 'Build my lineup';
    $('#skeleton').hidden = !busy;
  }
  function showError(msg) {
    $('#error-text').textContent = msg;
    $('#error-box').hidden = false;
  }
  function setDemo(mode) {
    if (!mode) return;
    const banner = $('#demo-banner');
    banner.hidden = !mode.demo;
    if (mode.demo) {
      const parts = [];
      if (mode.qloo === 'mock') parts.push('no Qloo key, so every artist, place and brand is synthetic and fictional');
      if (mode.llm === 'mock') parts.push('Workers AI is not connected, so the language steps use a deterministic demo model');
      $('#demo-detail').textContent = `Running without live services: ${parts.join('; ')}.`;
    }
  }

  async function run(body) {
    if (state.controller) state.controller.abort();
    const ctrl = new AbortController();
    state.controller = ctrl;
    state.lastBody = body;
    state.steps = 0;
    $('#empty-state').hidden = true;
    $('#error-box').hidden = true;
    $('#output').hidden = true;
    $('#trace').hidden = false;
    $('#trace').open = true;
    $('#trace-list').replaceChildren();
    $('#status').textContent = 'The agent is working. Each step appears below as it happens.';
    setBusy(true);
    let gotResult = false;
    try {
      const res = await fetch('/api/lineup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('text/event-stream')) {
        let msg = `The server answered HTTP ${res.status}.`;
        try {
          const j = await res.json();
          if (j && j.errors) msg = j.errors.join(' ');
        } catch {
          /* keep default */
        }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let payload = {};
          try {
            payload = data ? JSON.parse(data) : {};
          } catch {
            continue;
          }
          if (event === 'meta') setDemo(payload.mode);
          else if (event === 'step') addStep(payload);
          else if (event === 'result') {
            gotResult = true;
            if (payload.meta) setDemo(payload.meta.mode);
            render(payload);
            selectTab(tabs[0]);
            $('#status').textContent = `Lineup ready: ${payload.lineup.length} date${payload.lineup.length === 1 ? '' : 's'}.`;
          } else if (event === 'error') throw new Error(payload.message || 'The agent stopped.');
        }
      }
      if (!gotResult) throw new Error('The connection closed before the lineup was ready.');
      $('#trace').open = window.matchMedia('(min-width: 901px)').matches;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      $('#status').textContent = '';
      showError(err && err.message ? err.message : 'Network error.');
    } finally {
      if (state.controller === ctrl) {
        setBusy(false);
        setTraceMeta(false);
        state.controller = null;
      }
    }
  }

  // ---------- wire up ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = readForm();
    const errs = validate(body);
    showFormErrors(errs);
    if (errs.length) {
      (form.querySelector('[aria-invalid="true"]') || form.location).focus();
      return;
    }
    run(body);
    if (window.matchMedia('(max-width: 900px)').matches) $('#trace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  form.querySelectorAll('input[name="capacity"]').forEach((r) => r.addEventListener('change', updateCapHint));
  form.querySelectorAll('.step-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const n = Math.max(1, Math.min(6, (Number.parseInt(form.dates.value, 10) || 1) + Number(b.dataset.step)));
      form.dates.value = n;
    }),
  );
  $('#example-btn').addEventListener('click', () => {
    fillForm(EXAMPLE);
    showFormErrors([]);
    $('#build-btn').focus();
  });
  $('#retry-btn').addEventListener('click', () => state.lastBody && run(state.lastBody));
  $('#copy-btn').addEventListener('click', () => state.result && copyText(briefText(state.result), 'Booking brief'));
  $('#print-btn').addEventListener('click', () => {
    if (!state.result) return;
    buildPrintBrief(state.result);
    window.print();
  });
  $('#theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store('lineuplab-theme', next);
  });

  updateCapHint();
  fetch('/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j && setDemo(j.mode))
    .catch(() => {});
})();
