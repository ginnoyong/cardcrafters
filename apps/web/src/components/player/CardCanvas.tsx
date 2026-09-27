"use client";

/**
 * CardCanvas — the reusable card renderer (player build screen + GM/presenter
 * mini previews). Renders one team's card: paper background, greeting text
 * zone, and READY items at their solved placements.
 *
 * Geometry: server placements are CENTER coordinates in the normalized
 * 0..1000 space (see apps/web/src/server/layout/constraints.ts placedBox —
 * the truth this component mirrors via lib/canvas-geometry.ts). The stage is
 * sized to the card's aspect ratio (default 5:7), so the mapping is a single
 * uniform scale.
 *
 * Motion: on a NEWER layout version, each moved item tweens x/y/width/height/
 * rotation over LAYOUT_TWEEN_MS (600ms, ease-out); brand-new items fade in.
 * `prefers-reduced-motion` jumps straight to targets. Pending (validating/
 * generating) items are NOT drawn here — parents render a DOM strip/list
 * under the canvas (accessible + shimmer via CSS).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import Konva from "konva";
import { Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva";

import { LAYOUT_TWEEN_MS } from "@cardcrafters/shared";

import {
  greetingZonePx,
  mapPlacement,
  type MappedPlacement,
} from "@/lib/canvas-geometry";
import type { ClientGreetingStyle, ClientItem, ClientLayout } from "@/lib/store";

export interface CardCanvasProps {
  /** The team's items (any status; only READY + placed ones are drawn). */
  items: ClientItem[];
  /** Latest committed layout (placements + optional greeting style). */
  layout: ClientLayout | null;
  /** Greeting text drawn in the top text zone ("" → nothing drawn). */
  greeting: string;
  cardRatioW?: number;
  cardRatioH?: number;
  /** This viewer's player id — their own items get a subtle glow. */
  myPlayerId?: string;
  /** Tap/click on an item → itemId (player build screen "locate" feature). */
  onItemTap?: (itemId: string) => void;
  /** Item id to flash-highlight (e.g. after tapping a submission row). */
  highlightItemId?: string | null;
  ariaLabel?: string;
}

// Soft paper card background (CSS vars can't be read by Konva — mirrored in
// globals.css as --cc-paper for any DOM cousins of this canvas).
const PAPER_FILL = "#fbf5ea";
const PAPER_STROKE = "#d9cdb8";

// ---------------------------------------------------------------------------
// Image loading (cached by URL so GM minis + player canvas share elements)
// ---------------------------------------------------------------------------

/** Cache cap: drop the OLDEST stickers once we're over it (long sessions). */
const IMAGE_CACHE_MAX = 200;

const imageCache = new Map<string, HTMLImageElement>();

/** Load a sticker PNG; returns the HTMLImageElement once ready (cached). */
function useKonvaImage(imageUrl: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(() =>
    imageUrl ? imageCache.get(imageUrl) ?? null : null,
  );
  useEffect(() => {
    if (!imageUrl) return;
    const cached = imageCache.get(imageUrl);
    if (cached) {
      setImg(cached);
      return;
    }
    let alive = true;
    const el = new window.Image();
    el.onload = () => {
      imageCache.set(imageUrl, el);
      // Cap the cache (m10): Map preserves insertion order, so deleting first
      // keys evicts the OLDEST entries — the cache never grows unbounded.
      while (imageCache.size > IMAGE_CACHE_MAX) {
        const oldest = imageCache.keys().next().value;
        if (oldest === undefined) break;
        imageCache.delete(oldest);
      }
      if (alive) setImg(el);
    };
    el.onerror = () => {
      // Leave the previous state; the sticker just won't render this paint.
    };
    el.src = imageUrl;
    return () => {
      alive = false;
    };
  }, [imageUrl]);
  return img;
}

// ---------------------------------------------------------------------------
// Environment hooks
// ---------------------------------------------------------------------------

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Container-width-driven stage size: height = width × ratio, capped ~70vh. */
function useStageSize(ratioW: number, ratioH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = (): void => {
      const containerW = el.clientWidth;
      if (containerW <= 0) return;
      let w = containerW;
      let h = (containerW * ratioH) / ratioW;
      const maxH = Math.max(260, window.innerHeight * 0.7);
      if (h > maxH) {
        h = maxH;
        w = (h * ratioW) / ratioH;
      }
      setSize({ w: Math.round(w), h: Math.round(h) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [ratioW, ratioH]);
  return { containerRef: ref, size };
}

// ---------------------------------------------------------------------------
// One READY item node
// ---------------------------------------------------------------------------

interface ReadyItemProps {
  item: ClientItem;
  mapped: MappedPlacement;
  glow: "none" | "own" | "highlight";
  onItemTap?: (itemId: string) => void;
  registerNode: (itemId: string, node: Konva.Image | null) => void;
}

function ReadyItem({ item, mapped, glow, onItemTap, registerNode }: ReadyItemProps) {
  const img = useKonvaImage(item.imageUrl);
  if (!item.imageUrl || !img) return null;
  return (
    <KonvaImage
      ref={(node: Konva.Image | null) => registerNode(item.id, node)}
      id={item.id}
      image={img}
      x={mapped.x}
      y={mapped.y}
      offsetX={mapped.width / 2}
      offsetY={mapped.height / 2}
      width={mapped.width}
      height={mapped.height}
      rotation={mapped.rotation}
      // Center-anchored (offset = half size) so Konva rotation matches the
      // server's placedBox center semantics exactly.
      shadowColor={glow === "none" ? undefined : glow === "highlight" ? "#ffd166" : "#ff5f8f"}
      shadowBlur={glow === "none" ? 0 : glow === "highlight" ? 26 : 12}
      shadowOpacity={glow === "none" ? 0 : 0.7}
      shadowEnabled={glow !== "none"}
      onClick={() => onItemTap?.(item.id)}
      onTap={() => onItemTap?.(item.id)}
    />
  );
}

// ---------------------------------------------------------------------------
// CardCanvas
// ---------------------------------------------------------------------------

export default function CardCanvas({
  items,
  layout,
  greeting,
  cardRatioW = 5,
  cardRatioH = 7,
  myPlayerId,
  onItemTap,
  highlightItemId = null,
  ariaLabel = "team card preview",
}: CardCanvasProps) {
  const { containerRef, size } = useStageSize(cardRatioW, cardRatioH);
  const reducedMotion = usePrefersReducedMotion();
  const layerRef = useRef<Konva.Layer | null>(null);
  const nodesRef = useRef(new Map<string, Konva.Image>());
  const tweensRef = useRef(new Map<string, Konva.Tween>());
  const prevVersionRef = useRef<number | null>(null);
  const prevIdsRef = useRef(new Set<string>());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const registerNode = (itemId: string, node: Konva.Image | null): void => {
    if (node) nodesRef.current.set(itemId, node);
    else nodesRef.current.delete(itemId);
  };

  // READY + placed items, painted in zIndex order.
  const placed = layout
    ? layout.placements
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex)
        .flatMap((pl) => {
          const item = items.find((i) => i.id === pl.itemId && i.status === "ready" && i.imageUrl);
          if (!item) return [];
          return [
            {
              placement: pl,
              item,
              mapped: mapPlacement(pl, { width: item.width ?? 256, height: item.height ?? 256 }, size.w, size.h, cardRatioW, cardRatioH),
            },
          ];
        })
    : [];

  const zone = greetingZonePx(size.w, size.h, cardRatioW, cardRatioH);

  // The tween effect must run ONLY when the layout version, the set of placed
  // ids, the stage size or the reduced-motion flag changes — NOT on every
  // parent re-render (a re-render would destroy live tweens and snap items).
  // `placed` is recomputed each render, so the effect reads it through a ref
  // and keys off a stable signature instead.
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const placedKey = `${layout?.version ?? "none"}|${placed
    .map((p) => p.placement.itemId)
    .join(",")}`;

  // Tween / fade-in orchestration (useLayoutEffect: beat the paint so new
  // items start at opacity 0 without a flash).
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || size.w === 0) return;
    const placedNow = placedRef.current;
    const layoutNow = layoutRef.current;

    const destroyTween = (id: string): void => {
      const existing = tweensRef.current.get(id);
      if (existing) {
        existing.destroy();
        tweensRef.current.delete(id);
      }
    };

    const versionChanged =
      prevVersionRef.current === null ||
      (layoutNow !== null && layoutNow.version > prevVersionRef.current);

    for (const { placement, mapped } of placedNow) {
      const node = nodesRef.current.get(placement.itemId);
      if (!node) continue;
      const isNew = !prevIdsRef.current.has(placement.itemId);

      // Resize or first paint or stale version → jump instantly.
      if (reducedMotion || !versionChanged || isNew || prevVersionRef.current === null) {
        destroyTween(placement.itemId);
        if (isNew && !reducedMotion) {
          // Fade in: start transparent, tween opacity only.
          node.setAttrs({ ...mapped, offsetX: mapped.width / 2, offsetY: mapped.height / 2, opacity: 0 });
          const tween = new Konva.Tween({
            node,
            opacity: 1,
            duration: LAYOUT_TWEEN_MS / 1000,
            easing: Konva.Easings.EaseOut,
          });
          tweensRef.current.set(placement.itemId, tween);
          tween.play();
        } else {
          node.setAttrs({
            ...mapped,
            offsetX: mapped.width / 2,
            offsetY: mapped.height / 2,
            opacity: 1,
          });
        }
        continue;
      }

      // Moved item: tween FROM THE NODE'S LIVE geometry (m6) — the stored
      // previous geometry could be stale (an intermediate render may have
      // moved the node without a new layout version), and a stale start
      // shows as a visible snap the instant the tween begins. Konva.Tween
      // starts from the node's CURRENT attrs, so re-anchoring the offsets to
      // the LIVE size is all the setup needed; x/y/width/height/rotation
      // tween targets come from `mapped`.
      destroyTween(placement.itemId);
      node.setAttrs({
        offsetX: node.width() / 2,
        offsetY: node.height() / 2,
      });
      const tween = new Konva.Tween({
        node,
        x: mapped.x,
        y: mapped.y,
        width: mapped.width,
        height: mapped.height,
        rotation: mapped.rotation,
        offsetX: mapped.width / 2,
        offsetY: mapped.height / 2,
        duration: LAYOUT_TWEEN_MS / 1000,
        easing: Konva.Easings.EaseOut,
        onUpdate: () => layer.batchDraw(),
      });
      tweensRef.current.set(placement.itemId, tween);
      tween.play();
    }

    // Clean up tweens for items that left the layout.
    const currentIds = new Set(placedNow.map((p) => p.placement.itemId));
    for (const [id, tween] of tweensRef.current) {
      if (!currentIds.has(id)) {
        tween.destroy();
        tweensRef.current.delete(id);
      }
    }

    prevIdsRef.current = currentIds;
    if (layoutNow !== null) prevVersionRef.current = layoutNow.version;
    layer.batchDraw();
  }, [placedKey, size.w, size.h, reducedMotion]);

  // Destroy any live tween on unmount.
  useEffect(() => {
    return () => {
      for (const tween of tweensRef.current.values()) tween.destroy();
      tweensRef.current.clear();
    };
  }, []);

  const emptyCard = placed.length === 0;

  return (
    <div className="cc-canvas-wrap" ref={containerRef}>
      <div
        className="cc-canvas-box"
        style={{ width: size.w || undefined, height: size.h || undefined }}
        role="img"
        aria-label={ariaLabel}
      >
        {size.w > 0 ? (
          <Stage width={size.w} height={size.h} className="cc-canvas-stage">
            <Layer ref={layerRef}>
              {/* Card paper background */}
              <Rect
                x={0}
                y={0}
                width={size.w}
                height={size.h}
                cornerRadius={Math.max(8, size.w * 0.03)}
                fill={PAPER_FILL}
                stroke={PAPER_STROKE}
                strokeWidth={1.5}
                listening={false}
              />
              {/* Greeting text zone: x 10%..90%, y 6%..22% of the card */}
              {greeting ? (
                <Text
                  x={zone.x}
                  y={zone.y}
                  width={zone.width}
                  height={zone.height}
                  align={layout?.greetingStyle?.align ?? "center"}
                  verticalAlign="middle"
                  text={greeting}
                  fontFamily={layout?.greetingStyle?.font ?? "Georgia"}
                  fontSize={Math.max(12, size.w * 0.045)}
                  fill={layout?.greetingStyle?.color ?? "#333"}
                  wrap="word"
                  listening={false}
                />
              ) : null}
              {placed.map(({ placement, item, mapped }) => (
                <ReadyItem
                  key={placement.itemId}
                  item={item}
                  mapped={mapped}
                  glow={
                    highlightItemId === item.id
                      ? "highlight"
                      : myPlayerId && item.playerId === myPlayerId
                        ? "own"
                        : "none"
                  }
                  onItemTap={onItemTap}
                  registerNode={registerNode}
                />
              ))}
              {emptyCard ? (
                <Text
                  x={size.w * 0.1}
                  y={size.h * 0.4}
                  width={size.w * 0.8}
                  align="center"
                  text="Stickers will appear here as your team creates them…"
                  fontFamily="Georgia"
                  fontSize={Math.max(12, size.w * 0.04)}
                  fill="#b8ab93"
                  listening={false}
                />
              ) : null}
            </Layer>
          </Stage>
        ) : null}
      </div>
    </div>
  );
}