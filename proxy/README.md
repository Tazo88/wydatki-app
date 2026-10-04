# Backend Wydatki (Cloudflare Worker + D1)

Jeden worker `wydatki-receipt` (https://wydatki-receipt.tazo88.workers.dev):

- `POST /` – odczyt paragonu przez Gemini (bez konta, limit 6/min i 60/dzień na IP).
- `/api/*` – konta, synchronizacja, wspólny dom, Plan, przypomnienia push, AI (`/api/parse`, `/api/where`).

Bezpieczeństwo:
- Klucz Gemini tylko jako secret `GEMINI_API_KEY` (nigdy w repo/aplikacji).
- Tokeny sesji, kody logowania, kody zaproszeń i klucze odzyskiwania zapisane tylko jako SHA-256; kody jednorazowe i z terminem ważności.
- Pieniądze (`entries`, `user_kv`) mają klucz `(user_id, id)` – nikt inny nie może ich odczytać ani nadpisać. Plan ma klucz `(household_id, id)`.
- Limity w D1 (globalne, nie per instancja), CORS tylko dla https://tazo88.github.io, zapytania SQL wyłącznie z parametrami.
- Klucze VAPID generuje worker i trzyma w D1; push szyfrowany (RFC 8291), adresy push tylko znanych usług (bez SSRF).
- Cron co 5 min: przypomnienia + sprzątanie.

Testy: `tests/api.mjs` (10 punktów bezpieczeństwa), `tests/e2e.mjs` (dwie osoby w przeglądarce), `tests/client.mjs`.

Wdrożenie: `wrangler deploy` (D1 `wydatki` już podpięta) albo przez API Cloudflare. Sekret: `wrangler secret put GEMINI_API_KEY`.
Nie ustawiaj `TEST_PUSH_ORIGIN` ani `DEV_ORIGIN` w produkcji (tylko do testów lokalnych).
