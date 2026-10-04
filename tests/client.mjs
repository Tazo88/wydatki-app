// Testy bezpieczeństwa klienta (XSS, import kopii, CSV, CSP, usuwanie danych).
// Użycie: APP=http://localhost:8765/ node tests/client.mjs   (wymaga puppeteer-core + Chrome)
import { createRequire } from 'module';
const require = createRequire(process.env.TOOLS || import.meta.url);
const p = require('puppeteer-core');
const APP = process.env.APP || 'http://localhost:8765/';
const results = []; const ok = (name, pass, info = '') => { results.push({ name, pass }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); };
const XSS = ['<img src=x onerror="window.__pwn=1">', '<script>window.__pwn=2</script>', '"><svg onload="window.__pwn=3">', "'-alert(1)-'"];
const b = await p.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const pg = await b.newPage(); const errs = [], csp = [];
pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => d.accept());
pg.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
await pg.goto(APP, { waitUntil: 'networkidle0' });
await pg.evaluate(() => window.__help && window.__help.close());
// 1) XSS w notatkach, kategoriach, źródłach
await pg.evaluate(async (X) => {
  for (const s of X) { cats.splice(cats.length - 1, 0, s); incCats.push(s); }
  saveCats(); renderCats();
  let i = 0; for (const s of X) { await putExp({ id: 'x' + i, type: i % 2 ? 'inc' : 'exp', amount: 1, currency: 'PLN', category: s, note: s, date: ymd(new Date()), created: Date.now() + i }); i++; }
  await refresh(); showTab('rep'); showTab('set'); showTab('add');
}, XSS);
await new Promise(r => setTimeout(r, 500));
ok('XSS: payloady w notatce/kategorii/źródle nie wykonują się', await pg.evaluate(() => window.__pwn === undefined));
ok('XSS: payload widoczny jako tekst', await pg.evaluate(() => document.body.innerText.includes('<img src=x onerror=')));
// 2) Złośliwa kopia zapasowa
const evil = { app: 'wydatki', expenses: [
  { id: '"><img src=x onerror=window.__pwn=4>', amount: 5, date: '2026-10-01' },
  { id: 'ok1', amount: 5, date: '2026-10-01', photo: 'x" onerror="window.__pwn=5', category: '<img src=x onerror=window.__pwn=6>', currency: '<b>' },
  { id: 'ok2', amount: 'abc', date: '2026-10-01' }], incomes: [{ id: 'ok3', amount: 7, date: '2026-10-01', type: 'zzz' }],
  cats: ['<img src=x onerror=window.__pwn=7>', { a: 1 }], start: { PLN: '<script>', EUR: 3 } };
const fs = await import('fs'); fs.writeFileSync('/tmp/evil.json', JSON.stringify(evil));
const inp = await pg.$('#restore'); await inp.uploadFile('/tmp/evil.json');
await new Promise(r => setTimeout(r, 800)); await pg.evaluate(() => { showTab('rep'); showTab('set'); showTab('add'); });
const imp = await pg.evaluate(() => ({ pwn: window.__pwn, ids: expenses.map(e => e.id), ok1: expenses.find(e => e.id === 'ok1'), ok3: expenses.find(e => e.id === 'ok3'), start: localStorage.getItem('start') }));
ok('Import: złe id odrzucone', !imp.ids.some(i => i.includes('<')));
ok('Import: zła kwota odrzucona', !imp.ids.includes('ok2'));
ok('Import: zdjęcie spoza data:image usunięte', imp.ok1 && imp.ok1.photo === null);
ok('Import: waluta znormalizowana', imp.ok1 && imp.ok1.currency === 'PLN');
ok('Import: wpływ z kopii ma type=inc', imp.ok3 && imp.ok3.type === 'inc');
ok('Import: stan początkowy tylko liczby', imp.start === '{"PLN":0,"EUR":3}');
ok('Import: brak wykonania skryptu', imp.pwn === undefined);
// 3) Ekran paragonu z AI – złośliwe dane z serwera
await pg.evaluate(() => window.__rcpt.open({ shop: '<img src=x onerror=window.__pwn=8>', currency: 'EUR"><script>window.__pwn=9</script>', total: 3, date: '"><img src=x onerror=window.__pwn=10>', items: [{ name: '<img src=x onerror=window.__pwn=11>', price: 3, category: '<b>x</b>' }] }));
await new Promise(r => setTimeout(r, 400));
ok('Paragon AI: dane z serwera renderowane jako tekst', await pg.evaluate(() => window.__pwn === undefined && document.getElementById('rShop').value.startsWith('<img')));
await pg.evaluate(() => document.getElementById('rCancel').click());
// 4) CSV formula injection
const csvOut = await pg.evaluate(() => csv([{ date: '2026-10-01', type: 'exp', amount: 1, currency: 'PLN', category: '=1+1', note: '@SUM(A1)' }, { date: '2026-10-01', type: 'exp', amount: 2, currency: 'PLN', category: 'Inne', note: '-5 zł' }]));
ok('CSV: komórki zaczynające się od = @ - są neutralizowane', csvOut.includes(";'=1+1;'@SUM(A1)") && csvOut.includes("'-5 zł"));
// 5) CSP obecny i nie blokuje aplikacji
ok('CSP: meta Content-Security-Policy obecny', await pg.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));
ok('CSP: inline <script> zablokowany', await pg.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inl=1'; document.body.appendChild(s); return window.__inl === undefined; }));
// 6) OCR (Tesseract z CDN) działa przy CSP
await pg.evaluate(() => { window.__ocrOnly = true; });
await pg.setRequestInterception(true);
pg.on('request', r => r.url().includes('workers.dev') && r.method() === 'POST' ? r.abort('connectionrefused') : r.continue());
const ph = await pg.$('#photo'); await ph.uploadFile(process.env.RECEIPT || '/workspace/wtools/be.jpg');
await pg.waitForFunction(() => /Znaleziona|Nie znalaz|nie uda/.test(document.querySelector('#status').textContent), { timeout: 150000 }).catch(() => {});
const st = await pg.$eval('#status', e => e.textContent);
ok('CSP: zapasowy odczyt Tesseract działa', /Znaleziona suma: 40,83/.test(st), st.slice(0, 80));
// 7) Usuń wszystkie dane
await pg.evaluate(() => document.getElementById('wipeBtn').click());
await new Promise(r => setTimeout(r, 2500));
const after = await pg.evaluate(async () => ({ n: (await allExp()).length, ls: localStorage.length }));
ok('Usuń dane: IndexedDB i localStorage puste', after.n === 0 && after.ls <= 1, JSON.stringify(after));
ok('Brak błędów JS', errs.length === 0, errs.join(' | '));
ok('Brak naruszeń CSP poza testem inline', csp.filter(c => !/inline/i.test(c)).length === 0, csp.join(' | ').slice(0, 300));
await b.close();
const failed = results.filter(r => !r.pass).length; console.log(`\n${results.length - failed}/${results.length} PASS`); process.exit(failed ? 1 : 0);
