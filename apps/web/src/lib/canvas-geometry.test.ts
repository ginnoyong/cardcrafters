/**
 * Cross-check the CLIENT placement mapping (lib/canvas-geometry.ts) against
 * the SERVER constraint math (apps/web/src/server/layout/constraints.ts).
 * The canvas must render exactly what the solver constrained: the client's
 * normalized card box must equal the server's, and the pixel AABB from
 * mapPlacement must equal placedBox × px-per-unit for rotations and scales.
 */

import { describe, expect, it } from "vitest";

import {
  baseFit as serverBaseFit,
  cardBox as serverCardBox,
  placedBox,
  type LayoutItem,
} from "../server/layout/constraints";

import {
  baseFit,
  cardBoxNormalized,
  greetingZonePx,
  mapPlacement,
} from "./canvas-geometry";

const RATIO_W = 5;
const RATIO_H = 7;
const STAGE_W = 400;
const STAGE_H = 560;

/** Server's card box over the normalized 0..1000 square space. */
const SERVER_CARD = serverCardBox({ width: 1000, height: 1000 }, RATIO_W, RATIO_H);
const K = serverBaseFit(SERVER_CARD);
const PX_X = STAGE_W / SERVER_CARD.w;
const PX_Y = STAGE_H / SERVER_CARD.h;

/** AABB of a center-anchored, ROTATED mapped placement (mirrors placedBox). */
function mappedAabb(
  p: { x: number; y: number; scale: number; rotation: number },
  item: { width: number; height: number },
) {
  const m = mapPlacement(p, item, STAGE_W, STAGE_H, RATIO_W, RATIO_H);
  const rad = (m.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const hx = (m.width / 2) * c + (m.height / 2) * s;
  const hy = (m.width / 2) * s + (m.height / 2) * c;
  return { x1: m.x - hx, y1: m.y - hy, x2: m.x + hx, y2: m.y + hy };
}

function expectBoxesMatch(
  placement: { x: number; y: number; scale: number; rotation: number },
  item: LayoutItem,
): void {
  const size = { width: item.imgW, height: item.imgH }; // server imgW/imgH → client ItemSize
  const server = placedBox(placement, item, K);
  const client = mappedAabb(placement, size);
  expect(client.x1).toBeCloseTo(server.x1 * PX_X, 9);
  expect(client.y1).toBeCloseTo(server.y1 * PX_Y, 9);
  expect(client.x2).toBeCloseTo(server.x2 * PX_X, 9);
  expect(client.y2).toBeCloseTo(server.y2 * PX_Y, 9);
}

describe("mapPlacement ⇄ placedBox cross-check", () => {
  it("client and server agree on the normalized card box", () => {
    const client = cardBoxNormalized(RATIO_W, RATIO_H);
    expect(client.w).toBeCloseTo(SERVER_CARD.w, 9);
    expect(client.h).toBeCloseTo(SERVER_CARD.h, 9);
  });

  it("client and server agree on k (base fit)", () => {
    expect(baseFit(cardBoxNormalized(RATIO_W, RATIO_H))).toBeCloseTo(K, 9);
  });

  it("rotation 0: pixel AABB equals placedBox × px-per-unit", () => {
    expectBoxesMatch(
      { x: 500, y: 500, scale: 1, rotation: 0 },
      { id: "i1", imgW: 256, imgH: 256, visualWeight: 0.5, orderIndex: 0 },
    );
  });

  it("rotation 90°: half-extents swap on both sides", () => {
    expectBoxesMatch(
      { x: 400, y: 600, scale: 1, rotation: 90 },
      { id: "i2", imgW: 256, imgH: 128, visualWeight: 0.4, orderIndex: 1 },
    );
  });

  it("arbitrary rotation and extreme scales stay consistent", () => {
    const item: LayoutItem = { id: "i3", imgW: 512, imgH: 384, visualWeight: 0.9, orderIndex: 2 };
    for (const [scale, rotation] of [
      [0.2, 0],
      [1, 30],
      [2.5, 137],
    ] as const) {
      expectBoxesMatch({ x: 300, y: 700, scale, rotation }, item);
    }
  });

  it("greetingZonePx matches the 10/6/80/16 contract in pixels", () => {
    const z = greetingZonePx(STAGE_W, STAGE_H, RATIO_W, RATIO_H);
    expect(z.x).toBeCloseTo(0.1 * SERVER_CARD.w * PX_X, 9);
    expect(z.y).toBeCloseTo(0.06 * SERVER_CARD.h * PX_Y, 9);
    expect(z.width).toBeCloseTo(0.8 * SERVER_CARD.w * PX_X, 9);
    expect(z.height).toBeCloseTo(0.16 * SERVER_CARD.h * PX_Y, 9);
  });
});
