import { io } from "socket.io-client";
const s = io("http://localhost:3210", { path: "/socket.io", transports: ["websocket"], autoConnect: false, auth: { role: "player" } });
s.on("connect", () => { console.log("CONNECTED", s.id); s.disconnect(); process.exit(0); });
s.on("connect_error", (e) => console.log("connect_error:", e.message));
s.connect();
setTimeout(() => { console.log("STILL HANGING after 8s"); process.exit(2); }, 8000);
