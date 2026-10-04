// Wydatki – backend (Cloudflare Worker + D1).
// • POST /            odczyt paragonu przez Gemini (bez konta, limitowany)
// • /api/*            konta, synchronizacja (pieniądze prywatne), dom (wspólny Plan), push, AI
// Sekret GEMINI_API_KEY tylko jako secret workera. Klucze VAPID generuje sam worker i trzyma w D1.
const ALLOWED_ORIGINS = ['https://tazo88.github.io'];
const MAX_BODY = 6 * 1024 * 1024;        // paragon (zdjęcia base64)
const MAX_API_BODY = 3 * 1024 * 1024;    // pozostałe API
const MAX_IMAGES = 4;
const SESSION_DAYS = 180;
const DEFAULT_CATS = ['Jedzenie','Zakupy/dom','Transport/paliwo','Rachunki','Zdrowie','Dzieci','Rozrywka','Ubrania','Inne'];
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 znaki, bez 0/O/1/I
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
// limity: [ile, okno w sekundach]
const LIM = {
  register: [5, 3600], recover: [10, 3600], redeem: [10, 600], mkcode: [10, 3600],
  invite: [10, 3600], joinU: [10, 3600], joinIP: [20, 3600],
  receiptMin: [6, 60], receiptDay: [60, 86400], parseMin: [15, 60], parseDay: [200, 86400],
  whereMin: [6, 60], whereDay: [50, 86400], geminiGlobal: [3000, 86400], push: [20, 3600],
};

// ---------- utils ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const code = n => [...rnd(n)].map(x => ALPHA[x & 31]).join('');
const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const newId = p => p + hex(rnd(12));
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
const now = () => Date.now();
class HttpErr extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (s, c) => { throw new HttpErr(s, c); };

function cors(origin) {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(origin ? cors(origin) : {}) } });

// ---------- D1 schema ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, recovery_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS login_codes(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS households(id TEXT PRIMARY KEY, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY, household_id TEXT NOT NULL, joined INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS members_h ON members(household_id)`,
  `CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, household_id TEXT NOT NULL, created_by TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entries(user_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, srv INTEGER NOT NULL, PRIMARY KEY(user_id, id))`,
  `CREATE INDEX IF NOT EXISTS entries_srv ON entries(user_id, srv)`,
  `CREATE TABLE IF NOT EXISTS user_kv(user_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT, updated INTEGER NOT NULL, srv INTEGER NOT NULL, PRIMARY KEY(user_id, k))`,
  `CREATE TABLE IF NOT EXISTS plan_items(household_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, notes TEXT, due TEXT, done INTEGER NOT NULL DEFAULT 0, remind_at INTEGER, reminded INTEGER NOT NULL DEFAULT 0, created_by TEXT, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, srv INTEGER NOT NULL, PRIMARY KEY(household_id, id))`,
  `CREATE INDEX IF NOT EXISTS plan_srv ON plan_items(household_id, srv)`,
  `CREATE INDEX IF NOT EXISTS plan_remind ON plan_items(reminded, remind_at)`,
  `CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT NOT NULL, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, tz TEXT, created INTEGER NOT NULL, PRIMARY KEY(endpoint, user_id))`,
  `CREATE INDEX IF NOT EXISTS push_user ON push_subs(user_id)`,
  `CREATE TABLE IF NOT EXISTS rate(k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];
let schemaReady;
const ensureSchema = env => schemaReady || (schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; }));

// ---------- rate limit (globalny, w D1) ----------
async function hit(env, key, [limit, win]) {
  const t = now(), reset = t + win * 1000;
  const r = await env.DB.prepare(`INSERT INTO rate(k,n,reset) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET
    n = CASE WHEN rate.reset < ?3 THEN 1 ELSE rate.n + 1 END, reset = CASE WHEN rate.reset < ?3 THEN ?2 ELSE rate.reset END RETURNING n`).bind(key, reset, t).first();
  if (r.n > limit) fail(429, 'rate_limited');
}

// ---------- auth ----------
async function newSession(env, userId) {
  const token = b64u(rnd(32));
  await env.DB.prepare('INSERT INTO sessions(hash,user_id,expires,created) VALUES(?,?,?,?)').bind(await sha(token), userId, now() + SESSION_DAYS * 864e5, now()).run();
  return token;
}
async function auth(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') || '');
  if (!m) fail(401, 'unauthorized');
  const u = await env.DB.prepare(`SELECT s.user_id id, s.expires, u.name, m.household_id hid FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN members m ON m.user_id = s.user_id WHERE s.hash = ?`).bind(await sha(m[1])).first();
  if (!u || u.expires < now()) fail(401, 'unauthorized');
  if (!u.hid) { // dom zawsze istnieje (naprawa)
    u.hid = newId('h_');
    await env.DB.batch([env.DB.prepare('INSERT INTO households(id,created) VALUES(?,?)').bind(u.hid, now()),
      env.DB.prepare('INSERT OR REPLACE INTO members(user_id,household_id,joined) VALUES(?,?,?)').bind(u.id, u.hid, now())]);
  }
  return u;
}
const ip = req => req.headers.get('CF-Connecting-IP') || 'x';

async function register(env, req, body) {
  await hit(env, 'reg:' + ip(req), LIM.register);
  const name = str(body.name, 40).trim();
  if (!name) fail(400, 'name');
  const id = newId('u_'), hid = newId('h_');
  const recovery = code(24).match(/.{4}/g).join('-');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users(id,name,recovery_hash,created) VALUES(?,?,?,?)').bind(id, name, await sha('rk:' + normCode(recovery)), now()),
    env.DB.prepare('INSERT INTO households(id,created) VALUES(?,?)').bind(hid, now()),
    env.DB.prepare('INSERT INTO members(user_id,household_id,joined) VALUES(?,?,?)').bind(id, hid, now()),
  ]);
  return { token: await newSession(env, id), recovery, user: { id, name } };
}
async function recover(env, req, body) {
  await hit(env, 'rec:' + ip(req), LIM.recover);
  const k = normCode(body.key);
  if (k.length !== 24) fail(401, 'bad_key');
  const u = await env.DB.prepare('SELECT id,name FROM users WHERE recovery_hash=?').bind(await sha('rk:' + k)).first();
  if (!u) fail(401, 'bad_key');
  return { token: await newSession(env, u.id), user: u };
}
async function makeLoginCode(env, u) {
  await hit(env, 'mk:' + u.id, LIM.mkcode);
  const c = code(10), exp = now() + 10 * 60e3;
  await env.DB.batch([env.DB.prepare('DELETE FROM login_codes WHERE user_id=?').bind(u.id),
    env.DB.prepare('INSERT INTO login_codes(hash,user_id,expires) VALUES(?,?,?)').bind(await sha('lc:' + c), u.id, exp)]);
  return { code: c.slice(0, 5) + '-' + c.slice(5), expires: exp };
}
async function redeem(env, req, body) {
  await hit(env, 'red:' + ip(req), LIM.redeem);
  const c = normCode(body.code);
  if (c.length !== 10) fail(401, 'bad_code');
  // jednorazowy: usuwamy przy odczycie (atomowo)
  const r = await env.DB.prepare('DELETE FROM login_codes WHERE hash=? RETURNING user_id, expires').bind(await sha('lc:' + c)).first();
  if (!r || r.expires < now()) fail(401, 'bad_code');
  const u = await env.DB.prepare('SELECT id,name FROM users WHERE id=?').bind(r.user_id).first();
  if (!u) fail(401, 'bad_code');
  return { token: await newSession(env, u.id), user: u };
}
async function me(env, u) {
  const mem = await env.DB.prepare('SELECT u.id, u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.household_id=? ORDER BY m.joined').bind(u.hid).all();
  return { user: { id: u.id, name: u.name }, household: { members: mem.results } };
}

// ---------- dom (para) ----------
async function invite(env, u) {
  await hit(env, 'inv:' + u.id, LIM.invite);
  const c = code(8), exp = now() + 15 * 60e3;
  await env.DB.batch([env.DB.prepare('DELETE FROM invites WHERE created_by=? OR expires<?').bind(u.id, now()),
    env.DB.prepare('INSERT INTO invites(hash,household_id,created_by,expires) VALUES(?,?,?,?)').bind(await sha('inv:' + c), u.hid, u.id, exp)]);
  return { code: c.slice(0, 4) + '-' + c.slice(4), expires: exp };
}
async function moveTo(env, u, target) {
  const left = await env.DB.prepare('SELECT COUNT(*) n FROM members WHERE household_id=?').bind(u.hid).first();
  const t = now(), st = [env.DB.prepare('UPDATE members SET household_id=?, joined=? WHERE user_id=?').bind(target, t, u.id)];
  if (left.n <= 1) { // stary dom pusty → przenieś jego plan do nowego domu
    st.push(env.DB.prepare(`INSERT OR IGNORE INTO plan_items(household_id,id,kind,title,notes,due,done,remind_at,reminded,created_by,updated,deleted,srv)
      SELECT ?1,id,kind,title,notes,due,done,remind_at,reminded,created_by,updated,deleted,?2 FROM plan_items WHERE household_id=?3`).bind(target, t, u.hid),
      env.DB.prepare('DELETE FROM plan_items WHERE household_id=?').bind(u.hid),
      env.DB.prepare('DELETE FROM invites WHERE household_id=?').bind(u.hid),
      env.DB.prepare('DELETE FROM households WHERE id=?').bind(u.hid));
  }
  await env.DB.batch(st);
}
async function join(env, req, u, body) {
  await hit(env, 'joinip:' + ip(req), LIM.joinIP);
  await hit(env, 'join:' + u.id, LIM.joinU);
  const c = normCode(body.code);
  if (c.length !== 8) fail(400, 'bad_code');
  const inv = await env.DB.prepare('DELETE FROM invites WHERE hash=? RETURNING household_id, expires').bind(await sha('inv:' + c)).first();
  if (!inv || inv.expires < now()) fail(400, 'bad_code');
  if (inv.household_id === u.hid) fail(400, 'same_household');
  const cnt = await env.DB.prepare('SELECT COUNT(*) n FROM members WHERE household_id=?').bind(inv.household_id).first();
  if (!cnt.n) fail(400, 'bad_code');
  if (cnt.n >= 6) fail(400, 'full');
  await moveTo(env, u, inv.household_id);
  return { ok: true };
}
async function leave(env, u) {
  const left = await env.DB.prepare('SELECT COUNT(*) n FROM members WHERE household_id=?').bind(u.hid).first();
  if (left.n <= 1) fail(400, 'alone');
  const hid = newId('h_');
  await env.DB.batch([env.DB.prepare('INSERT INTO households(id,created) VALUES(?,?)').bind(hid, now()),
    env.DB.prepare('UPDATE members SET household_id=?, joined=? WHERE user_id=?').bind(hid, now(), u.id)]);
  return { ok: true };
}

// ---------- synchronizacja ----------
const ID_RE = /^[\w-]{1,64}$/;
const cur = s => { const m = /^(\d{1,15}):([\w-]{0,64})$/.exec(String(s || '')); return m ? [+m[1], m[2]] : [0, '']; };
function cleanPlan(x) {
  if (!x || typeof x !== 'object' || !ID_RE.test(x.id || '') || !isFinite(+x.updated)) return null;
  if (x.deleted) return { id: x.id, updated: +x.updated, deleted: 1, kind: 'task', title: '-', notes: '', due: '', done: 0, remind_at: null };
  const kind = ['event', 'task', 'shop'].includes(x.kind) ? x.kind : null;
  const title = str(x.title, 200).trim();
  if (!kind || !title) return null;
  const due = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(x.due || '') ? x.due : '';
  const ra = Number.isSafeInteger(x.remind_at) && x.remind_at > 1.5e12 && x.remind_at < 4e12 ? x.remind_at : null;
  return { id: x.id, updated: +x.updated, deleted: 0, kind, title, notes: str(x.notes, 1000), due, done: x.done ? 1 : 0, remind_at: ra };
}
async function sync(env, u, body) {
  const t = now(), DB = env.DB, st = [];
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 200) : [];
  const plan = Array.isArray(body.plan) ? body.plan.slice(0, 200) : [];
  const kv = Array.isArray(body.kv) ? body.kv.slice(0, 10) : [];
  for (const e of entries) {
    if (!e || !ID_RE.test(e.id || '') || !isFinite(+e.updated)) continue;
    const data = e.deleted ? null : JSON.stringify(e.data && typeof e.data === 'object' ? e.data : {});
    if (data && data.length > 400000) continue;
    st.push(DB.prepare(`INSERT INTO entries(user_id,id,data,updated,deleted,srv) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET
      data=excluded.data, updated=excluded.updated, deleted=excluded.deleted, srv=excluded.srv WHERE excluded.updated > entries.updated`).bind(u.id, e.id, data, +e.updated, e.deleted ? 1 : 0, t));
  }
  for (const k of kv) {
    if (!k || !['cats', 'incCats', 'start'].includes(k.k) || !isFinite(+k.updated)) continue;
    const v = JSON.stringify(k.v ?? null); if (v.length > 20000) continue;
    st.push(DB.prepare(`INSERT INTO user_kv(user_id,k,v,updated,srv) VALUES(?,?,?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET
      v=excluded.v, updated=excluded.updated, srv=excluded.srv WHERE excluded.updated > user_kv.updated`).bind(u.id, k.k, v, +k.updated, t));
  }
  for (const raw of plan) {
    const p = cleanPlan(raw); if (!p) continue;
    st.push(DB.prepare(`INSERT INTO plan_items(household_id,id,kind,title,notes,due,done,remind_at,reminded,created_by,updated,deleted,srv)
      VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(household_id,id) DO UPDATE SET kind=excluded.kind, title=excluded.title, notes=excluded.notes,
      due=excluded.due, done=excluded.done, reminded=CASE WHEN excluded.remind_at IS plan_items.remind_at THEN plan_items.reminded ELSE 0 END,
      remind_at=excluded.remind_at, updated=excluded.updated, deleted=excluded.deleted, srv=excluded.srv WHERE excluded.updated > plan_items.updated`)
      .bind(u.hid, p.id, p.kind, p.title, p.notes, p.due, p.done, p.remind_at, u.id, p.updated, p.deleted, t));
  }
  if (st.length) await DB.batch(st);
  const [es, ei] = cur(body.since), [ps, pi] = cur(body.planSince);
  const LIMIT = 300;
  const er = (await DB.prepare(`SELECT id,data,updated,deleted,srv FROM entries WHERE user_id=?1 AND (srv>?2 OR (srv=?2 AND id>?3)) ORDER BY srv,id LIMIT ${LIMIT}`).bind(u.id, es, ei).all()).results;
  const pr = (await DB.prepare(`SELECT id,kind,title,notes,due,done,remind_at,created_by,updated,deleted,srv FROM plan_items WHERE household_id=?1 AND (srv>?2 OR (srv=?2 AND id>?3)) ORDER BY srv,id LIMIT ${LIMIT}`).bind(u.hid, ps, pi).all()).results;
  const kr = (await DB.prepare('SELECT k,v,updated FROM user_kv WHERE user_id=? AND srv>=?').bind(u.id, es).all()).results;
  const last = (a, d) => a.length ? a[a.length - 1].srv + ':' + a[a.length - 1].id : (d || '0:');
  return {
    entries: er.map(r => ({ id: r.id, updated: r.updated, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) })),
    kv: kr.map(r => ({ k: r.k, v: JSON.parse(r.v), updated: r.updated })),
    plan: pr.map(r => ({ id: r.id, kind: r.kind, title: r.title, notes: r.notes, due: r.due, done: !!r.done, remind_at: r.remind_at, by: r.created_by, updated: r.updated, deleted: !!r.deleted })),
    since: last(er, body.since), planSince: last(pr, body.planSince),
    more: er.length === LIMIT || pr.length === LIMIT,
  };
}

// ---------- usunięcie konta ----------
async function deleteAccount(env, u) {
  const left = await env.DB.prepare('SELECT COUNT(*) n FROM members WHERE household_id=?').bind(u.hid).first();
  const DB = env.DB, st = [
    DB.prepare('DELETE FROM entries WHERE user_id=?').bind(u.id),
    DB.prepare('DELETE FROM user_kv WHERE user_id=?').bind(u.id),
    DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id),
    DB.prepare('DELETE FROM login_codes WHERE user_id=?').bind(u.id),
    DB.prepare('DELETE FROM push_subs WHERE user_id=?').bind(u.id),
    DB.prepare('DELETE FROM invites WHERE created_by=?').bind(u.id),
    DB.prepare('DELETE FROM members WHERE user_id=?').bind(u.id),
    DB.prepare('UPDATE plan_items SET created_by=NULL WHERE created_by=?').bind(u.id),
    DB.prepare('DELETE FROM users WHERE id=?').bind(u.id),
  ];
  if (left.n <= 1) st.push(DB.prepare('DELETE FROM plan_items WHERE household_id=?').bind(u.hid), DB.prepare('DELETE FROM invites WHERE household_id=?').bind(u.hid), DB.prepare('DELETE FROM households WHERE id=?').bind(u.hid));
  await DB.batch(st);
  return { ok: true, deleted: true };
}

// ---------- Web Push (VAPID + aes128gcm, RFC 8291/8292) ----------
async function vapid(env) {
  let row = await env.DB.prepare("SELECT v FROM config WHERE k='vapid'").first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) });
    await env.DB.prepare("INSERT OR IGNORE INTO config(k,v) VALUES('vapid',?)").bind(v).run();
    row = await env.DB.prepare("SELECT v FROM config WHERE k='vapid'").first();
  }
  const v = JSON.parse(row.v);
  return { pub: v.pub, key: await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
}
async function vapidAuth(env, endpoint) {
  const v = await vapid(env), u = new URL(endpoint);
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud: u.origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub: 'mailto:wydatki-app@users.noreply.github.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(h + '.' + c));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${v.pub}`;
}
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function encryptPush(sub, payload) {
  const ua = unb64u(sub.p256dh), authS = unb64u(sub.auth);
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const prkKey = await hmac(authS, secret);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), ua, asPub, new Uint8Array([1])));
  const salt = rnd(16), prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}
function pushHostOk(env, endpoint) {
  try {
    const u = new URL(endpoint);
    if (env.TEST_PUSH_ORIGIN && u.origin === env.TEST_PUSH_ORIGIN) return true; // tylko lokalne testy
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(r => r.test(u.hostname));
  } catch { return false; }
}
async function sendPush(env, sub, msg) {
  if (!pushHostOk(env, sub.endpoint)) return 400;
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    TTL: '86400', Urgency: 'high', Authorization: await vapidAuth(env, sub.endpoint) } });
  if (r.status === 404 || r.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(sub.endpoint).run();
  return r.status;
}
async function subscribe(env, u, body) {
  await hit(env, 'push:' + u.id, LIM.push);
  const ep = str(body.endpoint, 1000), p = str(body.keys?.p256dh, 200), a = str(body.keys?.auth, 100);
  if (!pushHostOk(env, ep)) fail(400, 'bad_endpoint');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p) || unb64u(p).length !== 65 || !/^[A-Za-z0-9_-]{16,32}$/.test(a)) fail(400, 'bad_keys');
  const tz = /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(body.tz || '') ? body.tz : 'Europe/Warsaw';
  const n = await env.DB.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').bind(u.id).first();
  if (n.n >= 8) await env.DB.prepare('DELETE FROM push_subs WHERE user_id=? AND created=(SELECT MIN(created) FROM push_subs WHERE user_id=?)').bind(u.id, u.id).run();
  await env.DB.prepare('INSERT OR REPLACE INTO push_subs(endpoint,user_id,p256dh,auth,tz,created) VALUES(?,?,?,?,?,?)').bind(ep, u.id, p, a, tz, now()).run();
  return { ok: true };
}
function whenText(due, tz) {
  if (!due) return '';
  const [d, tm] = due.split('T'); const [y, mo, da] = d.split('-').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Warsaw' }).format(new Date());
  const tom = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Warsaw' }).format(new Date(now() + 864e5));
  const day = d === today ? 'dziś' : d === tom ? 'jutro' : `${da}.${String(mo).padStart(2, '0')}.${y}`;
  return day + (tm ? ' ' + tm : '');
}
async function runReminders(env) {
  const t = now();
  const due = (await env.DB.prepare('SELECT household_id,id,kind,title,due FROM plan_items WHERE reminded=0 AND deleted=0 AND done=0 AND remind_at IS NOT NULL AND remind_at<=? AND remind_at>? LIMIT 200').bind(t, t - 864e5).all()).results;
  let sent = 0;
  for (const it of due) {
    await env.DB.prepare('UPDATE plan_items SET reminded=1 WHERE household_id=? AND id=?').bind(it.household_id, it.id).run();
    const subs = (await env.DB.prepare('SELECT p.* FROM push_subs p JOIN members m ON m.user_id=p.user_id WHERE m.household_id=?').bind(it.household_id).all()).results;
    for (const s of subs) {
      const icon = it.kind === 'event' ? '📅' : it.kind === 'shop' ? '🛒' : '✅';
      try { if ((await sendPush(env, s, { title: icon + ' ' + it.title, body: whenText(it.due, s.tz) || 'Przypomnienie', tag: 'p-' + it.id })) < 300) sent++; } catch {}
    }
  }
  await env.DB.batch([env.DB.prepare('DELETE FROM rate WHERE reset<?').bind(t), env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(t),
    env.DB.prepare('DELETE FROM login_codes WHERE expires<?').bind(t), env.DB.prepare('DELETE FROM invites WHERE expires<?').bind(t),
    env.DB.prepare('DELETE FROM plan_items WHERE deleted=1 AND srv<?').bind(t - 90 * 864e5), env.DB.prepare('DELETE FROM entries WHERE deleted=1 AND srv<?').bind(t - 365 * 864e5)]);
  return { due: due.length, sent };
}

// ---------- Gemini ----------
async function gemini(env, gReq) {
  if (!env.GEMINI_API_KEY) fail(500, 'not_configured');
  await hit(env, 'gem:all', LIM.geminiGlobal);
  let r, d;
  for (const m of [...new Set([env.MODEL || 'gemini-3.5-flash', env.FALLBACK_MODEL || 'gemini-flash-latest'])]) {
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(gReq) });
      d = await r.json();
    } catch { r = null; }
    if (r && r.ok) break;
    if (r && !(r.status === 429 || r.status >= 500)) break;
  }
  if (!r || !r.ok) throw Object.assign(new HttpErr(502, 'upstream'), { extra: { status: r ? r.status : 0 } });
  return d;
}
const gText = d => (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');

function receiptPrompt(cats) {
  return `You read shop receipts (photos) for a personal expense app. Receipts can be Polish, Belgian (Dutch or French), German, or from other EU countries.
Return ONLY data visible on the receipt(s). Several photos may be parts of ONE long receipt: merge them, do not duplicate lines.
Rules:
- shop: store name (e.g. "Delhaize", "Biedronka", "Lidl"), country: ISO 3166 alpha-2 guess (PL, BE, DE, NL, FR...).
- date: purchase date as YYYY-MM-DD (receipts often use DD-MM-YYYY or DD.MM.YY). Empty string if not visible.
- currency: ISO code from symbols/words: "zł"/"PLN" -> PLN, "€"/"EUR"/"euro" -> EUR. If no symbol: infer from country (PL -> PLN, BE/DE/NL/FR -> EUR).
- total: the final amount paid. Keywords: PL "SUMA", "SUMA PLN", "RAZEM", "DO ZAPŁATY"; NL "TOTAAL", "TE BETALEN"; FR "TOTAL", "A PAYER", "À PAYER"; DE "SUMME", "GESAMT", "ZU ZAHLEN". Do NOT use the cash given or change ("Gotówka", "Reszta", "Wisselgeld", "Rendu", "Gegeben", "Rückgeld") or card slip amounts unless equal to total.
- items: each purchased product line. name: short readable product name (keep original language, fix obvious OCR typos). qty: quantity (1 if not shown; weight in kg allowed). price: FINAL line amount actually paid for that line (after line discounts/"rabat"/"korting"/"remise"/"Rabatt"). If a discount is a separate line, subtract it from the product it belongs to; if it can't be attributed, add it as its own item with a negative price. Deposits (kaucja, leeggoed/vidange, Pfand) are items too.
- category for each item: exactly one of: ${cats.map(c => JSON.stringify(c)).join(', ')}. Food & drinks & groceries -> "Jedzenie"; cleaning, cosmetics, household, hygiene -> "Zakupy/dom"; fuel, parking, tickets -> "Transport/paliwo"; medicines/pharmacy -> "Zdrowie"; kids items/diapers/toys -> "Dzieci"; clothes/shoes -> "Ubrania"; use "Inne" when unsure. Prefer a matching custom category if the list has one.
- vat: VAT/PTU/BTW/TVA/MwSt summary lines if visible: rate (e.g. "23%", "6%", "A"), base (net), amount (tax). Empty array if none.
- Use dot as decimal separator in numbers. Never invent items that are not on the receipt.`;
}
function receiptSchema(cats) {
  return { type: 'OBJECT', properties: { shop: { type: 'STRING' }, country: { type: 'STRING' }, date: { type: 'STRING' }, currency: { type: 'STRING' }, total: { type: 'NUMBER' },
    vat: { type: 'ARRAY', items: { type: 'OBJECT', properties: { rate: { type: 'STRING' }, base: { type: 'NUMBER' }, amount: { type: 'NUMBER' } }, required: ['rate', 'amount'] } },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'NUMBER' }, price: { type: 'NUMBER' }, category: { type: 'STRING', enum: cats } }, required: ['name', 'price', 'category'] } } },
    required: ['shop', 'currency', 'total', 'items'] };
}
const userCats = (a, def) => [...new Set([...def, ...(Array.isArray(a) ? a : []).filter(c => typeof c === 'string' && c.trim() && c.length <= 40).slice(0, 40)])];
async function receipt(env, req, body) {
  await hit(env, 'rcm:' + ip(req), LIM.receiptMin);
  await hit(env, 'rcd:' + ip(req), LIM.receiptDay);
  const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .filter(i => i && typeof i.data === 'string' && /^image\/(jpeg|png|webp|heic|heif)$/.test(i.mime || ''));
  if (!imgs.length) fail(400, 'no_image');
  const cats = userCats(body.categories, DEFAULT_CATS);
  const d = await gemini(env, { contents: [{ role: 'user', parts: [...imgs.map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: receiptPrompt(cats) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: receiptSchema(cats), temperature: 0 } });
  let out; try { out = JSON.parse(gText(d)); } catch { fail(502, 'parse'); }
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  out.items = (out.items || []).map(i => ({ name: str(i.name, 80), qty: +i.qty || 1, price: r2(i.price), category: cats.includes(i.category) ? i.category : 'Inne' }));
  out.total = r2(out.total); out.currency = str(out.currency, 3).toUpperCase();
  const sum = r2(out.items.reduce((s, i) => s + i.price, 0));
  out.check = { itemsSum: sum, total: out.total, diff: r2(out.total - sum), matches: Math.abs(out.total - sum) <= 0.05 };
  out.model = d.modelVersion || '';
  return out;
}
async function parse(env, u, body) {
  await hit(env, 'pm:' + u.id, LIM.parseMin); await hit(env, 'pd:' + u.id, LIM.parseDay);
  const text = str(body.text, 1000).trim(); if (!text) fail(400, 'no_text');
  const cats = userCats(body.cats, DEFAULT_CATS), incCats = userCats(body.incCats, ['Wypłata', 'Inne']);
  const nowLocal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.now || '') ? body.now.slice(0, 16) : new Date().toISOString().slice(0, 16);
  const allow = body.mode === 'money' ? ['expense', 'income'] : body.mode === 'plan' ? ['event', 'task', 'shop'] : ['expense', 'income', 'event', 'task', 'shop'];
  const prompt = `You turn a short Polish (sometimes English/Dutch/French) voice or text note into structured items for a household app.
Current local date-time: ${nowLocal} (weekday: ${['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'][new Date(nowLocal + 'Z').getUTCDay()]}).
Allowed kinds: ${allow.join(', ')}.
- expense: money spent. amount (number), currency PLN or EUR (zł/złotych -> PLN, euro/€ -> EUR, default ${body.cur === 'EUR' ? 'EUR' : 'PLN'}), category exactly one of ${JSON.stringify(cats)}, note = shop or short description, date YYYY-MM-DD (default today).
- income: money received. amount, currency, category exactly one of ${JSON.stringify(incCats)}, note (e.g. "Od mamy"), date.
- event: an appointment/meeting with a time (lekarz, dentysta, urodziny, spotkanie). title short, due = YYYY-MM-DDTHH:MM (or YYYY-MM-DD if no time), remind_min = minutes before to remind (default 60 if time given, else 0 meaning morning; use what the user says, e.g. "dzień wcześniej" = 1440).
- task: a to-do (zadzwonić, zapłacić, załatwić). title, optional due, remind_min -1 if no reminder asked.
- shop: something to buy. One item per product ("kup mleko i chleb" -> two shop items). title = product with amount if said (e.g. "Mleko 2 l").
Resolve relative dates ("jutro", "w piątek", "za tydzień") against the current date. Titles in the user's language, capitalized. Never invent items.`;
  const props = { kind: { type: 'string', enum: allow }, title: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', enum: ['PLN', 'EUR'] },
    category: { type: 'string' }, note: { type: 'string' }, date: { type: 'string' }, due: { type: 'string' }, remind_min: { type: 'integer' } };
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: props, required: Object.keys(props) } } }, required: ['items'] };
  const d = await gemini(env, { contents: [{ role: 'user', parts: [{ text: prompt + '\nFill fields that do not apply with "" (text), 0 (amount) or -1 (remind_min).\n\nNote: """' + text.replace(/"""/g, '"') + '"""' }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0 } });
  let out; try { out = JSON.parse(gText(d)); } catch { fail(502, 'parse'); }
  const items = (out.items || []).slice(0, 20).map(i => {
    const k = allow.includes(i.kind) ? i.kind : null; if (!k) return null;
    if (k === 'expense' || k === 'income') {
      const list = k === 'expense' ? cats : incCats, a = Math.round((+i.amount || 0) * 100) / 100;
      return a > 0 ? { kind: k, amount: a, currency: i.currency === 'EUR' ? 'EUR' : 'PLN', category: list.includes(i.category) ? i.category : 'Inne', note: str(i.note || i.title, 120),
        date: /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : nowLocal.slice(0, 10) } : null;
    }
    const title = str(i.title, 200).trim(); if (!title) return null;
    return { kind: k, title, due: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(i.due || '') ? i.due : '', remind_min: Number.isInteger(i.remind_min) && i.remind_min >= -1 && i.remind_min <= 20160 ? i.remind_min : -1 };
  }).filter(Boolean);
  return { items };
}
async function where(env, u, body) {
  await hit(env, 'wm:' + u.id, LIM.whereMin); await hit(env, 'wd:' + u.id, LIM.whereDay);
  const q = str(body.q, 200).trim(); if (!q) fail(400, 'no_query');
  const place = str(body.place, 80).trim();
  const prompt = `Użytkownik chce kupić: "${q.replace(/"/g, "'")}"${place ? ` w okolicy: ${place.replace(/"/g, "'")}` : ' (Polska lub Belgia)'}.
Używając wyszukiwarki Google znajdź 3–5 konkretnych miejsc (sklepy stacjonarne lub internetowe), gdzie da się to teraz kupić, z orientacyjną ceną, jeśli jest znana.
Odpowiedz po polsku, krótko, jako lista: „• Sklep – cena – krótka uwaga”. Bez wstępu. Nie wymyślaj cen ani sklepów, których nie ma w wynikach.`;
  const qs = encodeURIComponent(q + (place ? ' ' + place : ''));
  const be = body.country === 'BE' || /bru|brux|antw|gent|gand|li[eè]ge|leuven|belg/i.test(place);
  const searchLinks = [
    { url: 'https://www.google.com/maps/search/?api=1&query=' + qs, title: '📍 Google Maps – sklepy w pobliżu' },
    { url: 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(q), title: '🛍️ Google Zakupy – porównanie cen' },
    ...(be ? [{ url: 'https://www.bol.com/be/nl/s/?searchtext=' + encodeURIComponent(q), title: '🛒 bol.com' }]
      : [{ url: 'https://allegro.pl/listing?string=' + encodeURIComponent(q), title: '🛒 Allegro' }, { url: 'https://www.ceneo.pl/;szukaj-' + encodeURIComponent(q), title: '💰 Ceneo – porównanie cen' }]),
    { url: 'https://www.google.com/search?q=' + qs, title: '🔎 Google' },
  ];
  let d, grounded = true;
  try { d = await gemini(env, { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }); }
  catch (e) {
    if (!(e instanceof HttpErr) || e.code !== 'upstream') throw e;
    // wyszukiwanie Google niedostępne dla tego klucza (np. darmowy plan) → podpowiedź AI bez wyszukiwania + linki wyszukiwania
    grounded = false;
    d = await gemini(env, { contents: [{ role: 'user', parts: [{ text: `Użytkownik chce kupić: "${q.replace(/"/g, "'")}"${place ? ` (okolica: ${place.replace(/"/g, "'")})` : ''}. Podaj po polsku 3–5 typów sklepów lub popularnych sieci (w ${be ? 'Belgii' : 'Polsce'}), gdzie zwykle można to kupić, jako lista „• Sieć/typ sklepu – krótka uwaga”. Bez cen, bez wstępu, bez linków.` }] }], generationConfig: { temperature: 0.2 } });
  }
  const gm = d.candidates?.[0]?.groundingMetadata || {};
  const seen = new Set(), links = [];
  for (const c of gm.groundingChunks || []) {
    const w = c.web; if (!w || typeof w.uri !== 'string' || !/^https:\/\//.test(w.uri) || seen.has(w.uri)) continue;
    seen.add(w.uri); links.push({ url: w.uri.slice(0, 2000), title: str(w.title || new URL(w.uri).hostname, 100) });
    if (links.length >= 8) break;
  }
  return { text: str(gText(d), 3000), links: [...links, ...searchLinks], grounded };
}

// ---------- router ----------
async function body(req, max) {
  const len = +req.headers.get('Content-Length') || 0;
  if (len > max) fail(413, 'too_large');
  const t = await req.text();
  if (t.length > max) fail(413, 'too_large');
  try { const b = JSON.parse(t || '{}'); if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0; return b; } catch { fail(400, 'bad_json'); }
}
async function route(req, env, path) {
  const M = req.method;
  await ensureSchema(env);
  if (path === '/' && M === 'POST') return receipt(env, req, await body(req, MAX_BODY));
  if (!path.startsWith('/api/')) fail(404, 'not_found');
  const p = path.slice(5);
  if (M === 'GET' && p === 'push/key') return { key: (await vapid(env)).pub };
  if (M === 'POST' && p === 'register') return register(env, req, await body(req, 4096));
  if (M === 'POST' && p === 'login/recover') return recover(env, req, await body(req, 4096));
  if (M === 'POST' && p === 'login/redeem') return redeem(env, req, await body(req, 4096));
  const u = await auth(req, env);
  if (M === 'GET' && p === 'me') return me(env, u);
  if (M === 'POST' && p === 'login/code') return makeLoginCode(env, u);
  if (M === 'POST' && p === 'logout') { await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await sha(req.headers.get('Authorization').slice(7))).run(); return { ok: true }; }
  if (M === 'DELETE' && p === 'account') return deleteAccount(env, u);
  if (M === 'POST' && p === 'household/invite') return invite(env, u);
  if (M === 'POST' && p === 'household/join') return join(env, req, u, await body(req, 4096));
  if (M === 'POST' && p === 'household/leave') return leave(env, u);
  if (M === 'POST' && p === 'sync') return sync(env, u, await body(req, MAX_API_BODY));
  if (M === 'POST' && p === 'push/subscribe') return subscribe(env, u, await body(req, 8192));
  if (M === 'POST' && p === 'push/unsubscribe') { const b = await body(req, 8192); await env.DB.prepare('DELETE FROM push_subs WHERE user_id=? AND endpoint=?').bind(u.id, str(b.endpoint, 1000)).run(); return { ok: true }; }
  if (M === 'POST' && p === 'push/test') {
    await hit(env, 'push:' + u.id, LIM.push);
    const subs = (await env.DB.prepare('SELECT * FROM push_subs WHERE user_id=?').bind(u.id).all()).results;
    const res = []; for (const s of subs) { try { res.push(await sendPush(env, s, { title: '🔔 Wydatki', body: 'Powiadomienia działają!', tag: 'test' })); } catch { res.push(0); } }
    return { sent: res };
  }
  if (M === 'POST' && p === 'parse') return parse(env, u, await body(req, 8192));
  if (M === 'POST' && p === 'where') return where(env, u, await body(req, 4096));
  fail(404, 'not_found');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED_ORIGINS.includes(origin) || (env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
    if (req.method === 'OPTIONS') return ok ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/') return json({ ok: true, service: 'wydatki' }, 200, ok ? origin : null);
    if (!ok) return json({ error: 'forbidden' }, 403);
    try { return json(await route(req, env, path), 200, origin); }
    catch (e) {
      if (e instanceof HttpErr) return json({ error: e.code, ...(e.extra || {}) }, e.status, origin);
      console.log('err', e && e.stack || e);
      return json({ error: 'server' }, 500, origin);
    }
  },
  async scheduled(ev, env, ctx) { await ensureSchema(env); ctx.waitUntil(runReminders(env)); },
};
