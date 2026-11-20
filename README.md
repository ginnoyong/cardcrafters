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

Note: the `Dockerfile` is currently unused (compose only provides postgres + redis; the app runs via `npm run dev`).

| URL | What it is |
|---|---|
| `http://localhost:3000/` | GM landing — team count + theme → GM console |
| `http://localhost:3000/present/<code>` | Presenter screen — live cards, scoreboard, 3D reveal |
| `http://localhost:3000/join/<token>` | Player phone — QR codes on the GM console link here |

## AI configuration

Set `AI_MODE=mock` for deterministic offline play (procedural stickers + canned montage posters), or configure provider keys in `.env` for live generation (`AI_MODE=live`). Task registry, pricing, and prompt templates live in `config/ai-tasks.json` and `config/prompts/`.

## Verification

```bash
npm test              # full vitest suite
npm run build         # next build
docker compose ps     # postgres + redis healthy
```
