// Wydatki – proxy do odczytu paragonów przez Gemini (Cloudflare Worker).
// Klucz API tylko jako secret GEMINI_API_KEY (nigdy w repo / w aplikacji).
const ALLOWED_ORIGINS = ['https://tazo88.github.io'];
const MAX_BODY = 6 * 1024 * 1024;          // 6 MB łącznie (zdjęcia w base64)
const MAX_IMAGES = 4;
const RATE = { perMin: 6, perDay: 60 };    // na IP, w obrębie instancji (best effort)
const DEFAULT_CATS = ['Jedzenie','Zakupy/dom','Transport/paliwo','Rachunki','Zdrowie','Dzieci','Rozrywka','Ubrania','Inne'];
const hits = new Map();

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(origin ? cors(origin) : {}) } });

function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.day > 86400000) h = { day: now, dayN: 0, min: now, minN: 0 };
  if (now - h.min > 60000) { h.min = now; h.minN = 0; }
  h.minN++; h.dayN++; hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.minN > RATE.perMin || h.dayN > RATE.perDay;
}

function prompt(cats) {
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

function schema(cats) {
  return {
    type: 'OBJECT',
    properties: {
      shop: { type: 'STRING' },
      country: { type: 'STRING' },
      date: { type: 'STRING' },
      currency: { type: 'STRING' },
      total: { type: 'NUMBER' },
      vat: { type: 'ARRAY', items: { type: 'OBJECT', properties: { rate: { type: 'STRING' }, base: { type: 'NUMBER' }, amount: { type: 'NUMBER' } }, required: ['rate', 'amount'] } },
      items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'NUMBER' }, price: { type: 'NUMBER' }, category: { type: 'STRING', enum: cats } }, required: ['name', 'price', 'category'] } },
    },
    required: ['shop', 'currency', 'total', 'items'],
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED_ORIGINS.includes(origin) || (env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
    if (req.method === 'OPTIONS') return ok ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    if (req.method === 'GET') return json({ ok: true, service: 'wydatki-receipt' }, 200, ok ? origin : null);
    if (!ok) return json({ error: 'forbidden' }, 403);
    if (req.method !== 'POST') return json({ error: 'method' }, 405, origin);
    const len = +req.headers.get('Content-Length') || 0;
    if (len > MAX_BODY) return json({ error: 'too_large' }, 413, origin);
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    if (limited(ip)) return json({ error: 'rate_limited' }, 429, origin);
    if (!env.GEMINI_API_KEY) return json({ error: 'not_configured' }, 500, origin);

    let body;
    try { const t = await req.text(); if (t.length > MAX_BODY) return json({ error: 'too_large' }, 413, origin); body = JSON.parse(t); }
    catch { return json({ error: 'bad_json' }, 400, origin); }
    const imgs = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
      .filter(i => i && typeof i.data === 'string' && /^image\/(jpeg|png|webp|heic|heif)$/.test(i.mime || ''));
    if (!imgs.length) return json({ error: 'no_image' }, 400, origin);
    const custom = (Array.isArray(body.categories) ? body.categories : []).filter(c => typeof c === 'string' && c.length <= 40).slice(0, 40);
    const cats = [...new Set([...DEFAULT_CATS, ...custom])];

    const model = env.MODEL || 'gemini-3.5-flash';
    const gReq = {
      contents: [{ role: 'user', parts: [...imgs.map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: prompt(cats) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema(cats), temperature: 0 },
    };
    // model główny, a przy przeciążeniu (429/5xx) zapasowy
    let r, d;
    for (const m of [...new Set([model, env.FALLBACK_MODEL || 'gemini-flash-latest'])]) {
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(gReq),
        });
        d = await r.json();
      } catch (e) { r = null; }
      if (r && r.ok) break;
      if (r && !(r.status === 429 || r.status >= 500)) break;
    }
    if (!r || !r.ok) return json({ error: 'upstream', status: r ? r.status : 0, message: String(d?.error?.message || '').slice(0, 200) }, 502, origin);
    let out;
    try { out = JSON.parse(d.candidates[0].content.parts.map(p => p.text || '').join('')); }
    catch { return json({ error: 'parse' }, 502, origin); }

    const r2 = n => Math.round((+n || 0) * 100) / 100;
    out.items = (out.items || []).map(i => ({ name: String(i.name || '').slice(0, 80), qty: +i.qty || 1, price: r2(i.price), category: cats.includes(i.category) ? i.category : 'Inne' }));
    out.total = r2(out.total);
    out.currency = String(out.currency || '').toUpperCase().slice(0, 3);
    const sum = r2(out.items.reduce((s, i) => s + i.price, 0));
    out.check = { itemsSum: sum, total: out.total, diff: r2(out.total - sum), matches: Math.abs(out.total - sum) <= 0.05 };
    out.model = d.modelVersion || model;
    return json(out, 200, origin);
  },
};
