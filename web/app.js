/* Müllerkinder-Planer - Frontend. Kein Build-Schritt, laeuft direkt auf GitHub Pages. */

const API = (window.PLANER_API || '').replace(/\/+$/, '');
const TOKEN_KEY = 'planer.token';
const HALVES = ['Vormittag', 'Nachmittag', 'Abend'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const LEVEL_LABEL = { 3: 'gut', 2: 'mittel', 1: 'schlecht', '-1': 'kann nicht' };
const POLL_MS = 60000;

const el = (id) => document.getElementById(id);

let state = null;
let tab = 'overview';
let brush = '3';
let weeks = 8;
let shortNames = new Map();

// ------------------------------------------------------------ Hilfsmittel

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Schwarze oder weisse Schrift - je nachdem, was auf der Farbe besser lesbar ist. */
function textOn(hex) {
  const value = parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.42 ? '#1c1b19' : '#ffffff';
}

/** Kuerzel: ein Buchstabe, bei Gleichstand so lang wie noetig. */
function shortNamesFor(users) {
  const short = new Map();
  for (const user of users) {
    const name = (user.name || '?').trim() || '?';
    let length = 1;
    const collides = (len) => users.some((other) =>
      other.id !== user.id &&
      (other.name || '').trim().slice(0, len).toLowerCase() === name.slice(0, len).toLowerCase());
    while (length < name.length && collides(length)) length++;
    short.set(user.id, name.slice(0, length));
  }
  return short;
}

function avatar(user) {
  const color = user.color || '#495057';
  const label = escapeHtml(user.name);
  return `<span class="avatar" style="background:${color};color:${textOn(color)}"` +
    ` title="${label}" aria-label="${label}">${escapeHtml(shortNames.get(user.id) || '?')}</span>`;
}

// ----------------------------------------------------------------- Datum

/** Lokales Datum als 'YYYY-MM-DD', ohne Umweg ueber UTC. */
const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Wochentag mit Montag = 0. */
const weekdayIndex = (d) => (d.getDay() + 6) % 7;

function mondayOf(d) {
  return addDays(d, -weekdayIndex(d));
}

/** ISO-Kalenderwoche. */
function isoWeek(d) {
  const thursday = addDays(d, 3 - weekdayIndex(d));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  return 1 + Math.round((thursday - addDays(firstThursday, 3 - weekdayIndex(firstThursday))) / 604800000);
}

const fmtShort = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;
const fmtLong = (d) => d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

// ---------------------------------------------------- Wer kann wann wie gut

const slotKey = (userId, day, half) => `${userId}|${day}|${half}`;
let slotIndex = new Map();

function indexSlots() {
  slotIndex = new Map(state.slots.map((s) => [slotKey(s.user_id, s.day, s.half), s]));
}

/**
 * Was gilt fuer eine Person in einer Tageshaelfte?
 * Reihenfolge: eigener Eintrag > Urlaub/ganze Tage > Blocker-Regel.
 * Hinweis-Regeln haengen sich als Notiz an, ausser die Haelfte ist blockiert.
 */
function effective(userId, day, half, weekday) {
  const slot = slotIndex.get(slotKey(userId, day, half));
  const notes = [];
  let level = null;
  let source = null;

  if (slot) {
    level = slot.level;
    source = 'eintrag';
    if (slot.note) notes.push(slot.note);
  } else {
    const block = state.blocks.find((b) => b.user_id === userId && b.from_day <= day && day <= b.to_day);
    if (block) {
      level = -1;
      source = 'urlaub';
      notes.push(block.label || 'ganzer Tag blockiert');
    } else {
      const rule = state.rules.find((r) => r.user_id === userId && r.kind === 'block' &&
        r.weekdays[weekday] === '1' && r.halves[half] === '1');
      if (rule) {
        level = -1;
        source = 'regel';
        notes.push(rule.text || 'Regel');
      }
    }
  }

  if (level !== -1) {
    for (const r of state.rules) {
      if (r.user_id === userId && r.kind === 'note' && r.weekdays[weekday] === '1' && r.halves[half] === '1') {
        notes.push(r.text);
      }
    }
  }
  return { level, source, notes };
}

/** Gesamtbild einer Tageshaelfte ueber alle Personen. */
function combined(day, half, weekday) {
  const people = state.users.map((u) => ({ user: u, ...effective(u.id, day, half, weekday) }));
  const levels = people.map((p) => p.level);
  let kind;
  if (levels.includes(-1)) kind = 'blocked';
  else if (levels.every((l) => l !== null)) kind = `all${Math.min(...levels)}`;
  else kind = 'partial';
  const sum = levels.reduce((a, l) => a + (l > 0 ? l : 0), 0);
  return { people, kind, sum, min: Math.min(...levels.map((l) => l ?? 0)) };
}

// ----------------------------------------------------------------- Server

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Fehler ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

let statusTimer = null;
function status(message, isError = false) {
  const box = el('status');
  box.textContent = message;
  box.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (message && !isError) statusTimer = setTimeout(() => { box.textContent = ''; }, 2500);
}

// ------------------------------------------------------------------ Raster

function renderGrid() {
  const today = isoDay(new Date());
  const start = mondayOf(new Date());
  const me = state.me.id;
  const parts = [];

  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    parts.push(`<div class="week">KW ${isoWeek(monday)} · ${fmtShort(monday)}–${fmtShort(addDays(monday, 6))}</div>`);

    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const day = isoDay(date);
      const past = day < today;
      const cells = HALVES.map((_, half) => {
        if (tab === 'edit') {
          const mine = effective(me, day, half, i);
          const cls = mine.level === null ? 'empty' : `l${mine.level < 0 ? 'x' : mine.level}`;
          const derived = mine.source === 'urlaub' || mine.source === 'regel';
          const note = mine.notes.length ? `<span class="note">${escapeHtml(mine.notes.join(' · '))}</span>` : '';
          return `<button type="button" class="cell ${cls}${derived ? ' derived' : ''}" data-day="${day}"` +
            ` data-half="${half}" aria-label="${HALVES[half]}: ${LEVEL_LABEL[mine.level] || 'leer'}">${note}</button>`;
        }
        const c = combined(day, half, i);
        const bars = c.people.map((p) =>
          `<i class="tile l${p.level === null ? 'n' : p.level < 0 ? 'x' : p.level}">` +
          `${escapeHtml(shortNames.get(p.user.id) || '?')}</i>`).join('');
        const hasNote = c.people.some((p) => p.notes.length && p.level !== -1);
        return `<button type="button" class="cell ${c.kind}" data-day="${day}" data-half="${half}"` +
          ` aria-label="${HALVES[half]}">${bars}${hasNote ? '<b class="dot" aria-hidden="true"></b>' : ''}</button>`;
      }).join('');
      parts.push(`<div class="day${past ? ' past' : ''}${day === today ? ' today' : ''}">` +
        `<button type="button" class="label" data-day="${day}">${WEEKDAYS[i]} <span>${fmtShort(date)}</span></button>` +
        `${cells}</div>`);
    }
  }
  el('grid').innerHTML = parts.join('');
  el('grid').classList.toggle('editing', tab === 'edit');
}

/** Die besten Tageshaelften, an denen alle koennen. */
function renderBest() {
  const today = new Date();
  const found = [];
  for (let n = 0; n < weeks * 7; n++) {
    const date = addDays(mondayOf(today), n);
    const day = isoDay(date);
    if (day < isoDay(today)) continue;
    for (let half = 0; half < 3; half++) {
      const c = combined(day, half, weekdayIndex(date));
      if (c.kind.startsWith('all')) found.push({ date, day, half, ...c });
    }
  }
  found.sort((a, b) => b.min - a.min || b.sum - a.sum || a.day.localeCompare(b.day) || a.half - b.half);

  if (!found.length) {
    el('best').innerHTML = '<p class="muted small">Noch keine Tageshälfte, an der alle eingetragen haben, dass sie können.</p>';
    return;
  }
  el('best').innerHTML = '<h2>Beste Termine</h2><div class="chips">' + found.slice(0, 6).map((f) =>
    `<button type="button" class="chip ${f.kind}" data-day="${f.day}" data-half="${f.half}">` +
    `${WEEKDAYS[weekdayIndex(f.date)]} ${fmtShort(f.date)} ${HALVES[f.half]}</button>`).join('') + '</div>';
}

function renderLists() {
  const byId = new Map(state.users.map((u) => [u.id, u]));
  const own = (item) => item.user_id === state.me.id;
  const del = (kind, item) => own(item) ? `<button type="button" class="link" data-del="${kind}" data-id="${item.id}">löschen</button>` : '';

  el('blocks').innerHTML = state.blocks.map((b) => {
    const range = b.from_day === b.to_day ? fmtShort(fromIso(b.from_day))
      : `${fmtShort(fromIso(b.from_day))}–${fmtShort(fromIso(b.to_day))}`;
    return `<li>${avatar(byId.get(b.user_id) || {})} <span>${range} ${escapeHtml(b.label || '')}</span>${del('blocks', b)}</li>`;
  }).join('') || '<li class="muted small">Nichts eingetragen.</li>';

  el('rules').innerHTML = state.rules.map((r) => {
    const days = describeMask(r.weekdays, WEEKDAYS);
    const halves = [...r.halves].map((on, i) => on === '1' ? HALVES[i] : null).filter(Boolean).join(', ');
    const kind = r.kind === 'block' ? 'kann nicht' : 'Hinweis';
    return `<li>${avatar(byId.get(r.user_id) || {})} <span>${days}, ${halves}: <em>${kind}</em>` +
      `${r.text ? ` – ${escapeHtml(r.text)}` : ''}</span>${del('rules', r)}</li>`;
  }).join('') || '<li class="muted small">Keine Regeln.</li>';
}

/** '1111100' → 'Mo–Fr', '1010000' → 'Mo, Mi'. */
function describeMask(mask, names) {
  const on = [...mask].map((c, i) => (c === '1' ? i : -1)).filter((i) => i >= 0);
  const isRun = on.length > 2 && on.every((v, i) => i === 0 || v === on[i - 1] + 1);
  return isRun ? `${names[on[0]]}–${names[on[on.length - 1]]}` : on.map((i) => names[i]).join(', ');
}

function renderProfile() {
  const me = state.me;
  const button = el('whoami');
  button.hidden = false;
  button.textContent = shortNames.get(me.id) || '?';
  button.style.background = me.color;
  button.style.color = textOn(me.color);
  button.title = `${me.name} – Profil`;

  const form = el('profile-form');
  if (!el('profile').open) {
    form.elements.name.value = me.name;
    form.dataset.color = me.color;
  }
  el('palette').innerHTML = state.palette.map((c) =>
    `<button type="button" class="swatch" style="background:${c}" data-color="${c}"` +
    ` aria-pressed="${c === form.dataset.color}" aria-label="Farbe ${c}"></button>`).join('');
  el('my-link').value = inviteLink(localStorage.getItem(TOKEN_KEY));
  el('admin').hidden = !me.is_admin;
}

const inviteLink = (token) => `${location.origin}${location.pathname}#t=${token}`;

async function renderAdmin() {
  if (!state.me.is_admin) return;
  const { users } = await api('/api/users');
  el('users').innerHTML = users.map((u) => `<li>${avatar(u)} ${escapeHtml(u.name)}` +
    (u.id === state.me.id ? ' <span class="muted small">(du)</span>' :
      ` <button type="button" class="link" data-remove="${u.id}">entfernen</button>`) +
    `<div class="copy"><input readonly value="${escapeHtml(inviteLink(u.token))}">` +
    `<button type="button" class="ghost" data-copy>Kopieren</button></div></li>`).join('');
}

function render() {
  shortNames = shortNamesFor(state.users);
  indexSlots();
  renderProfile();
  renderGrid();
  renderBest();
  renderLists();
}

async function refresh() {
  state = await api('/api/state');
  render();
}

// ------------------------------------------------------------------ Tabs

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  el('tab-overview').hidden = tab !== 'overview';
  el('tab-edit').hidden = tab !== 'edit';
  el('tab-rules').hidden = tab !== 'rules';
  el('grid-wrap').hidden = tab === 'rules';
  renderGrid();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

el('more').addEventListener('click', () => {
  weeks += 4;
  renderGrid();
  renderBest();
});

// --------------------------------------------------------------- Malen

for (const b of document.querySelectorAll('[data-brush]')) {
  b.addEventListener('click', () => {
    brush = b.dataset.brush;
    for (const o of document.querySelectorAll('[data-brush]')) o.setAttribute('aria-checked', String(o === b));
  });
}

/** Sammelt die Aenderungen eines Strichs und schickt sie beim Loslassen in einem Rutsch. */
let stroke = null;

function paint(cell) {
  const key = `${cell.dataset.day}|${cell.dataset.half}`;
  if (!stroke || stroke.done.has(key)) return;
  stroke.done.add(key);
  const day = cell.dataset.day;
  const half = Number(cell.dataset.half);
  const existing = slotIndex.get(slotKey(state.me.id, day, half));

  // Erste Zelle entscheidet: gleiche Stufe nochmal antippen loescht im ganzen Strich.
  if (stroke.level === undefined) {
    const value = brush === 'clear' ? null : Number(brush);
    stroke.level = existing && existing.level === value ? null : value;
  }
  stroke.changes.push({ day, half, level: stroke.level });

  state.slots = state.slots.filter((s) => !(s.user_id === state.me.id && s.day === day && s.half === half));
  if (stroke.level !== null) {
    state.slots.push({ user_id: state.me.id, day, half, level: stroke.level, note: existing?.note ?? null });
  }
  indexSlots();
  const mine = effective(state.me.id, day, half, weekdayIndex(fromIso(day)));
  cell.className = `cell ${mine.level === null ? 'empty' : `l${mine.level < 0 ? 'x' : mine.level}`}` +
    `${mine.source === 'urlaub' || mine.source === 'regel' ? ' derived' : ''}`;
}

async function finishStroke() {
  if (!stroke) return;
  const { changes } = stroke;
  stroke = null;
  if (!changes.length) return;
  try {
    await api('/api/slots', { method: 'PUT', body: { changes } });
    status('Gespeichert');
    renderGrid();
    renderBest();
  } catch (err) {
    status(err.message, true);
    refresh().catch(() => {});
  }
}

async function editNote(cell) {
  const day = cell.dataset.day;
  const half = Number(cell.dataset.half);
  const existing = slotIndex.get(slotKey(state.me.id, day, half));
  if (!existing) {
    status('Erst eine Stufe eintragen, dann eine Notiz dazu.', true);
    return;
  }
  const text = prompt(`Notiz für ${fmtLong(fromIso(day))}, ${HALVES[half]}`, existing.note || 'nur bis 21 Uhr');
  if (text === null) return;
  try {
    await api('/api/slots', { method: 'PUT', body: { changes: [{ day, half, level: existing.level, note: text }] } });
    existing.note = text.trim() || null;
    renderGrid();
    status('Notiz gespeichert');
  } catch (err) {
    status(err.message, true);
  }
}

const grid = el('grid');

/** Ab dieser Bewegung in Pixeln steht fest, ob der Finger scrollt oder malt. */
const TOUCH_SLOP = 10;

grid.addEventListener('pointerdown', (e) => {
  if (tab !== 'edit' || brush === 'note') return;
  const cell = e.target.closest('.cell');
  if (!cell) return;
  stroke = { changes: [], done: new Set(), level: undefined };
  if (e.pointerType === 'touch') {
    // Beim Aufsetzen noch nichts malen: das koennte der Anfang einer Scrollbewegung sein.
    stroke.pending = { cell, x: e.clientX, y: e.clientY };
    return;
  }
  e.preventDefault();
  paint(cell);
});

grid.addEventListener('pointermove', (e) => {
  if (!stroke) return;
  if (stroke.pending) {
    const dx = Math.abs(e.clientX - stroke.pending.x);
    const dy = Math.abs(e.clientY - stroke.pending.y);
    if (dy > TOUCH_SLOP && dy >= dx) {
      stroke = null; // senkrecht: Scrollen, kein Eintrag
      return;
    }
    if (dx <= TOUCH_SLOP) return;
    const { cell } = stroke.pending; // waagerecht: ab jetzt wird gemalt
    stroke.pending = null;
    paint(cell);
  }
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
  if (cell && grid.contains(cell)) paint(cell);
});

window.addEventListener('pointerup', () => {
  // Ohne nennenswerte Bewegung losgelassen: ein Tipp.
  if (stroke?.pending) {
    const { cell } = stroke.pending;
    stroke.pending = null;
    paint(cell);
  }
  finishStroke();
});
window.addEventListener('pointercancel', () => {
  // Der Browser hat die Geste als Scrollen uebernommen.
  if (stroke?.pending) stroke = null;
  finishStroke();
});

grid.addEventListener('click', (e) => {
  // Wochentag antippen setzt alle drei Haelften. Ueber click, weil der nach Scrollen nicht ausloest.
  const label = e.target.closest('.label');
  if (label && tab === 'edit' && brush !== 'note') {
    stroke = { changes: [], done: new Set(), level: undefined };
    for (const c of grid.querySelectorAll(`.cell[data-day="${label.dataset.day}"]`)) paint(c);
    finishStroke();
    return;
  }
  const cell = e.target.closest('.cell');
  if (!cell) return;
  if (tab === 'edit' && brush === 'note') editNote(cell);
  if (tab === 'overview') openDetail(cell.dataset.day, Number(cell.dataset.half));
});

el('best').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) openDetail(chip.dataset.day, Number(chip.dataset.half));
});

// --------------------------------------------------------------- Details

function openDetail(day, half) {
  const date = fromIso(day);
  const c = combined(day, half, weekdayIndex(date));
  el('detail-title').textContent = `${fmtLong(date)}, ${HALVES[half]}`;
  el('detail-list').innerHTML = c.people.map((p) => {
    const label = p.level === null ? '<span class="muted">noch nichts eingetragen</span>'
      : `<span class="pill l${p.level < 0 ? 'x' : p.level}">${LEVEL_LABEL[p.level]}</span>`;
    const notes = p.notes.length ? `<div class="small muted">${p.notes.map(escapeHtml).join(' · ')}</div>` : '';
    return `<li>${avatar(p.user)} <div><strong>${escapeHtml(p.user.name)}</strong> ${label}${notes}</div></li>`;
  }).join('');
  el('detail').showModal();
}

// ------------------------------------------------------ Urlaub und Regeln

el('rule-days').innerHTML = WEEKDAYS.map((d, i) =>
  `<label class="toggle"><input type="checkbox" value="${i}"${i < 5 ? ' checked' : ''}><span>${d}</span></label>`).join('');
el('rule-halves').innerHTML = HALVES.map((h, i) =>
  `<label class="toggle"><input type="checkbox" value="${i}"${i === 0 ? ' checked' : ''}><span>${h}</span></label>`).join('');

const maskOf = (container, length) => {
  const on = new Set([...container.querySelectorAll('input:checked')].map((i) => Number(i.value)));
  return Array.from({ length }, (_, i) => (on.has(i) ? '1' : '0')).join('');
};

el('block-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/blocks', {
      method: 'POST',
      body: { from_day: f.from_day.value, to_day: f.to_day.value || f.from_day.value, label: f.label.value },
    });
    e.target.reset();
    await refresh();
    status('Eingetragen');
  } catch (err) {
    status(err.message, true);
  }
});

el('rule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/rules', {
      method: 'POST',
      body: {
        weekdays: maskOf(el('rule-days'), 7),
        halves: maskOf(el('rule-halves'), 3),
        kind: f.kind.value,
        text: f.text.value,
      },
    });
    f.text.value = '';
    await refresh();
    status('Regel angelegt');
  } catch (err) {
    status(err.message, true);
  }
});

el('tab-rules').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Wirklich löschen?')) return;
  try {
    await api(`/api/${b.dataset.del}/${b.dataset.id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    status(err.message, true);
  }
});

// ------------------------------------------------------------------ Profil

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    // Klick auf den abgedunkelten Rand oder den Schliessknopf.
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

el('whoami').addEventListener('click', () => {
  el('profile').showModal();
  renderAdmin().catch((err) => status(err.message, true));
});

el('palette').addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-color]');
  if (!swatch) return;
  el('profile-form').dataset.color = swatch.dataset.color;
  for (const s of el('palette').children) s.setAttribute('aria-pressed', String(s === swatch));
});

el('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me', { method: 'PATCH', body: { name: e.target.elements.name.value, color: e.target.dataset.color } });
    el('profile').close();
    await refresh();
    status('Profil gespeichert');
  } catch (err) {
    status(err.message, true);
  }
});

function copyField(input) {
  input.select();
  navigator.clipboard?.writeText(input.value).then(() => status('Kopiert'), () => document.execCommand('copy'));
}
el('my-link-copy').addEventListener('click', () => copyField(el('my-link')));

el('users').addEventListener('click', async (e) => {
  if (e.target.closest('[data-copy]')) copyField(e.target.closest('.copy').querySelector('input'));
  const remove = e.target.closest('[data-remove]');
  if (remove && confirm('Person mit allen Einträgen entfernen?')) {
    try {
      await api(`/api/users/${remove.dataset.remove}`, { method: 'DELETE' });
      await Promise.all([renderAdmin(), refresh()]);
    } catch (err) {
      status(err.message, true);
    }
  }
});

el('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/users', { method: 'POST', body: { name: e.target.elements.name.value } });
    e.target.reset();
    await Promise.all([renderAdmin(), refresh()]);
  } catch (err) {
    status(err.message, true);
  }
});

// ----------------------------------------------------------------- Start

el('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const match = e.target.elements.link.value.match(/#t=([A-Za-z0-9_-]+)/) ||
    e.target.elements.link.value.trim().match(/^([A-Za-z0-9_-]{16,})$/);
  if (!match) {
    el('gate-error').textContent = 'Das sieht nicht nach einem Einladungslink aus.';
    el('gate-error').hidden = false;
    return;
  }
  localStorage.setItem(TOKEN_KEY, match[1]);
  start();
});

async function start() {
  const hash = location.hash.match(/#t=([A-Za-z0-9_-]+)/);
  if (hash) {
    localStorage.setItem(TOKEN_KEY, hash[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!localStorage.getItem(TOKEN_KEY)) {
    el('gate').hidden = false;
    return;
  }
  try {
    await refresh();
    el('gate').hidden = true;
    el('app').hidden = false;
  } catch (err) {
    if (err.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      el('gate-text').textContent = 'Dieser Link gilt nicht mehr. Frag nach einem neuen.';
    } else {
      el('gate-text').textContent = `Der Server ist gerade nicht erreichbar (${err.message}).`;
    }
    el('gate').hidden = false;
  }
}

// Regelmaessig nachladen, damit Eintraege der anderen auftauchen. Nie mitten im Malen.
setInterval(() => {
  if (state && !stroke && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) {
    refresh().catch(() => {});
  }
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (state && document.visibilityState === 'visible') refresh().catch(() => {});
});

start();
