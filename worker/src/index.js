/**
 * Müllerkinder-Planer - API auf Cloudflare Workers mit D1.
 *
 * Auth wie beim Freundeskalender: jede Person hat ein unbegrenzt gueltiges Token
 * aus ihrem Einladungslink, das als "Authorization: Bearer <token>" mitkommt.
 * Jede Person darf nur die eigenen Eintraege aendern, aber alle sehen alles.
 */

const PALETTE = [
  '#1971c2', '#2f9e44', '#e8590c', '#6741d9', '#0c8599', '#c2255c',
  '#f08c00', '#099268', '#9c36b5', '#e03131', '#846358', '#495057',
];
const COLOR_RE = /^#[0-9a-f]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = [-1, 1, 2, 3];
const MAX_CHANGES = 400; // eine Malbewegung ueber mehrere Wochen bleibt deutlich darunter

// ---------------------------------------------------------------- Hilfsmittel

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (status, message) => {
  throw new HttpError(status, message);
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

/** Zufälliges, URL-sicheres Token (24 Byte Entropie). */
function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    bad(400, 'Ungültiger JSON-Body');
  }
}

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function optionalText(value, max, label) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) bad(400, `${label} ist zu lang (max. ${max} Zeichen)`);
  return text;
}

function validDay(value, label) {
  const day = String(value ?? '');
  if (!DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    bad(400, `${label} ist kein gültiges Datum (YYYY-MM-DD)`);
  }
  return day;
}

/** '0'/'1'-Maske fester Laenge, mindestens ein Eintrag gesetzt. */
function validMask(value, length, label) {
  const mask = String(value ?? '');
  if (!new RegExp(`^[01]{${length}}$`).test(mask) || !mask.includes('1')) {
    bad(400, `${label}: mindestens eins auswählen`);
  }
  return mask;
}

// ------------------------------------------------------------------- Routing

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (path === '/') return new Response('Müllerkinder-Planer-API. Siehe /api/health', { status: 200 });

    try {
      if (!path.startsWith('/api/')) bad(404, 'Unbekannter Pfad');
      return await handleApi(request, url, path, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, env);
      console.error(err);
      return json({ error: 'Interner Fehler' }, 500, env);
    }
  },
};

async function handleApi(request, url, path, env) {
  if (path === '/api/health') return json({ ok: true }, 200, env);

  const me = await authenticate(request, env);
  const method = request.method;

  if (path === '/api/state' && method === 'GET') return getState(me, env);
  if (path === '/api/me' && method === 'PATCH') return updateMe(request, me, env);
  if (path === '/api/slots' && method === 'PUT') return putSlots(request, me, env);

  if (path === '/api/blocks' && method === 'POST') return createBlock(request, me, env);
  const blockMatch = path.match(/^\/api\/blocks\/(\d+)$/);
  if (blockMatch && method === 'DELETE') return deleteOwn('blocks', Number(blockMatch[1]), me, env);

  if (path === '/api/rules' && method === 'POST') return createRule(request, me, env);
  const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
  if (ruleMatch && method === 'DELETE') return deleteOwn('rules', Number(ruleMatch[1]), me, env);

  // --- Admin ---
  if (path === '/api/users' && method === 'GET') return listUsers(me, env);
  if (path === '/api/users' && method === 'POST') return createUser(request, me, env);
  const userMatch = path.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === 'DELETE') return deleteUser(Number(userMatch[1]), me, env);
  const resetMatch = path.match(/^\/api\/users\/(\d+)\/token$/);
  if (resetMatch && method === 'POST') return resetUserToken(Number(resetMatch[1]), me, env);

  bad(404, 'Unbekannter Pfad');
}

// ----------------------------------------------------------------------- Auth

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) bad(401, 'Kein Token mitgeschickt');

  const user = await env.DB.prepare('SELECT id, name, color, is_admin FROM users WHERE token = ?')
    .bind(token)
    .first();
  if (!user) bad(401, 'Token ungültig – bitte einen neuen Einladungslink anfordern');
  return user;
}

const requireAdmin = (me) => {
  if (!me.is_admin) bad(403, 'Nur für Admins');
};

// ----------------------------------------------------------------- Lesezugriff

async function getState(me, env) {
  // Vergangenes interessiert kaum; eine Woche zurueck reicht fuer die laufende Woche.
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const [users, slots, blocks, rules] = await Promise.all([
    env.DB.prepare('SELECT id, name, color FROM users ORDER BY id').all(),
    env.DB.prepare('SELECT user_id, day, half, level, note FROM slots WHERE day >= ?').bind(since).all(),
    env.DB.prepare('SELECT id, user_id, from_day, to_day, label FROM blocks WHERE to_day >= ? ORDER BY from_day')
      .bind(since)
      .all(),
    env.DB.prepare('SELECT id, user_id, weekdays, halves, kind, text FROM rules ORDER BY id').all(),
  ]);

  return json(
    {
      me: { id: me.id, name: me.name, color: me.color, is_admin: !!me.is_admin },
      palette: PALETTE,
      users: users.results,
      slots: slots.results,
      blocks: blocks.results,
      rules: rules.results,
    },
    200,
    env
  );
}

// ------------------------------------------------------------ Eigenes Profil

async function updateMe(request, me, env) {
  const body = await readJson(request);
  const updates = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) bad(400, 'Der Name darf nicht leer sein');
    if (name.length > 60) bad(400, 'Name ist zu lang (max. 60 Zeichen)');
    updates.name = name;
  }
  if (body.color !== undefined) {
    const color = String(body.color).toLowerCase();
    if (!COLOR_RE.test(color)) bad(400, 'Die Farbe muss ein Hex-Wert wie #1971c2 sein');
    updates.color = color;
  }

  const fields = Object.keys(updates); // feste Whitelist, daher unbedenklich im SQL
  if (!fields.length) bad(400, 'Es wurde nichts zum Ändern mitgeschickt');

  await env.DB.prepare(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .bind(...fields.map((f) => updates[f]), me.id)
    .run();
  return json({ ok: true, ...updates }, 200, env);
}

// ------------------------------------------------------------ Tageshaelften

/**
 * Mehrere eigene Tageshaelften auf einmal setzen.
 * Body: { changes: [{ day, half, level, note? }] }
 * level null loescht den Eintrag. Fehlt `note`, bleibt eine vorhandene Notiz erhalten.
 */
async function putSlots(request, me, env) {
  const body = await readJson(request);
  const changes = Array.isArray(body.changes) ? body.changes : bad(400, 'changes fehlt');
  if (!changes.length) return json({ ok: true }, 200, env);
  if (changes.length > MAX_CHANGES) bad(400, `Zu viele Änderungen auf einmal (max. ${MAX_CHANGES})`);

  const now = nowUtc();
  const statements = changes.map((c) => {
    const day = validDay(c.day, 'Tag');
    const half = Number(c.half);
    if (![0, 1, 2].includes(half)) bad(400, 'Tageshälfte muss 0, 1 oder 2 sein');

    if (c.level === null) {
      return env.DB.prepare('DELETE FROM slots WHERE user_id = ? AND day = ? AND half = ?').bind(me.id, day, half);
    }
    const level = Number(c.level);
    if (!LEVELS.includes(level)) bad(400, `Stufe muss einer von ${LEVELS.join(', ')} sein`);

    if (!('note' in c)) {
      return env.DB.prepare(
        'INSERT INTO slots (user_id, day, half, level, updated_at) VALUES (?, ?, ?, ?, ?)' +
          ' ON CONFLICT(user_id, day, half) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at'
      ).bind(me.id, day, half, level, now);
    }
    const note = optionalText(c.note, 120, 'Notiz');
    return env.DB.prepare(
      'INSERT INTO slots (user_id, day, half, level, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(user_id, day, half) DO UPDATE SET level = excluded.level, note = excluded.note,' +
        ' updated_at = excluded.updated_at'
    ).bind(me.id, day, half, level, note, now);
  });

  await env.DB.batch(statements);
  return json({ ok: true }, 200, env);
}

// ------------------------------------------------------- Blocker und Regeln

async function createBlock(request, me, env) {
  const body = await readJson(request);
  const from = validDay(body.from_day, 'Von');
  const to = validDay(body.to_day || body.from_day, 'Bis');
  if (to < from) bad(400, 'Das Ende liegt vor dem Anfang');
  const label = optionalText(body.label, 80, 'Bezeichnung');

  const row = await env.DB.prepare(
    'INSERT INTO blocks (user_id, from_day, to_day, label) VALUES (?, ?, ?, ?) RETURNING id'
  )
    .bind(me.id, from, to, label)
    .first();
  return json({ id: row.id }, 201, env);
}

async function createRule(request, me, env) {
  const body = await readJson(request);
  const weekdays = validMask(body.weekdays, 7, 'Wochentage');
  const halves = validMask(body.halves, 3, 'Tageshälften');
  const kind = String(body.kind ?? '');
  if (!['block', 'note'].includes(kind)) bad(400, 'Art muss block oder note sein');
  const text = optionalText(body.text, 80, 'Text');
  if (kind === 'note' && !text) bad(400, 'Ein Hinweis braucht einen Text');

  const row = await env.DB.prepare(
    'INSERT INTO rules (user_id, weekdays, halves, kind, text) VALUES (?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(me.id, weekdays, halves, kind, text)
    .first();
  return json({ id: row.id }, 201, env);
}

/** Loescht einen eigenen Blocker oder eine eigene Regel. `table` kommt nur aus dem Routing. */
async function deleteOwn(table, id, me, env) {
  const result = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, me.id).run();
  if (!result.meta.changes) bad(404, 'Nicht gefunden oder nicht deins');
  return json({ ok: true }, 200, env);
}

// --------------------------------------------------------------------- Admin

async function listUsers(me, env) {
  requireAdmin(me);
  const { results } = await env.DB.prepare('SELECT id, name, color, token, is_admin FROM users ORDER BY id').all();
  return json({ users: results.map((u) => ({ ...u, is_admin: !!u.is_admin })) }, 200, env);
}

async function createUser(request, me, env) {
  requireAdmin(me);
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name) bad(400, 'Name fehlt');
  if (name.length > 60) bad(400, 'Name ist zu lang (max. 60 Zeichen)');

  const token = randomToken();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const color = PALETTE[n % PALETTE.length];
  const row = await env.DB.prepare(
    'INSERT INTO users (name, color, token, is_admin) VALUES (?, ?, ?, ?) RETURNING id'
  )
    .bind(name, color, token, body.is_admin ? 1 : 0)
    .first();
  return json({ id: row.id, name, color, token }, 201, env);
}

async function deleteUser(id, me, env) {
  requireAdmin(me);
  if (id === me.id) bad(400, 'Du kannst dich nicht selbst löschen');
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) bad(404, 'Person nicht gefunden');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM slots WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM blocks WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM rules WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true }, 200, env);
}

/** Neues Token, falls ein Einladungslink in falsche Haende geraten ist. Der alte wird ungueltig. */
async function resetUserToken(id, me, env) {
  requireAdmin(me);
  const token = randomToken();
  const row = await env.DB.prepare('UPDATE users SET token = ? WHERE id = ? RETURNING id, name')
    .bind(token, id)
    .first();
  if (!row) bad(404, 'Person nicht gefunden');
  return json({ id: row.id, name: row.name, token }, 200, env);
}
