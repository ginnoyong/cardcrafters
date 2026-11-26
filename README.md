# Card Crafters

Card Crafters is a team-based, real-time AI greeting-card design game: players form teams, write short prompts to generate AI stickers, and each team's card is composed into a full-bleed AI poster. Players rate every other team's card 1–10 and the game master picks the winner.

Teams are identified only by letter — **Team A / Card A** — never by display names; the card letter follows its team through every phase.

## Game flow

1. **BUILD** — players join teams (QR / `/join/<token>`) and submit short prompts (≤ 6 words). Each accepted prompt is validated + moderated, then generated as a sticker. Staged inputs feed a continuous trailing-edge pipeline that generates each team's full-bleed **AI-montage poster** (`montage_prompt` → `montage_image`) live during the phase. If a poster fails, the deterministic composed sticker card renders as the fail-open fallback.
2. **SCORING** — cards freeze. Players rate every other team's card 1–10 (live averages shown everywhere); the GM watches live tallies and advances to judging.
3. **JUDGING** — the GM reviews the cards with their tallies and picks the winner (People's Choice is computed server-side from the rating aggregates).
4. **REVEAL → RESULTS** — side-by-side winner presentation, standings, and a one-click export of every card as a zip.

The GM console shows live team boxes in ascending Card A → Card N order in every phase; the presenter renders the same side-by-side card layout in all card-bearing stages.

## Running locally

```bash
docker compose up -d && sleep 8 && docker compose ps   # postgres + redis healthy
npm run dev                                            # the app on localhost:3000
```

| URL | What it is |
|---|---|
| `http://localhost:3000/` | GM landing — team count + theme → GM console |
| `http://localhost:3000/present/<code>` | Presenter screen — side-by-side cards, live scores, winner reveal |
| `http://localhost:3000/join/<token>` | Player phone — QR codes on the GM console link here |

`GET /api/health` reports `{"ok":true,"version":"…"}` — the `version` field identifies the live deployment (git SHA on push-deploys, Railway deployment id on `railway up` deploys).

## Demo bots

`apps/web/scripts/demo-bots.mjs` drives a complete game over the real socket surface — every bot is a headless player that joins, submits prompts, waits for montage posters, and rates other teams' cards.

```bash
node apps/web/scripts/demo-bots.mjs --url http://localhost:3000 --team-count 2 --players-per-team 3
node apps/web/scripts/demo-bots.mjs --code ABC123        # join an EXISTING game (a human GM drives)
```

| Flag | Default | What it does |
|---|---|---|
| `--url` | `http://localhost:3000` | Server base URL |
| `--team-count` | `2` | Teams in a fresh game (ignored with `--code`) |
| `--players-per-team` | `3` | Bots per team |
| `--prompts-per-bot` | `2` | Sticker prompts per bot (≤ 25 items/card cap) |
| `--code` | — | Join an existing game code instead of creating one |
| `--theme` | `Demo bots theme` | Theme for a fresh game |
| `--stagger-ms` | `300` | Delay between bot joins |
| `--submit-gap-ms` | `5200` | Per-bot prompt spacing (must be > 5000ms cooldown) |
| `--step-timeout-ms` | auto (`12s × players`, floor 120s) | Per-step deadline — raise for big live-AI runs |
| `--rate` / `--no-rate` | rate | Whether bots rate other teams' cards |
| `--gm-drive` / `--no-gm-drive` | on for fresh games | One bot drives the GM console (theme → approve → scoring → judging → reveal) |

Content-level AI failures (moderation/validation rejections, failed stickers) are skipped with warnings — the bot still completes the game; structural failures (wrong phase, socket loss, deadlines) abort it.

> ⚠️ In **live AI mode** bots spend real money — every sticker and montage is a paid provider call. **Mock mode** (`AI_MODE=mock`) is free and fully deterministic.

## AI configuration

`AI_MODE` selects the provider: `mock` (deterministic offline play), `openrouter` (live, requires `OPENROUTER_API_KEY`), or `auto` (live iff a key is present — the production default). Task registry, model chains with a retirement-dated lifecycle ledger, and prompt templates live in `config/ai-tasks.json` and `config/prompts/`.

Key environment variables (see `.env.example` for the full list):

| Variable | Default | Purpose |
|---|---|---|
| `AI_MODE` | `auto` | Provider selection |
| `OPENROUTER_API_KEY` | — | Live provider key |
| `AI_BUDGET_PER_GAME_USD` | `50` | Per-game spend ceiling (fail-closed) |
| `AI_MAX_CONCURRENT_REQUESTS` | `6` | Global OpenRouter in-flight cap (semaphore) |
| `AI_MAX_CONCURRENT_IMAGES` | `3` | Cap for image generations specifically |
| `CC_IMAGE_CONCURRENCY` | `4` | Sticker queue worker concurrency |

The router throttles itself against OpenRouter's in-flight budget (402 `Retry-After` is honored) and fail-opens where safe: layout hints are best-effort, prompt validation falls back to a local word-count check on AI outage, and montage posters degrade to the composed card. Moderation is deliberately fail-closed.

## Hosting

**Railway (recommended, simplest):** connect the repo, add PostgreSQL + Redis, set the variables above, attach one volume at `/app/apps/web/public/static` (generated card art survives redeploys), generate a domain, done — the Dockerfile + entrypoint handle builds and migrations.

**VPS with Docker:** prereqs are Docker, a DNS A record for your domain (TLS mode), and inbound ports 80/443 (TLS mode) or 3000 (LAN mode).

1. Copy `.env.example` to `.env` on the server and fill it in (at minimum `OPENROUTER_API_KEY`; the compose file overrides `DATABASE_URL`/`REDIS_URL` with container-internal hostnames).
2. LAN mode (no domain needed):

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

3. TLS mode (Caddy issues a certificate automatically — requires the DNS A record and ports 80/443 open; close port 3000 in your firewall once active):

   ```bash
   COMPOSE_PROFILES=tls docker compose -f docker-compose.prod.yml up -d --build
   ```

Redeploys use the same command — Prisma migrations run on container start (`npx prisma migrate deploy`) and are idempotent, so data in the volumes is preserved. The dev workflow (`docker compose up -d` + `npm run dev`) is unchanged and uses a separate compose project.

## Verification

```bash
npm test              # full vitest suite (660+ tests incl. a 120-player end-to-end game)
npm run build         # next build
docker compose ps     # postgres + redis healthy
```
