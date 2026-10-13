# Müllerkinder-Planer

Gemeinsame Termine für uns drei Geschwister finden. Jede Person trägt pro Tageshälfte
(Vormittag, Nachmittag, Abend) ein, wie gut es passt: **sehr gut / gut / mittel** oder
**kann nicht**. Die Übersicht zeigt auf einen Blick, wann alle können, und listet die besten Termine.

- **Frontend**: statische Seite auf GitHub Pages (`web/`), ohne Build-Schritt und ohne Framework.
- **Backend**: Cloudflare Worker mit D1-Datenbank (`worker/`). Architektur und Anmeldung wie beim Freundeskalender (`../Kalender`).
- **Anmeldung**: persönlicher Einladungslink. Einmal öffnen, danach bleibt man eingeloggt.

## Was man eintragen kann

| Was | Wo | Beispiel |
|---|---|---|
| Stufe pro Tageshälfte | Tab **Eintragen**, antippen oder seitlich ziehen | Sa Abend: sehr gut |
| Notiz zu einer Tageshälfte | Pinsel **Notiz** | „nur bis 21 Uhr“ |
| Ganze Tage blockiert | Tab **Urlaub & Regeln** | 27.–31.10. Urlaub |
| Wiederkehrende Regel | Tab **Urlaub & Regeln** | Mo–Fr vormittags: Arbeit (Blocker) · abends: nur bis 21 Uhr (Hinweis) |

**Was gilt, wenn sich etwas widerspricht:** eigener Eintrag vor Urlaub vor Blocker-Regel.
Wer an einem Arbeitstag ausnahmsweise frei hat, trägt den Vormittag einfach ein.

**Gesamtbild einer Tageshälfte:**

- Ein einziges „kann nicht“ macht sie grau schraffiert.
- Haben alle eingetragen, dass sie können, zählt die schlechteste Stufe (alle sehr gut / gut / mittel).
- Sonst steht dort „noch nicht alle“. Nichts eintragen heißt also nicht „kann“.

Ein blauer Punkt oben rechts zeigt, dass es zu dieser Tageshälfte einen Hinweis gibt. Antippen öffnet die Details.

---

## Einrichtung

Gebraucht werden ein GitHub-Account, der Cloudflare-Account vom Freundeskalender und **Node.js 22+** (`nvm use` liest `.nvmrc`).

### 1. Backend ausrollen

```bash
cd worker
npm install
npx wrangler login                          # falls noch nicht angemeldet
npx wrangler d1 create muellerkinder-planer
```

Die ausgegebene `database_id` in [`worker/wrangler.toml`](worker/wrangler.toml) eintragen. Dann:

```bash
npm run db:init
npm run deploy      # gibt die Worker-URL aus
```

### 2. Dich selbst als Admin anlegen

```bash
cd worker
TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
npx wrangler d1 execute muellerkinder-planer --remote --command \
  "INSERT INTO users (name, token, is_admin) VALUES ('Fidelis', '$TOKEN', 1)"
echo "Dein Einladungslink endet auf:  #t=$TOKEN"
```

### 3. Frontend veröffentlichen

Worker-URL in [`web/config.js`](web/config.js) eintragen, Repository zu GitHub pushen und unter
**Settings → Pages → Source** den Punkt **GitHub Actions** wählen. Der Workflow veröffentlicht `web/` bei jedem Push.

Falls die Pages-Adresse nicht `https://fidel-hm.github.io` ist, `ALLOWED_ORIGIN` in `wrangler.toml` anpassen und neu deployen.

Zum ersten Mal mit Token öffnen: `https://fidel-hm.github.io/muellerkinder-planer/#t=DEIN_TOKEN`

### 4. Geschwister einladen

Kreis oben rechts → **Personen** → Namen eintragen. Der Einladungslink erscheint zum Kopieren.
**Wer den Link hat, ist diese Person.** Ein abhandengekommener Link lässt sich über
`POST /api/users/:id/token` (Admin) durch einen neuen ersetzen.

---

## API

Alle Endpunkte erwarten `Authorization: Bearer <token>`. Jede Person ändert nur die eigenen Einträge.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/state` | Personen, Tageshälften ab vor 7 Tagen, Blocker, Regeln |
| `PATCH` | `/api/me` | Name und/oder Farbe |
| `PUT` | `/api/slots` | `{"changes":[{"day":"2026-10-17","half":2,"level":3,"note":"…"}]}` · `level`: -1, 1, 2, 3 oder `null` (löschen) · ohne `note` bleibt die alte Notiz |
| `POST` | `/api/blocks` | `{"from_day","to_day","label"}` |
| `DELETE` | `/api/blocks/:id` | eigenen Blocker löschen |
| `POST` | `/api/rules` | `{"weekdays":"1111100","halves":"110","kind":"block"\|"note","text"}` (Masken: Mo..So, Vormittag..Abend) |
| `DELETE` | `/api/rules/:id` | eigene Regel löschen |
| `GET` / `POST` | `/api/users` | Personen mit Einladungs-Token / Person anlegen (Admin) |
| `DELETE` | `/api/users/:id` | Person mit allen Einträgen entfernen (Admin) |
| `POST` | `/api/users/:id/token` | neues Token (Admin) |

Daten anderer erscheinen ohne Neuladen: Die Seite holt sich alle 60 Sekunden und beim Zurückwechseln in den Tab den neuen Stand.

---

## Lokal entwickeln

```bash
cd worker
npm run db:init:local
npx wrangler d1 execute muellerkinder-planer --local --command \
  "INSERT INTO users (name,token,is_admin) VALUES ('Fidelis','testtoken1234567890abcd',1)"
echo 'ALLOWED_ORIGIN = "*"' > .dev.vars
npx wrangler dev --port 8787

# zweites Terminal
cd web && python3 -m http.server 8080 --bind 127.0.0.1
```

`http://127.0.0.1:8080/#t=testtoken1234567890abcd` öffnen. Auf `127.0.0.1` und `localhost`
spricht `config.js` automatisch den lokalen Worker an, es muss nichts umgestellt werden.
