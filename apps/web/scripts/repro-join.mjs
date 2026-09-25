/**
 * Repro of the user-reported join bug, using the SAME client path as the
 * browser: autoConnect:false + explicit socket.connect() (the fixed attemptJoin
 * flow), a GM auto-setting a theme right after join, then players joining
 * during GREETINGS (must now be allowed) and after approveGreetings (rejected).
 */
import { io } from "socket.io-client";

const URL = "http://localhost:3210";

async function main() {
  const res = await fetch(`${URL}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamCount: 2 }),
  });
  const game = await res_json(res);
  const token = game.teams[0].joinToken;

  // GM: connect (autoConnect false, explicit connect like the GM page)
  const gm = mkSocket({ role: "gm", gameCode: game.code });
  gm.on("connect_error", (e) => console.log("[dbg] gm connect_error:", e.message));
  gm.connect();
  await waitConnect(gm, "gm");
  const ackGm = await emitAck(gm, "join", { role: "gm", joinToken: game.code });
  console.log("gm join ok:", ackGm.ok === true);
  gm.on("player:joined", (p) => console.log("GM saw player:joined:", p.nickname));

  // GM auto-sets theme (this is what the GM console does on connect)
  const t = await emitAck(gm, "gm:setTheme", { theme: "Happy retirement" });
  console.log("gm:setTheme ok:", t.ok === true, "phase:", t.phase);

  // Player 1: EXACT fixed client flow — create, connect(), await connect, join
  const p1 = mkSocket({ role: "player" });
  p1.connect();
  await waitConnect(p1, "p1");
  const a1 = await emitAck(p1, "join", { role: "player", joinToken: token, nickname: "Maya" });
  console.log("p1 join (during GREETINGS) ok:", a1.ok === true);

  const p2 = mkSocket({ role: "player" });
  p2.connect();
  await waitConnect(p2, "p2");
  const a2 = await emitAck(p2, "join", { role: "player", joinToken: token, nickname: "Leo" });
  console.log("p2 join ok:", a2.ok === true);

  await sleep(400);
  // GM resync (bare ack shape) → snapshot should include both players
  const resyncAck = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("resync ack timeout")), 8000);
    gm.emit("sync:resync", (r) => { clearTimeout(t); res(r); });
  });
  console.log("resync ok:", resyncAck.ok === true);

  // approve greetings → BUILD → a third player must be rejected
  const ap = await emitAck(gm, "gm:approveGreetings", {});
  console.log("approveGreetings ok:", ap.ok === true, "phase:", ap.phase);
  const p3 = mkSocket({ role: "player" });
  p3.connect();
  await waitConnect(p3, "p3");
  const a3 = await emitAck(p3, "join", { role: "player", joinToken: token, nickname: "Late" });
  console.log("p3 join (BUILD) rejected as expected:", a3.ok === false, "err:", a3.error);

  gm.close(); p1.close(); p2.close(); p3.close();
  setTimeout(() => process.exit(0), 200);
}

function mkSocket(auth) {
  return io(URL, { path: "/socket.io", transports: ["websocket"], autoConnect: false, auth });
}
async function waitConnect(sock, name) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} connect timeout`)), 8000);
    sock.once("connect", () => { clearTimeout(timer); res(); });
    sock.once("connect_error", (e) => { clearTimeout(timer); rej(new Error(`${name}: ${e.message}`)); });
  });
}
function emitAck(sock, event, payload) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${event} ack timeout`)), 8000);
    sock.emit(event, payload, (r) => { clearTimeout(t); res(r); });
  });
}
async function res_json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON (${res.status}): ${text.slice(0, 300)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error("REPRO FAILED:", e); process.exit(1); });