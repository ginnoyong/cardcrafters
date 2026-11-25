/**
 * RatingPanel ratingCardFace unit tests — the pure face-choice helper
 * (extracted from the component precisely so this server/client parity
 * contract is testable without rendering: RatingPanel itself is a hooks
 * component and cannot run under SSR/node).
 *
 * Contract: an EMPTY card (payload `empty` — 0 renderable READY stickers
 * server-side) with no READY montage poster renders the client-side empty
 * treatment on BOTH flip faces; every other card renders the real server
 * artwork (poster / sticker) unchanged.
 */

import { describe, expect, it } from "vitest";

import { ratingCardFace } from "./RatingPanel";

describe("ratingCardFace — empty-card parity face choice", () => {
  it("empty + no READY poster → the client-side empty treatment on both faces", () => {
    expect(ratingCardFace({ empty: true, montage: null }, "poster")).toEqual({ kind: "empty" });
    expect(ratingCardFace({ empty: true, montage: null }, "sticker")).toEqual({ kind: "empty" });
    expect(ratingCardFace({ empty: true }, "poster")).toEqual({ kind: "empty" });
  });

  it("empty but READY poster → the real server artwork (poster wins over empty)", () => {
    expect(
      ratingCardFace({ empty: true, montage: { status: "ready", imageUrl: "/static/x.png" } }, "poster"),
    ).toEqual({ kind: "image", variant: "poster" });
    expect(
      ratingCardFace({ empty: true, montage: { status: "ready", imageUrl: "/static/x.png" } }, "sticker"),
    ).toEqual({ kind: "image", variant: "sticker" });
  });

  it("non-empty cards keep the unchanged artwork path for both variants", () => {
    expect(ratingCardFace({ empty: false, montage: null }, "poster")).toEqual({
      kind: "image",
      variant: "poster",
    });
    expect(ratingCardFace({ empty: false, montage: null }, "sticker")).toEqual({
      kind: "image",
      variant: "sticker",
    });
    // Legacy payloads without the flag at all behave as non-empty.
    expect(ratingCardFace({}, "poster")).toEqual({ kind: "image", variant: "poster" });
  });
});
