# Card Crafters

Card Crafters is a team-based, real-time AI greeting-card design game: players form teams, write short prompts to generate AI greeting-card elements, arrange them on a shared canvas, and compete in rounds scored by peers and an AI game master.

## Game flow

1. **BUILD** — players join teams (QR/`/join/<token>`), submit short prompts. Each accepted prompt spawns a sticker (AI or mock-procedural). Staged inputs accumulate per team; a continuous trailing-edge pipeline text-generates a montage prompt (`montage_prompt`) and generates a full poster image (`montage_image`) per card, broadcast live while BUILD is running.
2. **SCORING** — cards freeze; layout critique + poster-strategy re-layout ("final montage pass") run, then each card re-renders with feathered blending and style-pack color grading. Players rate every other team's card anonymously 1–10 (live averages shown); the GM sees a judging table sorted by average and picks the winner (People's Choice / AI pick).
3. **REVEAL** — clickable "The winner is…" banner (30s auto-reset), 3D presentation of all cards with winner gloss, then reset to a new round.

## Montage mode (AI poster)

Each card is a movie-poster-style composition: a dominant focal sticker (~60% of canvas, centered), supporting stickers at 50–60% of focal size, filling 65–80% of the canvas (solver-enforced with graded fallback: raise ratio → re-order → shrink hero). The staged inputs are also folded into a single full-bleed AI poster image per card; if generation fails, the composed card + text chips render as a fail-open fallback.

## Running locally

```bash
docker compose up -d && sleep 8 && docker compose ps   # postgres + redis healthy
npm run dev                                            # run the app on localhost:3000
```

Note: `docker compose` only provides postgres + redis; the app itself runs via `npm run dev`. For production see the `docker-compose.prod.yml` stack under *Deploy to a VPS* below.

| URL | What it is |
|---|---|
| `http://localhost:3000/` | GM landing — team count + theme → GM console |
| `http://localhost:3000/present/<code>` | Presenter screen — live cards, scoreboard, 3D reveal |
| `http://localhost:3000/join/<token>` | Player phone — QR codes on the GM console link here |

## Demo bots

`apps/web/scripts/demo-bots.mjs` drives a complete game over the real socket surface — every bot is a headless player that joins, submits prompts, waits for montage posters, and rates other teams' cards. Use it to smoke-test a running server without a room full of phones.

```bash
node apps/web/scripts/demo-bots.mjs --url http://localhost:3000 --team-count 2 --players-per-team 3
node apps/web/scripts/demo-bots.mjs --code ABC123        # join an EXISTING game (a human GM drives)
node apps/web/scripts/demo-bots.mjs --url http://localhost:3210 --no-gm-drive
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
| `--submit-gap-ms` | `5200` | Per-bot submit spacing (must be > 5000ms cooldown) |
| `--rate` / `--no-rate` | `rate` | Whether bots rate other teams' cards |
| `--gm-drive` / `--no-gm-drive` | on for fresh games | One bot drives the GM console (theme → approve → scoring → judging → reveal) |

> ⚠️ In **live AI mode** (`AI_MODE=live`) bots spend real money — every prompt and montage is a paid provider call. **Mock mode** (`AI_MODE=mock`) is free and fully deterministic.

## AI configuration

Set `AI_MODE=mock` for deterministic offline play (procedural stickers + canned montage posters), or configure provider keys in `.env` for live generation (`AI_MODE=live`). Task registry, pricing, and prompt templates live in `config/ai-tasks.json` and `config/prompts/`.

## Deploy to a VPS

Prereqs: a VPS with Docker + Docker Compose, a DNS A record for your domain (TLS mode), and inbound ports 80/443 (TLS mode) or 3000 (LAN mode) open.

1. Copy `.env.example` to `.env` on the server and fill it in (at minimum `OPENROUTER_API_KEY`; the compose file overrides `DATABASE_URL`/`REDIS_URL` with container-internal hostnames).
2. LAN mode (no domain needed):

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

3. TLS mode (Caddy issues a certificate automatically — requires the DNS A record and ports 80/443 open; close port 3000 in your firewall once active):

   ```bash
   COMPOSE_PROFILES=tls docker compose -f docker-compose.prod.yml up -d --build
   ```

Redeploys use the same command — Prisma migrations run on container start (`npx prisma migrate deploy`) and are idempotent, so data in the `pgdata` volume is preserved. The dev workflow (`docker compose up -d` + `npm run dev`) is unchanged and uses a separate compose project.

## Verification

```bash
npm test              # full vitest suite
npm run build         # next build
docker compose ps     # postgres + redis healthy
```
