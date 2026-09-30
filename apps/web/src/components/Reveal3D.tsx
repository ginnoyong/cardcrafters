"use client";

/**
 * 3D winner reveal (presenter REVEAL phase only) — the winning card
 * materializes as a textured plane in a small Three.js scene: a slow
 * scale-up "materialize" entry, then an elegant idle float (±8° tilt
 * oscillation, slow yaw, gentle camera drift, soft glow behind the card).
 * No confetti, no particles — the card itself is the moment.
 *
 * Fallback ladder — ANY miss renders the static WinnerBanner instead:
 *   1. prefers-reduced-motion (the moment must not animate);
 *   2. WebGL unavailable (headless browsers, jsdom, blocked GPU);
 *   3. the Three.js dynamic import failing (heavy chunk never blocks SSR —
 *      it is imported lazily INSIDE the effect, so Next prerender/SSR and
 *      the fallback paths never even download it);
 *   4. the reveal-card texture failing to load (endpoint refuses outside
 *      REVEAL/RESULTS, or a network hiccup).
 *
 * The component runs for the WHOLE REVEAL phase (the hub's 30s auto-expiry
 * or the presenter's "Show results" click — existing behavior, untouched).
 * The rAF loop, listeners, geometries, materials and textures are disposed
 * on unmount (RESULTS swap, phase change, unmount — no leaks).
 */

import { useEffect, useRef, useState } from "react";

import { clamp01, easeOutCubic, prefersReducedMotion, REVEAL_ENTRY_MS, supportsWebgl } from "./reveal3d-support";
import { WinnerBanner } from "./Standings";

type Mode = "pending" | "three" | "fallback";

/** Card plane size in world units — keeps the 5:7 card ratio. */
const CARD_W = 1.4;
const CARD_H = 1.96;
/** Corner radius of the rounded card plane (world units). */
const CARD_CORNER = 0.07;
/** Tilt oscillation amplitude (radians ≈ ±8°). */
const TILT_AMPLITUDE = 0.14;
/** Slow yaw oscillation amplitude (radians). */
const YAW_AMPLITUDE = 0.3;
/** Camera drift amplitudes (world units — subtle). */
const CAM_DRIFT_X = 0.06;
const CAM_DRIFT_Y = 0.05;

export function Reveal3D({
  code,
  label,
  testId = "winner-banner",
}: {
  /** Game code — resolves the reveal-card texture endpoint. */
  code: string;
  /** Winning team's display name/label. */
  label: string;
  /** Falls back to the WinnerBanner under this test id (same as static). */
  testId?: string;
}) {
  const [mode, setMode] = useState<Mode>("pending");
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Capability probe — synchronous, run once on mount. While "pending" (the
  // first frame) the static banner shows, so there is never an empty stage.
  useEffect(() => {
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    if (prefersReducedMotion(mq)) {
      setMode("fallback");
      return;
    }
    const probe = document.createElement("canvas");
    if (!supportsWebgl(probe)) {
      setMode("fallback");
      return;
    }
    setMode("three");
  }, []);

  // Scene lifecycle — Three.js is imported dynamically (client-only), the
  // scene is built off the critical path, and everything disposes on unmount.
  useEffect(() => {
    if (mode !== "three") return;
    const host = stageRef.current;
    if (!host) return;
    let disposed = false;
    let teardown: () => void = () => undefined;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        if (!disposed) setMode("fallback");
        return;
      }
      if (disposed) return;
      try {
        teardown = await startRevealScene(THREE, host, code, () => {
          if (!disposed) setMode("fallback");
        });
      } catch (err) {
        console.error("[reveal3d] scene failed — falling back to the static banner:", err);
        if (!disposed) setMode("fallback");
      }
    })();

    return () => {
      disposed = true;
      teardown();
    };
  }, [mode, code]);

  if (mode !== "three") {
    // "pending" (first frame) + every fallback → the static banner.
    return <WinnerBanner label={label} testId={testId} />;
  }

  return (
    <section className="cc-card cc-reveal3d" role="status" aria-label="the winner" data-testid={testId}>
      <p className="cc-winner-kicker">The winner is…</p>
      <p className="cc-winner-name">🏆 {label}</p>
      <div className="cc-reveal3d-stage" ref={stageRef} aria-hidden="true">
        {/* The <canvas> is created by the Three.js renderer. */}
      </div>
    </section>
  );
}

/**
 * Build + run the reveal scene. Returns a teardown that cancels the rAF
 * loop, disconnects the ResizeObserver and disposes every GPU resource.
 * Calls onFail() (instead of throwing past the texture load) when the card
 * texture cannot be fetched — the caller then swaps to the static banner.
 */
async function startRevealScene(
  THREE: typeof import("three"),
  host: HTMLElement,
  code: string,
  onFail: () => void,
): Promise<() => void> {
  const width = () => host.clientWidth || 480;
  const height = () => host.clientHeight || 360;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width(), height());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, width() / height(), 0.1, 20);
  camera.position.set(0, 0, 3.4);

  // Soft three-point-ish lighting: ambient base + warm key + cool rim.
  scene.add(new THREE.AmbientLight(0xffffff, 1.05));
  const key = new THREE.DirectionalLight(0xfff3e0, 1.5);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8be9fd, 0.45);
  rim.position.set(-3, -1, 2);
  scene.add(rim);

  // Rounded-rect card plane (5:7), UVs remapped to 0..1 over the shape bounds
  // so the card texture maps cleanly across the rounded geometry.
  const shape = new THREE.Shape();
  const x = -CARD_W / 2;
  const y = -CARD_H / 2;
  shape.moveTo(x + CARD_CORNER, y);
  shape.lineTo(x + CARD_W - CARD_CORNER, y);
  shape.quadraticCurveTo(x + CARD_W, y, x + CARD_W, y + CARD_CORNER);
  shape.lineTo(x + CARD_W, y + CARD_H - CARD_CORNER);
  shape.quadraticCurveTo(x + CARD_W, y + CARD_H, x + CARD_W - CARD_CORNER, y + CARD_H);
  shape.lineTo(x + CARD_CORNER, y + CARD_H);
  shape.quadraticCurveTo(x, y + CARD_H, x, y + CARD_H - CARD_CORNER);
  shape.lineTo(x, y + CARD_CORNER);
  shape.quadraticCurveTo(x, y, x + CARD_CORNER, y);
  const cardGeo = new THREE.ShapeGeometry(shape, 12);
  cardGeo.computeBoundingBox();
  const bb = cardGeo.boundingBox!;
  const sizeX = bb.max.x - bb.min.x;
  const sizeY = bb.max.y - bb.min.y;
  const uv = cardGeo.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(
      i,
      (uv.getX(i) - bb.min.x) / sizeX,
      (uv.getY(i) - bb.min.y) / sizeY,
    );
  }
  const cardMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.05,
    transparent: true,
    opacity: 0,
  });
  const card = new THREE.Mesh(cardGeo, cardMat);

  const group = new THREE.Group();
  group.add(card);
  scene.add(group);

  // Soft glow behind the card: a radial-gradient sprite (generated, static —
  // it does not rotate with the card) fading in with the entry animation.
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = 256;
  glowCanvas.height = 256;
  const g2d = glowCanvas.getContext("2d")!;
  const grad = g2d.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, "rgba(255, 209, 102, 0.55)");
  grad.addColorStop(0.55, "rgba(255, 95, 143, 0.18)");
  grad.addColorStop(1, "rgba(255, 95, 143, 0)");
  g2d.fillStyle = grad;
  g2d.fillRect(0, 0, 256, 256);
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), glowMat);
  glow.position.set(0, 0, -0.6);
  scene.add(glow);

  // Card texture — the winning team's finished card PNG (public at REVEAL).
  let cardTex: import("three").Texture | null = null;
  try {
    cardTex = await new Promise<import("three").Texture>((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        `/api/games/${encodeURIComponent(code)}/reveal-card`,
        (tex) => resolve(tex),
        undefined,
        () => reject(new Error("reveal-card texture failed to load")),
      );
    });
  } catch (err) {
    console.error("[reveal3d] texture load failed — falling back to the static banner:", err);
    cardGeo.dispose();
    cardMat.dispose();
    glowTex.dispose();
    glowMat.dispose();
    glow.geometry.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    onFail();
    return () => undefined;
  }
  cardTex.colorSpace = THREE.SRGBColorSpace;
  cardTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  cardMat.map = cardTex;
  cardMat.needsUpdate = true;

  // Keep the drawing buffer in sync with the stage (presenter windows resize).
  const ro = new ResizeObserver(() => {
    const w = width();
    const h = height();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(host);

  const start = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const t = (now - start) / 1000;
    const entry = easeOutCubic(clamp01((now - start) / REVEAL_ENTRY_MS));
    const inv = 1 - entry;

    // Materialize: scale-up + fade-in, with a settling yaw swing.
    group.scale.setScalar(0.72 + 0.28 * entry);
    cardMat.opacity = entry;
    glowMat.opacity = 0.85 * entry;
    group.rotation.y = Math.sin(t * 0.34) * YAW_AMPLITUDE + inv * 0.6;
    // Idle float: ±8° tilt oscillation + a gentle bob.
    group.rotation.x = Math.sin(t * 0.55) * TILT_AMPLITUDE;
    group.position.y = Math.sin(t * 0.8) * 0.035;
    // Subtle camera drift (both axes), always looking at the card.
    camera.position.x = Math.sin(t * 0.21) * CAM_DRIFT_X;
    camera.position.y = Math.cos(t * 0.17) * CAM_DRIFT_Y;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    cardGeo.dispose();
    cardMat.dispose();
    cardTex?.dispose();
    glow.geometry.dispose();
    glowMat.dispose();
    glowTex.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}