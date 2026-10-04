// Test end-to-end: dwie osoby (A i B) + drugie urządzenie A, w osobnych profilach przeglądarki.
// Lokalnie: APP=http://localhost:8765/ API_LOCAL=http://127.0.0.1:8811 node tests/e2e.mjs
// Live:     APP=https://tazo88.github.io/wydatki-app/ node tests/e2e.mjs
import { createRequire } from 'module';
const require = createRequire(process.env.TOOLS || import.meta.url);
const p = require('puppeteer-core');
const APP = process.env.APP || 'http://localhost:8765/', LOCAL = process.env.API_LOCAL, WORKER = 'https://wydatki-receipt.tazo88.workers.dev';
let pass = 0, failN = 0; const ok = (n, c, i = '') => { c ? pass++ : failN++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && i ? ' — ' + i : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await p.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [], csp = [];
process.on('unhandledRejection', e => { console.log('ERRS', errs, csp); console.log(e); process.exit(1); });
async function open(label) {
  const ctx = await b.createBrowserContext(); const pg = await ctx.newPage();
  pg.on('pageerror', e => errs.push(label + ': ' + e.message)); pg.on('dialog', d => { if (d.type() === 'alert') errs.push(label + ' alert: ' + d.message()); d.accept(); });
  pg.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(label + ': ' + m.text()); });
  if (LOCAL) {
    await pg.setRequestInterception(true);
    pg.on('request', async rq => {
      if (!rq.url().startsWith(WORKER)) return rq.continue();
      try { const h = { ...rq.headers() }; const r = await fetch(LOCAL + rq.url().slice(WORKER.length), { method: rq.method(), headers: h, body: ['GET', 'HEAD', 'OPTIONS'].includes(rq.method()) ? undefined : rq.postData() });
        const hh = {}; r.headers.forEach((v, k) => hh[k] = v); rq.respond({ status: r.status, headers: hh, body: Buffer.from(await r.arrayBuffer()) }); } catch (e) { rq.abort(); }
    });
  }
  await pg.goto(APP, { waitUntil: 'networkidle0' });
  await pg.evaluate(() => window.__help && window.__help.close());
  return pg;
}
const XA = '<img src=x onerror="window.__pwn=1">Kamil';
const A = await open('A'), B = await open('B');
// 1. rejestracja A (imię z XSS)
await A.evaluate(() => showTab('set'));
await A.type('#aName', XA); await A.$eval('#aReg', e => e.click());
await A.waitForSelector('.acc-key code', { timeout: 15000 });
const rec = await A.$eval('.acc-key code', e => e.textContent);
ok('A: konto założone, klucz odzyskiwania pokazany', /^[2-9A-Z]{4}(-[2-9A-Z]{4}){5}$/.test(rec));
ok('A: imię z <img onerror> pokazane jako tekst (XSS nie działa)', await A.evaluate(() => window.__pwn === undefined && document.querySelector('#acct').innerText.includes('<img src=x')));
await A.evaluate(async () => { await putExp({ id: 'privA1', type: 'exp', amount: 33.3, currency: 'PLN', category: 'Jedzenie', note: 'PRYWATNE-A', date: ymd(new Date()), photo: null, created: Date.now() }); await WY.sync(); });
// 2. zaproszenie
await A.$eval('#aInvite', e => e.click()); await A.waitForSelector('#invOut code');
const code = await A.$eval('#invOut code', e => e.textContent);
ok('A: kod zaproszenia XXXX-XXXX', /^[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(code), code);
// 3. B zakłada konto i dołącza
await B.evaluate(() => showTab('set'));
await B.type('#aName', 'Ania'); await B.$eval('#aReg', e => e.click()); await B.waitForSelector('#aJoin', { timeout: 15000 });
await B.type('#aJoin', code); await B.$eval('#aJoinBtn', e => e.click());
await B.waitForFunction(() => WY.members().length === 2, { timeout: 15000 }).catch(() => {});
ok('B: dołączyła, widzi członka domu', await B.evaluate(() => WY.members().length === 2 && document.querySelector('#acct').innerText.includes('<img src=x')));
// 4. A dodaje termin (XSS w tytule) i zakupy przez AI
await A.evaluate(() => { WY.sync(); showTab('plan'); });
const tom = await A.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); });
await A.evaluate(() => document.querySelector('#pform').open = true);
await A.select('#pkind', 'event'); await A.type('#ptitle', '<svg onload="window.__pwn=2">Dentysta');
await A.$eval('#pdate', (e, v) => e.value = v, tom); await A.$eval('#ptime', e => e.value = '15:00'); await A.select('#prem', '60');
await A.$eval('#psave', e => e.click());
await A.type('#pq', 'kup mleko i chleb'); await A.$eval('#padd', e => e.click());
await A.waitForFunction(() => /Dodano|⚠️|Nie zrozumiałam/.test(document.querySelector('#pinfo').textContent), { timeout: 30000 }).catch(() => {});
const ai = await A.evaluate(() => ({ info: document.querySelector('#pinfo').textContent, shop: WY.plan.all().filter(x => x.kind === 'shop').map(x => x.title) }));
ok('AI: „kup mleko i chleb” → 2 pozycje zakupów', ai.shop.length === 2 && ai.shop.some(t => /mleko/i.test(t)) && ai.shop.some(t => /chleb/i.test(t)), JSON.stringify(ai));
const ev = await A.evaluate(() => WY.plan.all().find(x => x.kind === 'event'));
ok('Termin: przypomnienie 1 h przed', ev && ev.remind_at === new Date(ev.due).getTime() - 3600e3, JSON.stringify(ev));
await A.evaluate(() => WY.sync()); await sleep(1500);
// 5. B widzi wspólny plan, nie widzi pieniędzy A
await B.evaluate(async () => { await WY.sync(); showTab('plan'); __plan.render(); });
const bv = await B.evaluate(async () => ({ txt: document.querySelector('#tab-plan').innerText, pwn: window.__pwn, money: (await allExp()).map(e => e.note) }));
ok('B: widzi wspólny termin i zakupy (z „od: …”)', bv.txt.includes('Dentysta') && /mleko/i.test(bv.txt) && bv.txt.includes('od: <img src=x'), bv.txt.slice(0, 300));
ok('B: tytuł z <svg onload> jako tekst (XSS nie działa)', bv.pwn === undefined && bv.txt.includes('<svg onload'));
ok('B: NIE widzi pieniędzy A (prywatne)', !bv.money.includes('PRYWATNE-A'));
// 6. B odhacza mleko → A widzi
await B.evaluate(() => { const it = WY.plan.all().find(x => /mleko/i.test(x.title)); document.querySelector(`li[data-id="${it.id}"] .pchk`).click(); });
await sleep(2500); await A.evaluate(() => WY.sync()); await sleep(1500);
ok('A: widzi, że B kupiła mleko', await A.evaluate(() => WY.plan.all().find(x => /mleko/i.test(x.title))?.done === true));
// 7. .ics
const icsTxt = await A.evaluate(() => __plan.ics(WY.plan.all().find(x => x.kind === 'event')));
ok('.ics: termin z alarmem 60 min', /BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T150000[\s\S]*TRIGGER:-PT60M/.test(icsTxt) && icsTxt.includes('SUMMARY:<svg onload="window.__pwn=2">Dentysta'));
// 8. Gdzie kupić?
await B.evaluate(() => { const it = WY.plan.all().find(x => /chleb/i.test(x.title)); document.querySelector(`li[data-id="${it.id}"] [data-act=where]`).click(); });
await B.waitForSelector('#wout a', { timeout: 40000 }).catch(() => {});
const links = await B.$$eval('#wout a', as => as.map(a => ({ h: a.href, rel: a.rel, t: a.target })));
ok('„Gdzie kupić?”: linki https, otwierane bezpiecznie (noopener)', links.length > 0 && links.every(l => l.h.startsWith('https://') && /noopener/.test(l.rel) && l.t === '_blank'), JSON.stringify(links).slice(0, 300));
await B.evaluate(() => document.querySelector('#wclose') && document.querySelector('#wclose').click());
// 9. drugie urządzenie A (kod logowania) – pieniądze A synchronizują się
await A.evaluate(() => showTab('set')); await A.$eval('#aCodeBtn', e => e.click()); await A.waitForSelector('#codeOut code');
const lcode = await A.$eval('#codeOut code', e => e.textContent);
const C = await open('C'); await C.evaluate(() => showTab('set'));
await C.evaluate(() => document.querySelector('#acct details').open = true);
await C.type('#aCode', lcode); await C.$eval('#aRedeem', e => e.click());
await C.waitForFunction(async () => (await allExp()).some(e => e.note === 'PRYWATNE-A'), { timeout: 15000 }).catch(() => {});
ok('Drugie urządzenie A: logowanie kodem + pieniądze A zsynchronizowane', await C.evaluate(async () => WY.loggedIn() && (await allExp()).some(e => e.note === 'PRYWATNE-A') && WY.plan.all().some(x => x.kind === 'event')));
// usunięcie wydatku na C → znika na A
await C.evaluate(async () => { await delExp('privA1'); await WY.sync(); }); await A.evaluate(() => WY.sync()); await sleep(1500);
ok('Usunięcie na jednym urządzeniu usuwa na drugim', await A.evaluate(async () => !(await allExp()).some(e => e.id === 'privA1')));
// 10. usunięcie kont przez UI
for (const [pg, n] of [[A, 'A'], [B, 'B']]) { await pg.evaluate(() => showTab('set')); await pg.$eval('#aDel', e => e.click()); await pg.waitForSelector('#aReg', { timeout: 15000 }).catch(() => {}); ok(`${n}: konto usunięte (wylogowane)`, await pg.evaluate(() => !WY.loggedIn())); }
await C.evaluate(() => WY.sync().catch(() => {})); await sleep(1500);
ok('C (sesja usuniętego konta) zostaje wylogowane', await C.evaluate(() => !WY.loggedIn()));
ok('Brak błędów JS', errs.length === 0, errs.join(' | '));
ok('Brak naruszeń CSP', csp.length === 0, csp.join(' | ').slice(0, 300));
await b.close();
console.log(`\n${pass}/${pass + failN} PASS`); process.exit(failN ? 1 : 0);
