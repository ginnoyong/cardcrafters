import { io } from "socket.io-client";
const code = process.argv[2];
const s = io("http://localhost:3210", { path: "/socket.io", transports: ["websocket"], autoConnect: false, auth: { role: "gm", gameCode: code } });
s.on("connect", () => { console.log("GM CONNECTED", s.id); s.disconnect(); process.exit(0); });
s.on("connect_error", (e) => console.log("gm connect_error:", e.message));
s.connect();
setTimeout(() => { console.log("GM STILL HANGING after 8s"); process.exit(2); }, 8000);
