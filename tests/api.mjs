// Testy bezpieczeństwa API (10 punktów) – dwóch testowych użytkowników.
// BASE=http://127.0.0.1:8811 SQL="cmd" node tests/api.mjs   (lokalnie, SQL = polecenie wykonujące zapytanie w D1)
// BASE=https://wydatki-receipt.tazo88.workers.dev SIGNUP_CODES=kod1,kod2 node tests/api.mjs   (live; 2 testowe kody startowe wstawione wcześniej do D1; testy wymagające SQL są pomijane)
import { execSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
// jedno połączenie HTTP = jeden adres IP (bramka testowa zmienia IP między połączeniami)
try { const { createRequire } = await import('node:module'); const rq = createRequire(process.env.TOOLS || import.meta.url); const { Agent, setGlobalDispatcher } = rq('undici'); setGlobalDispatcher(new Agent({ connections: 1, pipelining: 1, keepAliveTimeout: 60000 })); } catch {}
const BASE = process.env.BASE || 'http://127.0.0.1:8811';
const ORIGIN = 'https://tazo88.github.io', EVIL = 'https://evil.example';
const SQL = process.env.SQL; // np. "npx wrangler d1 execute wydatki --local --json --command"
const LOCAL = !!SQL;
let pass = 0, failN = 0, skip = 0; const results = [];
function ok(sec, name, cond, info = '') { results.push([sec, name, cond]); if (cond) pass++; else failN++; console.log(`${cond ? 'PASS' : 'FAIL'} [${sec}] ${name}${!cond && info ? ' — ' + info : ''}`); }
function skipT(sec, name, why) { skip++; console.log(`SKIP [${sec}] ${name} — ${why}`); }
async function req(method, path, { token, body, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers }; if (origin) h.Origin = origin; if (token) h.Authorization = 'Bearer ' + token; if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch {}
  return { s: r.status, j, t, h: r.headers };
}
const sql = q => { const out = execSync(`${SQL} ${JSON.stringify(q)}`, { cwd: process.env.SQL_CWD, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); return JSON.parse(out)[0].results; };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => 't' + crypto.randomBytes(6).toString('hex');
await req('GET', '/api/push/key');
if (LOCAL) sql('DELETE FROM rate');

// ---------- start: dwóch użytkowników (rejestracja tylko z kodem) ----------
const A16 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', mk16 = () => [...crypto.randomBytes(16)].map(x => A16[x & 31]).join('');
const fmt16 = c => c.match(/.{4}/g).join('-');
let SC = (process.env.SIGNUP_CODES || '').split(',').filter(Boolean);
const addCode = (c, role = 'test', exp = Date.now() + 3600e3) => sql(`INSERT INTO signup_codes(hash,role,expires,created) VALUES('${sha('su:' + c.replace(/-/g, ''))}','${role}',${exp},${Date.now()})`);
if (LOCAL) { SC = [mk16(), mk16()]; SC.forEach(c => addCode(c)); }
const regA = await req('POST', '/api/register', { body: { name: 'TestA <img src=x onerror=alert(1)>', code: fmt16(SC[0]) } });
const regB = await req('POST', '/api/register', { body: { name: "TestB'); DROP TABLE users;--", code: SC[1].toLowerCase() } });
ok('setup', 'rejestracja A i B', regA.s === 200 && regB.s === 200 && regA.j.token && regB.j.token, regA.t + regB.t);
const A = regA.j.token, B = regB.j.token, Aid = regA.j.user.id, Bid = regB.j.user.id;
const users = [[A, 'A'], [B, 'B']];

// ---------- 12. tylko z zaproszeniem ----------
const n1 = await req('POST', '/api/register', { body: { name: 'Bez kodu' } });
const n2 = await req('POST', '/api/register', { body: { name: 'Zły kod', code: '<script>' } });
ok('12 Zaproszenia', 'rejestracja bez kodu → 403, ze śmieciowym kodem → 400', n1.s === 403 && n1.j?.error === 'invite_required' && n2.s === 400, n1.t + n2.t);
const reuse = await req('POST', '/api/register', { body: { name: 'Drugi raz', code: SC[0] } });
ok('12 Zaproszenia', 'kod startowy jednorazowy (drugi raz → 400)', reuse.s === 400 && reuse.j?.error === 'bad_code', reuse.t);
const g1 = await req('POST', '/api/register', { body: { name: 'Zgadywacz', code: fmt16(mk16()) } });
const g2 = await req('POST', '/api/register', { body: { name: 'Zgadywacz', code: 'ABCD-EFGH' } });
ok('12 Zaproszenia', 'zgadnięty kod (16 i 8 znaków) → 400', g1.s === 400 && g2.s === 400, g1.s + ',' + g2.s);
if (LOCAL) {
  const ex = mk16(); addCode(ex, 'test', 1);
  ok('12 Zaproszenia', 'wygasły kod → 400', (await req('POST', '/api/register', { body: { name: 'Stary', code: ex } })).s === 400);
  const rows = sql('SELECT hash FROM signup_codes');
  ok('12 Zaproszenia', 'kody startowe zapisane tylko jako hash', rows.every(r => /^[0-9a-f]{64}$/.test(r.hash)) && !JSON.stringify(rows).includes(SC[0]));
} else skipT('12 Zaproszenia', 'wygasły kod / hash w bazie', 'wymaga SQL (sprawdzone lokalnie)');
const invC = await req('POST', '/api/household/invite', { token: A });
const regC = await req('POST', '/api/register', { body: { name: 'TestC', code: invC.j.code } });
const meC = regC.j?.token ? await req('GET', '/api/me', { token: regC.j.token }) : null;
ok('12 Zaproszenia', 'kod zaproszenia do domu = zaproszenie do aplikacji (konto + wspólny dom w 1 kroku)', regC.s === 200 && meC?.j.household.members.some(m => m.id === Aid) && meC.j.household.members.length === 2 && meC.j.owner === false, regC.t);
ok('12 Zaproszenia', 'nowa osoba nie widzi pieniędzy zapraszającego', meC && !(await req('POST', '/api/sync', { token: regC.j.token, body: { since: '0:' } })).t.includes('SEKRET'));
ok('12 Zaproszenia', 'kod domu też jednorazowy', (await req('POST', '/api/register', { body: { name: 'TestD', code: invC.j.code } })).s === 400);
if (regC.j?.token) await req('DELETE', '/api/account', { token: regC.j.token });
if (LOCAL) {
  sql("DELETE FROM rate WHERE k LIKE 'reg:%'"); sql("DELETE FROM config WHERE k='owner'"); const oc = mk16(); addCode(oc, 'owner', Date.now() + 7 * 864e5);
  const ro = await req('POST', '/api/register', { body: { name: 'Właściciel', code: oc } });
  const mo = await req('GET', '/api/me', { token: ro.j.token }), ma = await req('GET', '/api/me', { token: A });
  ok('12 Zaproszenia', 'kod właściciela: pierwsze konto = właściciel (inni nie)', mo.j.owner === true && ma.j.owner === false && sql("SELECT v FROM config WHERE k='owner'")[0]?.v === ro.j.user.id);
  await req('DELETE', '/api/account', { token: ro.j.token });
  ok('12 Zaproszenia', 'usunięcie konta właściciela czyści rolę', sql("SELECT v FROM config WHERE k='owner'").length === 0);
}
const bf = []; for (let i = 0; i < 11; i++) bf.push((await req('POST', '/api/register', { body: { name: 'Brute', code: [...crypto.randomBytes(8)].map(x => A16[x & 31]).join('') } })).s);
const b429 = bf.indexOf(429);
ok('12 Zaproszenia', 'zgadywanie kodów przy rejestracji blokowane (max 10 prób/h z IP → 429)', b429 >= 0 && bf.slice(0, b429).every(s => s === 400) && bf.slice(b429).every(s => s === 429), bf.join(','));
// AI tylko z kontem
const ai0 = [await req('POST', '/', { body: { images: [] } }), await req('POST', '/', { token: crypto.randomBytes(32).toString('base64url'), body: { images: [] } }),
  await req('POST', '/api/parse', { body: { text: 'kup mleko' } }), await req('POST', '/api/where', { body: { q: 'mleko' } })];
ok('12 Zaproszenia', 'AI (paragon, parsowanie, „Gdzie kupić?”) bez konta / z podrobionym tokenem → 401', ai0.every(r => r.s === 401), ai0.map(r => r.s).join(','));

// ---------- 1. IDOR ----------
const eid = rid();
await req('POST', '/api/sync', { token: A, body: { entries: [{ id: eid, updated: 1000, data: { id: eid, amount: 12.5, note: 'SEKRET-A', type: 'exp', date: '2026-10-04', currency: 'PLN', category: 'Inne' } }], kv: [{ k: 'start', v: { PLN: 999 }, updated: 1000 }] } });
let sb = await req('POST', '/api/sync', { token: B, body: { since: '0:' } });
ok('1 IDOR', 'B nie widzi wydatków ani ustawień A', sb.s === 200 && !sb.t.includes('SEKRET-A') && !sb.t.includes('999'));
await req('POST', '/api/sync', { token: B, body: { entries: [{ id: eid, updated: 9e12, data: { note: 'NADPISANE-PRZEZ-B' } }, { id: eid, updated: 9e12, deleted: true }], kv: [{ k: 'start', v: { PLN: 1 }, updated: 9e12 }] } });
let sa = await req('POST', '/api/sync', { token: A, body: { since: '0:' } });
ok('1 IDOR', 'B nie nadpisze/usunie wpisu A o tym samym id', sa.j.entries.find(e => e.id === eid)?.data?.note === 'SEKRET-A' && !sa.j.entries.find(e => e.id === eid).deleted);
ok('1 IDOR', 'B nie zmieni ustawień A', sa.j.kv.find(k => k.k === 'start')?.v?.PLN === 999);
const pid = rid();
await req('POST', '/api/sync', { token: A, body: { plan: [{ id: pid, kind: 'task', title: 'PLAN-A-PRYWATNY', updated: 1000 }] } });
await req('POST', '/api/sync', { token: B, body: { plan: [{ id: pid, kind: 'task', title: 'ATAK', updated: 9e12 }] } });
sa = await req('POST', '/api/sync', { token: A, body: { planSince: '0:' } });
sb = await req('POST', '/api/sync', { token: B, body: { planSince: '0:' } });
ok('1 IDOR', 'plan A nienaruszony przez B (ten sam id)', sa.j.plan.find(p => p.id === pid)?.title === 'PLAN-A-PRYWATNY');
ok('1 IDOR', 'brak parametrów user/household do podmiany (ignorowane)', (await req('POST', '/api/sync', { token: B, body: { user_id: Aid, household_id: 'x', since: '0:' } })).t.includes('SEKRET-A') === false);

// ---------- 2. dom: brak dostępu bez członkostwa ----------
ok('2 Dom', 'B (nie członek) nie widzi planu A', !sb.t.includes('PLAN-A-PRYWATNY'));
let meB = await req('GET', '/api/me', { token: B });
ok('2 Dom', '/me B pokazuje tylko jego dom', meB.j.household.members.length === 1 && meB.j.household.members[0].id === Bid);
// parowanie
const inv = await req('POST', '/api/household/invite', { token: A });
ok('3 Parowanie', 'kod: 8 znaków z 32 (40 bitów), ważny 15 min', /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(inv.j.code) && Math.abs(inv.j.expires - Date.now() - 900e3) < 60e3, inv.t);
const inv2 = await req('POST', '/api/household/invite', { token: A });
ok('3 Parowanie', 'nowy kod unieważnia poprzedni', (await req('POST', '/api/household/join', { token: B, body: { code: inv.j.code } })).s === 400);
if (LOCAL) { const rows = sql('SELECT hash FROM invites'); ok('3 Parowanie', 'kod zapisany tylko jako hash', rows.length >= 1 && rows.every(r => /^[0-9a-f]{64}$/.test(r.hash)) && !JSON.stringify(rows).includes(inv2.j.code.replace('-', ''))); }
const bPlan = rid();
await req('POST', '/api/sync', { token: B, body: { plan: [{ id: bPlan, kind: 'shop', title: 'Mleko od B', updated: 2000 }] } });
const j1 = await req('POST', '/api/household/join', { token: B, body: { code: inv2.j.code.toLowerCase().replace('-', ' ') } });
ok('3 Parowanie', 'B dołącza poprawnym kodem', j1.s === 200, j1.t);
meB = await req('GET', '/api/me', { token: B });
ok('3 Parowanie', 'dom ma 2 osoby', meB.j.household.members.length === 2);
sb = await req('POST', '/api/sync', { token: B, body: { planSince: '0:', since: '0:' } });
sa = await req('POST', '/api/sync', { token: A, body: { planSince: '0:', since: '0:' } });
ok('2 Dom', 'po sparowaniu oboje widzą wspólny plan (+ zakupy B przeniesione)', sb.t.includes('PLAN-A-PRYWATNY') && sa.t.includes('Mleko od B'));
ok('1 IDOR', 'po sparowaniu pieniądze nadal prywatne', !sb.t.includes('SEKRET-A') && !sb.j.kv.some(k => k.v?.PLN === 999));
await req('POST', '/api/sync', { token: B, body: { plan: [{ id: pid, kind: 'task', title: 'PLAN-A-PRYWATNY', done: true, updated: 3000 }] } });
sa = await req('POST', '/api/sync', { token: A, body: { planSince: '0:' } });
ok('2 Dom', 'członek może odhaczyć wspólne zadanie', sa.j.plan.find(p => p.id === pid)?.done === true);
ok('3 Parowanie', 'kod jednorazowy (drugi raz nie działa)', (await req('POST', '/api/household/join', { token: A, body: { code: inv2.j.code } })).s === 400);
// ---------- 11. udostępnianie pieniędzy (opcjonalne, tylko podgląd) ----------
const pm = (t, owner) => req('POST', '/api/partner/money', { token: t, body: { owner, since: '0:' } });
await req('POST', '/api/sync', { token: A, body: { entries: [{ id: rid(), updated: 1100, data: { amount: 5, note: '<img src=x onerror=alert(1)>', type: 'exp', date: '2026-10-04', currency: 'PLN', category: 'Inne' } }] } });
const p0 = await pm(B, Aid), meA0 = await req('GET', '/api/me', { token: A }), meB0 = await req('GET', '/api/me', { token: B });
ok('11 Udostępnianie', 'domyślnie WYŁ.: B (w tym samym domu) nie widzi pieniędzy A → 403', p0.s === 403 && !p0.t.includes('SEKRET-A') && meA0.j.share === false && meB0.j.household.members.find(m => m.id === Aid)?.shares === false, p0.t);
const on1 = await req('POST', '/api/share', { token: A, body: { on: true } });
const p1 = await pm(B, Aid), meB1 = await req('GET', '/api/me', { token: B });
ok('11 Udostępnianie', 'po włączeniu przez A: B widzi wpisy i stan początkowy A', on1.s === 200 && on1.j.share === true && p1.s === 200 && p1.t.includes('SEKRET-A') && p1.j.start?.PLN === 999 && meB1.j.household.members.find(m => m.id === Aid)?.shares === true, p1.t.slice(0, 200));
ok('11 Udostępnianie', 'notatka A z <img onerror> zwracana jako tekst JSON (escapowanie w kliencie – e2e)', p1.h.get('content-type').startsWith('application/json') && p1.t.includes('<img src=x onerror'));
ok('11 Udostępnianie', 'to zgoda jednostronna: A nie widzi pieniędzy B', (await pm(A, Bid)).s === 403);
const w11 = [];
w11.push((await req('POST', '/api/sync', { token: B, body: { owner: Aid, user_id: Aid, entries: [{ id: eid, updated: 9e12, data: { note: 'B-ZMIENIA' } }, { id: eid, updated: 9e12, deleted: true }], kv: [{ k: 'start', v: { PLN: 1 }, updated: 9e12 }] } })).s);
for (const m of ['PUT', 'DELETE', 'PATCH']) w11.push((await req(m, '/api/partner/money', { token: B, body: { owner: Aid } })).s);
w11.push((await req('POST', '/api/partner/money', { token: B, body: { owner: Aid, entries: [{ id: eid, updated: 9e12, deleted: true }] } })).s);
const pa11 = await req('POST', '/api/sync', { token: A, body: { since: '0:' } });
ok('11 Udostępnianie', 'B nigdy nie zmieni ani nie usunie danych A (nawet przy włączonym podglądzie)', pa11.j.entries.find(e => e.id === eid)?.data?.note === 'SEKRET-A' && !pa11.j.entries.find(e => e.id === eid).deleted && pa11.j.kv.find(k => k.k === 'start')?.v?.PLN === 999, w11.join(','));
const ft = [];
ft.push((await req('POST', '/api/partner/money', { body: { owner: Aid } })).s);
ft.push((await req('POST', '/api/partner/money', { token: crypto.randomBytes(32).toString('base64url'), body: { owner: Aid } })).s);
ft.push((await req('POST', '/api/partner/money', { token: B.slice(0, -1) + (B.endsWith('A') ? 'B' : 'A'), body: { owner: Aid } })).s);
ft.push((await req('POST', '/api/partner/money', { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.', body: { owner: Aid } })).s);
ft.push((await req('POST', '/api/share', { token: crypto.randomBytes(32).toString('base64url'), body: { on: true } })).s);
ok('11 Udostępnianie', 'brak/podrobiony token → 401 (podgląd i przełącznik)', ft.every(s => s === 401), ft.join(','));
const odd = [await pm(B, "u_' OR 1=1 --"), await pm(B, Bid), await pm(B, ''), await pm(B, 'u_' + '0'.repeat(24))];
ok('11 Udostępnianie', 'zły/nieistniejący/własny identyfikator → 403', odd.every(r => r.s === 403), odd.map(r => r.s).join(','));
const off1 = await req('POST', '/api/share', { token: A, body: { on: false } });
const p2 = await pm(B, Aid);
ok('11 Udostępnianie', 'wyłączenie działa natychmiast (następny odczyt → 403)', off1.s === 200 && off1.j.share === false && p2.s === 403 && !p2.t.includes('SEKRET-A'));
await req('POST', '/api/share', { token: A, body: { on: true } });
await req('POST', '/api/share', { token: B, body: { on: true } });
ok('11 Udostępnianie', 'ponowne włączenie + B też udostępnia → oboje widzą', (await pm(B, Aid)).s === 200 && (await pm(A, Bid)).s === 200);
// wyjście z domu
const lv = await req('POST', '/api/household/leave', { token: B });
await req('POST', '/api/sync', { token: A, body: { plan: [{ id: rid(), kind: 'event', title: 'PO-WYJSCIU-B', due: '2026-12-01T10:00', updated: 4000 }] } });
sb = await req('POST', '/api/sync', { token: B, body: { planSince: '0:' } });
ok('2 Dom', 'po wyjściu B nie widzi nowych rzeczy domu A', lv.s === 200 && !sb.t.includes('PO-WYJSCIU-B'));
const meBl = await req('GET', '/api/me', { token: B }), pBl = await pm(B, Aid), pAl = await pm(A, Bid);
ok('11 Udostępnianie', 'nie-członek nigdy: po wyjściu B nie widzi pieniędzy A, choć A nadal udostępnia', pBl.s === 403 && !pBl.t.includes('SEKRET-A'));
ok('11 Udostępnianie', 'wyjście z domu wyłącza udostępnianie B (flaga WYŁ., A nie widzi B)', pAl.s === 403 && meBl.j.share === false);
// wygasły kod
if (LOCAL) { const i3 = await req('POST', '/api/household/invite', { token: A }); sql('UPDATE invites SET expires=1'); ok('3 Parowanie', 'wygasły kod odrzucony', (await req('POST', '/api/household/join', { token: B, body: { code: i3.j.code } })).s === 400); }
else skipT('3 Parowanie', 'wygasły kod', 'wymaga SQL (sprawdzone lokalnie)');
// brute force
const valid = await req('POST', '/api/household/invite', { token: A });
let codes = [], st429 = false;
for (let i = 0; i < 12; i++) { const r = await req('POST', '/api/household/join', { token: B, body: { code: 'ZZZZ' + String(2222 + i).slice(-4) } }); codes.push(r.s); if (r.s === 429) st429 = true; }
const f429 = codes.indexOf(429);
ok('3 Parowanie', 'zgadywanie kodów blokowane (max 10 prób/h na osobę, potem 429)', st429 && f429 > 0 && codes.slice(0, f429).every(s => s === 400) && codes.slice(f429).every(s => s === 429), codes.join(','));
ok('3 Parowanie', 'po blokadzie nawet dobry kod nie przejdzie (blokada działa)', (await req('POST', '/api/household/join', { token: B, body: { code: valid.j.code } })).s === 429);

// ---------- 4. tokeny ----------
const t4 = [];
t4.push((await req('GET', '/api/me')).s);
t4.push((await req('GET', '/api/me', { headers: { Authorization: 'Bearer ' } })).s);
t4.push((await req('GET', '/api/me', { headers: { Authorization: 'Basic ' + A } })).s);
t4.push((await req('GET', '/api/me', { token: crypto.randomBytes(32).toString('base64url') })).s);
t4.push((await req('GET', '/api/me', { token: A.slice(0, -1) + (A.endsWith('A') ? 'B' : 'A') })).s);
t4.push((await req('GET', '/api/me', { token: "x' OR '1'='1" })).s);
t4.push((await req('GET', '/api/me', { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1X2FkbWluIn0.' })).s);
ok('4 Tokeny', 'brak/zły/podrobiony/zmieniony token → 401', t4.every(s => s === 401), t4.join(','));
const recA = await req('POST', '/api/login/recover', { body: { key: regA.j.recovery } });
ok('10 Logowanie', 'klucz odzyskiwania daje nową sesję', recA.s === 200 && recA.j.token && recA.j.token !== A);
ok('10 Logowanie', 'zły klucz odzyskiwania → 401', (await req('POST', '/api/login/recover', { body: { key: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' } })).s === 401);
const lo = await req('POST', '/api/logout', { token: recA.j.token });
ok('4 Tokeny', 'po wylogowaniu token nie działa', lo.s === 200 && (await req('GET', '/api/me', { token: recA.j.token })).s === 401);
if (LOCAL) {
  const rows = sql('SELECT hash FROM sessions');
  ok('4 Tokeny', 'tokeny sesji zapisane tylko jako hash SHA-256', rows.every(r => /^[0-9a-f]{64}$/.test(r.hash)) && rows.some(r => r.hash === sha(A)) && !JSON.stringify(rows).includes(A));
  const tmp = (await req('POST', '/api/login/recover', { body: { key: regA.j.recovery } })).j.token;
  sql(`UPDATE sessions SET expires=1 WHERE hash='${sha(tmp)}'`);
  ok('4 Tokeny', 'wygasły token → 401', (await req('GET', '/api/me', { token: tmp })).s === 401);
} else skipT('4 Tokeny', 'wygasły token / hash w bazie', 'wymaga SQL (sprawdzone lokalnie)');

// ---------- 10. kody logowania + usunięcie konta ----------
if (LOCAL) sql("DELETE FROM rate WHERE k LIKE 'red:%' OR k LIKE 'mk:%'");
const lc = await req('POST', '/api/login/code', { token: A });
ok('10 Logowanie', 'kod logowania: 10 znaków (50 bitów), ważny 10 min', lc.s === 200 && /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/.test(lc.j.code) && Math.abs(lc.j.expires - Date.now() - 600e3) < 60e3, lc.t);
if (LOCAL) { const rows = sql('SELECT hash FROM login_codes'); ok('10 Logowanie', 'kod logowania zapisany tylko jako hash', rows.every(r => /^[0-9a-f]{64}$/.test(r.hash)) && rows.some(r => r.hash === sha('lc:' + lc.j.code.replace('-', ''))) && !JSON.stringify(rows).includes(lc.j.code.replace('-', ''))); }
const r1 = await req('POST', '/api/login/redeem', { body: { code: lc.j.code } });
const r2 = await req('POST', '/api/login/redeem', { body: { code: lc.j.code } });
ok('10 Logowanie', 'kod działa raz (drugi raz 401)', r1.s === 200 && r1.j.user.id === Aid && r2.s === 401, r1.s + ',' + r2.s);
if (LOCAL) { const lc2 = await req('POST', '/api/login/code', { token: A }); sql('UPDATE login_codes SET expires=1'); ok('10 Logowanie', 'wygasły kod → 401', (await req('POST', '/api/login/redeem', { body: { code: lc2.j.code } })).s === 401); }
else skipT('10 Logowanie', 'wygasły kod', 'wymaga SQL (sprawdzone lokalnie)');

// ---------- 5. CORS ----------
const c1 = await req('GET', '/api/me', { token: A, origin: null });
const c2 = await req('GET', '/api/me', { token: A, origin: EVIL });
const c3 = await fetch(BASE + '/api/sync', { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
const c4 = await fetch(BASE + '/api/sync', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
const c5 = await req('GET', '/api/me', { token: A });
ok('5 CORS', 'brak Origin → 403', c1.s === 403);
ok('5 CORS', 'obcy Origin → 403 bez nagłówka ACAO', c2.s === 403 && !c2.h.get('access-control-allow-origin'));
ok('5 CORS', 'obcy preflight → 403', c3.status === 403 && !c3.headers.get('access-control-allow-origin'));
ok('5 CORS', 'dozwolony Origin: dokładne ACAO, bez *, bez credentials', c4.status === 204 && c4.headers.get('access-control-allow-origin') === ORIGIN && /authorization/i.test(c4.headers.get('access-control-allow-headers')) && !c4.headers.get('access-control-allow-credentials') && c5.h.get('access-control-allow-origin') === ORIGIN);
ok('5 CORS', 'odpowiedzi: no-store + nosniff', c5.h.get('cache-control') === 'no-store' && c5.h.get('x-content-type-options') === 'nosniff');

// ---------- 6. limity ----------
async function burst(n, fn) { const s = []; for (let i = 0; i < n; i++) s.push((await fn(i)).s); return s; }
let s6 = await burst(11, () => req('POST', '/api/login/recover', { body: { key: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' } }));
ok('6 Limity', 'logowanie kluczem: max 10/h z IP, potem 429', s6.includes(429) && s6.indexOf(429) >= 7 && s6.slice(0, s6.indexOf(429)).every(s => s === 401) && s6.slice(s6.indexOf(429)).every(s => s === 429), s6.join(','));
s6 = await burst(11, () => req('POST', '/api/login/redeem', { body: { code: 'AAAAA-BBBBB' } }));
ok('6 Limity', 'logowanie kodem: max 10/10 min z IP, potem 429', s6.includes(429) && s6.indexOf(429) >= 6 && s6.slice(0, s6.indexOf(429)).every(s => s === 401) && s6.slice(s6.indexOf(429)).every(s => s === 429), s6.join(','));
s6 = await burst(16, () => req('POST', '/api/parse', { token: A, body: { text: '' } }));
ok('6 Limity', 'Gemini /parse: 429 po 15/min', s6.indexOf(429) === 15, s6.join(','));
s6 = await burst(7, () => req('POST', '/api/where', { token: A, body: { q: '' } }));
ok('6 Limity', 'Gemini /where: 429 po 6/min', s6.indexOf(429) === 6, s6.join(','));
s6 = await burst(7, () => req('POST', '/', { token: A, body: { images: [] } }));
ok('6 Limity', 'Gemini paragon (z kontem): 429 po 6/min na osobę', s6.indexOf(429) === 6 && s6.slice(0, 6).every(s => s === 400), s6.join(','));
if (LOCAL) {
  sql("DELETE FROM rate WHERE k LIKE 'rec:%' OR k LIKE 'fail:%'");
  const v6 = await burst(11, i => req('POST', '/api/login/recover', { body: { key: 'x' }, headers: { 'CF-Connecting-IP': '2001:db8:1:2:' + (i + 1).toString(16) + '::' + i } }));
  ok('6 Limity', 'IPv6: limit liczony na całą sieć /64 (zmiana adresu nie pomaga)', v6.indexOf(429) === 10, v6.join(','));
  const many = await burst(105, i => req('POST', '/api/login/recover', { body: { key: 'x' }, headers: { 'CF-Connecting-IP': '10.77.' + (i >> 8) + '.' + (i & 255) } }));
  ok('6 Limity', 'globalny bezpiecznik: >100 nieudanych logowań/h z wielu IP → 429 dla wszystkich', many.slice(0, 90).every(s => s === 401) && many.slice(-3).every(s => s === 429), many.slice(95).join(','));
  sql("DELETE FROM rate WHERE k LIKE 'rec:%' OR k LIKE 'fail:%'");
}
ok('6 Limity', 'rejestracja: max 10 prób/h z jednego IP (sprawdzone w sekcji 12)', b429 >= 0);
s6 = await burst(11, () => req('POST', '/api/login/code', { token: B }));
ok('6 Limity', 'tworzenie kodów logowania: 429 po 10/h', s6.indexOf(429) === 10, s6.join(','));

// ---------- 7. XSS ----------
const xs = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const x1 = await req('POST', '/api/sync', { token: A, body: { plan: [{ id: rid(), kind: 'shop', title: xs, notes: xs, updated: 5000 }] } });
ok('7 XSS', 'API zwraca JSON (application/json, nosniff) – nie HTML', x1.h.get('content-type').startsWith('application/json') && x1.h.get('x-content-type-options') === 'nosniff');
const meA = await req('GET', '/api/me', { token: A });
ok('7 XSS', 'dane zwracane jako tekst JSON (renderowanie escapowane w kliencie – testy client.mjs)', meA.j.user.name.includes('<img'));
const bad = await req('POST', '/api/sync', { token: A, body: { plan: [{ id: '<x>', kind: 'task', title: 'a', updated: 1 }, { id: rid(), kind: '<script>', title: 'a', updated: 1 }, { id: rid(), kind: 'task', title: 'a', due: 'javascript:alert(1)', updated: 1 }] } });
sa = await req('POST', '/api/sync', { token: A, body: { planSince: '0:' } });
ok('7 XSS', 'złe id/rodzaj/data odrzucane przez walidację', bad.s === 200 && !sa.t.includes('<x>') && !sa.t.includes('"<script>"') && !sa.t.includes('javascript:'));

// ---------- 8. SQLi ----------
const inj = ["' OR 1=1 --", '"; DROP TABLE users; --', "1' UNION SELECT data FROM entries --", "x'||(SELECT hash FROM sessions)||'"];
const s8 = [];
for (const p of inj) {
  s8.push((await req('POST', '/api/sync', { token: B, body: { since: p, planSince: p, entries: [{ id: p, updated: 1, data: {} }], kv: [{ k: p, v: 1, updated: 1 }], plan: [{ id: rid(), kind: 'task', title: p, notes: p, updated: 6000 }] } })));
  s8.push(await req('POST', '/api/household/join', { token: A, body: { code: p } }));
  s8.push(await req('POST', '/api/login/redeem', { body: { code: p }, headers: LOCAL ? { 'CF-Connecting-IP': '10.9.9.' + s8.length } : {} }));
}
ok('8 SQLi', 'brak błędów 500 przy wstrzyknięciach', s8.every(r => r.s !== 500), s8.map(r => r.s).join(','));
ok('8 SQLi', 'brak wycieku cudzych danych', s8.every(r => !r.t.includes('SEKRET-A')));
const meA2 = await req('GET', '/api/me', { token: A });
ok('8 SQLi', 'tabele nienaruszone (konta działają)', meA2.s === 200 && (await req('GET', '/api/me', { token: B })).s === 200);
sb = await req('POST', '/api/sync', { token: B, body: { planSince: '0:' } });
ok('8 SQLi', 'payload zapisany dosłownie jako tekst (zapytania z parametrami)', sb.j.plan.some(p => p.title === inj[1]));
const src = fs.readFileSync(new URL('../proxy/worker.js', import.meta.url), 'utf8');
const dyn = [...src.matchAll(/prepare\(`[^`]*\$\{([^}]*)\}/g)].map(m => m[1]);
ok('8 SQLi', 'kod: jedyna interpolacja w SQL to stała LIMIT', dyn.every(d => d === 'LIMIT'), dyn.join(','));

// ---------- 9. sekrety ----------
const key = process.env.GEMINI_API_KEY || '';
const root = new URL('..', import.meta.url).pathname;
const walk = d => fs.readdirSync(root + d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name === '.git' || e.name === '.wrangler' ? [] : e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]);
const files = walk('');
const leaks = [];
for (const f of files) { let c; try { c = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'); } catch { continue; }
  if (/AIza[0-9A-Za-z_-]{30,}/.test(c) || (key && c.includes(key)) || /BEGIN (EC |RSA )?PRIVATE KEY/.test(c) || /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/.test(c)) leaks.push(f); }
ok('9 Sekrety', `repo (${files.length} plików): brak kluczy API/prywatnych`, leaks.length === 0, leaks.join(','));
const live = process.env.APP || 'https://tazo88.github.io/wydatki-app/';
const liveLeaks = [];
for (const f of ['', 'index.html', 'app.js', 'receipt.js', 'help.js', 'sync.js', 'plan.js', 'sw.js']) {
  const r = await fetch(live + f); const c = await r.text();
  if (/AIza[0-9A-Za-z_-]{30,}/.test(c) || (key && c.includes(key)) || /PRIVATE KEY/.test(c)) liveLeaks.push(f || '/'); }
ok('9 Sekrety', 'aplikacja online: brak kluczy w plikach klienta', liveLeaks.length === 0, liveLeaks.join(','));
const pk = await req('GET', '/api/push/key');
ok('9 Sekrety', 'klucz VAPID: publicznie tylko klucz publiczny (65 B)', pk.s === 200 && Buffer.from(pk.j.key, 'base64url').length === 65 && Object.keys(pk.j).length === 1);
const allBodies = [regA.t, regB.t, sa.t, sb.t, meA.t, pk.t].join('');
ok('9 Sekrety', 'odpowiedzi API nie zawierają klucza Gemini', !(key && allBodies.includes(key)) && !/AIza/.test(allBodies));

// ---------- push (lokalnie: odszyfrowanie + podpis VAPID) ----------
if (LOCAL) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const authS = crypto.randomBytes(16);
  const got = [];
  const srv = http.createServer((q, s) => { const ch = []; q.on('data', c => ch.push(c)); q.on('end', () => { got.push({ h: q.headers, b: Buffer.concat(ch) }); s.writeHead(201); s.end(); }); }).listen(9911, '127.0.0.1');
  // A i B znów razem, B zapisuje push, A dodaje termin z przypomnieniem
  sql("DELETE FROM rate WHERE k LIKE 'join%'");
  const i4 = await req('POST', '/api/household/invite', { token: A });
  await req('POST', '/api/household/join', { token: B, body: { code: i4.j.code } });
  const sub = await req('POST', '/api/push/subscribe', { token: B, body: { endpoint: 'http://127.0.0.1:9911/push/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authS.toString('base64url') }, tz: 'Europe/Brussels' } });
  const evil = await req('POST', '/api/push/subscribe', { token: B, body: { endpoint: 'https://169.254.169.254/latest', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authS.toString('base64url') } } });
  ok('push', 'subskrypcja OK, obcy adres (SSRF) odrzucony', sub.s === 200 && evil.s === 400, sub.t + evil.t);
  await req('POST', '/api/sync', { token: A, body: { plan: [{ id: rid(), kind: 'event', title: 'Dentysta', due: '2026-10-04T15:00', remind_at: Date.now() - 1000, updated: 7000 }] } });
  let sc = await fetch(BASE + '/cdn-cgi/handler/scheduled'); if (sc.status === 404) sc = await fetch(BASE + '/__scheduled');
  await new Promise(r => setTimeout(r, 1500));
  srv.close();
  let dec = null, jwtOk = false;
  if (got[0]) {
    const b = got[0].b, salt = b.subarray(0, 16), idlen = b[20], asPub = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
    const secret = ecdh.computeSecret(asPub);
    const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const ikm = hm(hm(authS, secret), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPub, Buffer.from([1])]));
    const prk = hm(salt, ikm), cek = hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]); dec = JSON.parse(pt.subarray(0, pt.length - 1).toString());
    const m = /vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)/.exec(got[0].h.authorization);
    const pub = Buffer.from(m[4], 'base64url'); const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
    jwtOk = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))
      && JSON.parse(Buffer.from(m[2], 'base64url')).aud === 'http://127.0.0.1:9911' && m[4] === pk.j.key;
  }
  ok('push', 'przypomnienie dotarło do partnera, zaszyfrowane (RFC 8291) i odszyfrowane', dec && dec.title.includes('Dentysta') && dec.body.includes('15:00'), JSON.stringify(dec) + ' n=' + got.length);
  ok('push', 'podpis VAPID ES256 poprawny', jwtOk);
}

// ---------- Gemini działa (2 prawdziwe zapytania) ----------
if (process.env.GEMINI_LIVE !== '0') {
  if (LOCAL) sql("DELETE FROM rate WHERE k LIKE 'pm:%' OR k LIKE 'wm:%'"); else await new Promise(r => setTimeout(r, 61000));
  const pr = await req('POST', '/api/parse', { token: A, body: { text: 'jutro o 15 dentysta, kup mleko i chleb, Biedronka 45 zł', now: '2026-10-04T11:00', cats: [], incCats: [] } });
  const k = (pr.j?.items || []).map(i => i.kind);
  ok('AI', 'parsowanie tekstu: termin + 2 zakupy + wydatek', pr.s === 200 && k.includes('event') && k.filter(x => x === 'shop').length === 2 && k.includes('expense') && pr.j.items.find(i => i.kind === 'event').due === '2026-10-05T15:00', pr.t.slice(0, 400));
  const wh = await req('POST', '/api/where', { token: A, body: { q: 'filtr do wody Brita Maxtra', place: 'Bruksela' } });
  ok('AI', '„Gdzie kupić?”: odpowiedź + linki https (' + (wh.j?.grounded ? 'z wyszukiwania Google' : 'bez wyszukiwania Google – brak w darmowym planie; linki Maps/Zakupy/sklepy') + ')', wh.s === 200 && wh.j.text.length > 20 && wh.j.links.length > 0 && wh.j.links.every(l => l.url.startsWith('https://')), wh.t.slice(0, 300));
}

// ---------- 10. usunięcie konta ----------
if (LOCAL) ok('11 Udostępnianie', '(znów razem) B widzi pieniądze A przed usunięciem konta', (await pm(B, Aid)).s === 200);
for (const [t, n] of users) {
  const d = await req('DELETE', '/api/account', { token: t });
  ok('10 Konto', `usunięcie konta ${n}: token przestaje działać`, d.s === 200 && (await req('GET', '/api/me', { token: t })).s === 401);
  if (LOCAL && n === 'A') ok('11 Udostępnianie', 'usunięcie konta A od razu wyłącza podgląd u B', (await pm(B, Aid)).s === 403);
}
if (LOCAL) {
  const left = sql(`SELECT (SELECT COUNT(*) FROM users WHERE id IN ('${Aid}','${Bid}')) u, (SELECT COUNT(*) FROM entries WHERE user_id IN ('${Aid}','${Bid}')) e, (SELECT COUNT(*) FROM user_kv WHERE user_id IN ('${Aid}','${Bid}')) k, (SELECT COUNT(*) FROM sessions WHERE user_id IN ('${Aid}','${Bid}')) s, (SELECT COUNT(*) FROM push_subs WHERE user_id IN ('${Aid}','${Bid}')) p, (SELECT COUNT(*) FROM members WHERE user_id IN ('${Aid}','${Bid}')) m, (SELECT COUNT(*) FROM login_codes WHERE user_id IN ('${Aid}','${Bid}')) c, (SELECT COUNT(*) FROM shares WHERE owner_id IN ('${Aid}','${Bid}')) sh`)[0];
  ok('10 Konto', 'po usunięciu: 0 wierszy użytkowników w bazie', Object.values(left).every(v => v === 0), JSON.stringify(left));
}
console.log(`\n${pass}/${pass + failN} PASS${skip ? `, ${skip} pominięte (live)` : ''}`);
fs.writeFileSync('/tmp/api-ids.json', JSON.stringify({ Aid, Bid }));
process.exit(failN ? 1 : 0);
