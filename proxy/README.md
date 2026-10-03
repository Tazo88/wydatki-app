# Proxy paragonów (Cloudflare Worker)

Przyjmuje `POST` z JSON `{images:[{mime,data(base64)}], categories:[...]}` od https://tazo88.github.io,
woła Gemini (structured JSON) i zwraca: shop, country, date, currency, total, vat[], items[{name,qty,price,category}], check{itemsSum,total,diff,matches}.

Ochrona: tylko Origin tazo88.github.io (CORS), limit 6 MB, max 4 zdjęcia, prosty limit zapytań na IP.

Wdrożenie:
```
npx wrangler deploy
npx wrangler secret put GEMINI_API_KEY
```
Opcjonalnie zmienna `MODEL` (domyślnie gemini-3.5-flash, zapasowy gemini-flash-latest).
