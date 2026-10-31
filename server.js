// Party mode server. No outside packages: plain Node http + Server-Sent Events.
// Phones and the host screen receive live updates over SSE (GET /api/rooms/:code/events)
// and send actions with POST requests.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QUESTIONS = require("./questions");

const PORT = process.env.PORT || 3000;
const SECONDS = 45;
const HIT = 0.02;
const BONUS = 3;
const MAX_ROUNDS = 10;
const MAX_PLAYERS = 50;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
// Topics shown to the host, Trivial Pursuit style first.
const GROUPS = ["Geography", "Entertainment", "History", "Art & Literature", "Sports & Leisure", "Nature", "Animals", "Human body", "Space", "Vehicles"];

// Player icons to pick from when joining (emoji, so they work on every phone).
const ICONS = ["🥔", "🐙", "🦖", "🚀", "🦄", "🐸", "🌵", "🎸", "🐝", "🦊", "👽", "🐢", "🎩", "🍕", "🌈", "🤖"];

const rooms = new Map();

// ---------- game rules ----------
const isYear = (q) => q.unit === "year";
const groupOf = (q) => q.t;
const errOf = (g, q) => (isYear(q) ? Math.abs(g - q.a) / 40 : Math.abs(g - q.a) / q.a);
const isHit = (g, q) => g === q.a || (!isYear(q) && errOf(g, q) <= HIT);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const token = () => crypto.randomBytes(16).toString("hex");

function createRoom() {
  const room = {
    code: newCode(),
    hostToken: token(),
    topics: GROUPS.slice(),
    players: new Map(), // token -> player
    phase: "lobby", // lobby | question | reveal | final
    deck: [],
    index: -1,
    endsAt: 0,
    timer: null,
    clients: new Set(), // { res, role, token }
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function startGame(room) {
  const pool = QUESTIONS.filter((q) => room.topics.includes(groupOf(q)));
  if (!pool.length) return "Pick at least one topic.";
  if (!room.players.size) return "Wait for at least one player to join.";
  room.deck = shuffle(pool).slice(0, Math.min(MAX_ROUNDS, pool.length));
  room.index = -1;
  for (const p of room.players.values()) p.score = 0;
  nextQuestion(room);
  return null;
}

function nextQuestion(room) {
  room.index++;
  if (room.index >= room.deck.length) {
    room.phase = "final";
    clearTimeout(room.timer);
    broadcast(room);
    return;
  }
  room.phase = "question";
  room.endsAt = Date.now() + SECONDS * 1000;
  for (const p of room.players.values()) {
    p.guesses = [];
    p.hit = false;
    p.hitAt = 0;
    p.roundPoints = 0;
  }
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endQuestion(room), SECONDS * 1000 + 250);
  broadcast(room);
}

function endQuestion(room) {
  if (room.phase !== "question") return;
  clearTimeout(room.timer);
  const q = room.deck[room.index];
  for (const p of room.players.values()) {
    if (p.hit) continue;
    let closest = null;
    for (const g of p.guesses) if (closest === null || errOf(g.value, q) < errOf(closest, q)) closest = g.value;
    p.roundPoints = closest === null ? 0 : Math.round(100 * Math.max(0, 1 - errOf(closest, q) * 2));
    p.score += p.roundPoints;
  }
  room.phase = "reveal";
  broadcast(room);
}

function playerGuess(room, p, value) {
  if (room.phase !== "question" || p.hit) return null;
  if (!Number.isFinite(value) || value < 0) return "Type a number first.";
  const q = room.deck[room.index];
  if (isHit(value, q)) {
    const left = Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000));
    p.hit = true;
    p.hitAt = Date.now();
    p.roundPoints = 100 + left * BONUS;
    p.score += p.roundPoints;
    p.guesses.push({ value, dir: "hit" });
  } else {
    p.guesses.push({ value, dir: value < q.a ? "more" : "less" });
  }
  const everyoneHit = [...room.players.values()].every((x) => x.hit || !x.connected);
  if (everyoneHit) endQuestion(room);
  else broadcast(room);
  return null;
}

// ---------- views sent to each screen ----------
function leaderboard(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, icon: p.icon, score: p.score, roundPoints: p.roundPoints || 0, hit: !!p.hit, connected: p.connected }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function questionView(room, withAnswer) {
  const q = room.deck[room.index];
  if (!q) return null;
  const v = { text: q.q, unit: q.unit, topic: q.t, isYear: isYear(q), number: room.index + 1, total: room.deck.length };
  if (withAnswer) {
    v.answer = q.a;
    v.fact = q.fact;
  }
  return v;
}

function hostView(room) {
  const reveal = room.phase === "reveal" || room.phase === "final";
  const players = leaderboard(room).map((p) => {
    const full = [...room.players.values()].find((x) => x.id === p.id);
    return { ...p, tries: full.guesses ? full.guesses.length : 0, hitSeconds: full.hit ? Math.round((full.hitAt - (room.endsAt - SECONDS * 1000)) / 1000) : null };
  });
  return {
    role: "host",
    code: room.code,
    phase: room.phase,
    topics: room.topics,
    groups: GROUPS,
    endsAt: room.endsAt,
    seconds: SECONDS,
    now: Date.now(),
    question: room.phase === "lobby" ? null : questionView(room, reveal),
    players,
  };
}

function playerView(room, p) {
  const reveal = room.phase === "reveal" || room.phase === "final";
  const board = leaderboard(room);
  return {
    role: "player",
    code: room.code,
    phase: room.phase,
    endsAt: room.endsAt,
    seconds: SECONDS,
    now: Date.now(),
    me: {
      name: p.name,
      icon: p.icon,
      score: p.score,
      rank: board.findIndex((x) => x.id === p.id) + 1,
      hit: !!p.hit,
      roundPoints: p.roundPoints || 0,
      guesses: p.guesses || [],
    },
    playerCount: room.players.size,
    players: room.phase === "lobby" || room.phase === "final" ? board.map(({ name, icon, score }) => ({ name, icon, score })) : undefined,
    question: room.phase === "lobby" ? null : questionView(room, reveal),
  };
}

function send(client, room) {
  let view;
  if (client.role === "host") view = hostView(room);
  else {
    const p = room.players.get(client.token);
    if (!p) return;
    view = playerView(room, p);
  }
  client.res.write(`data: ${JSON.stringify(view)}\n\n`);
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const c of room.clients) send(c, room);
}

// ---------- HTTP ----------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC = path.join(__dirname, "public");
const PAGES = { "/": "index.html", "/host": "host.html", "/solo": "solo.html" };

function serveStatic(req, res, pathname) {
  const file = PAGES[pathname] || pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) return json(res, 404, { error: "Not found" });
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // api, rooms, CODE, action

  // Keep-alive: the host screen calls this every few minutes so a free Render instance
  // doesn't fall asleep (and lose the room) while people sit in the lobby.
  if (url.pathname === "/ping") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }

  // Icon list for the phone page
  if (url.pathname === "/icons.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    return res.end(`window.ICONS = ${JSON.stringify(ICONS)};\n`);
  }

  // Question bank for the solo game (solo play checks answers in the browser)
  if (url.pathname === "/questions.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    return res.end(`window.QUESTIONS = ${JSON.stringify(QUESTIONS)};\nwindow.GROUPS = ${JSON.stringify(GROUPS)};\nwindow.ICONS = ${JSON.stringify(ICONS)};\n`);
  }

  if (parts[0] !== "api") return serveStatic(req, res, url.pathname);

  // POST /api/rooms -> create a room (host screen)
  if (req.method === "POST" && parts.length === 2 && parts[1] === "rooms") {
    const room = createRoom();
    return json(res, 200, { code: room.code, hostToken: room.hostToken });
  }

  const room = rooms.get((parts[2] || "").toUpperCase());
  if (parts[1] !== "rooms" || !room) return json(res, 404, { error: "That room doesn't exist. Check the code on the big screen." });

  // HEAD /api/rooms/CODE/events?token=... -> is this token still in the room?
  if (req.method === "HEAD" && parts[3] === "events") {
    const t = url.searchParams.get("token") || "";
    res.writeHead(t === room.hostToken || room.players.has(t) ? 200 : 403);
    return res.end();
  }

  // GET /api/rooms/CODE/events?token=... -> live updates
  if (req.method === "GET" && parts[3] === "events") {
    const t = url.searchParams.get("token") || "";
    const role = t === room.hostToken ? "host" : room.players.has(t) ? "player" : null;
    if (!role) return json(res, 403, { error: "You're not in this room. Join again." });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    const client = { res, role, token: t };
    room.clients.add(client);
    if (role === "player") {
      room.players.get(t).connected = true;
      broadcast(room);
    } else send(client, room);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      room.clients.delete(client);
      if (role === "player") {
        const stillHere = [...room.clients].some((c) => c.token === t);
        const p = room.players.get(t);
        if (p && !stillHere) {
          p.connected = false;
          broadcast(room);
        }
      }
    });
    return;
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readBody(req);

  // POST /api/rooms/CODE/join {name}
  if (parts[3] === "join") {
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (!name) return json(res, 400, { error: "Type your name first." });
    if (room.players.size >= MAX_PLAYERS) return json(res, 400, { error: "This room is full." });
    const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return json(res, 400, { error: "Someone already has that name. Try another one." });
    const icon = ICONS.includes(body.icon) ? body.icon : ICONS[Math.floor(Math.random() * ICONS.length)];
    const t = token();
    room.players.set(t, { id: crypto.randomBytes(6).toString("hex"), name, icon, score: 0, guesses: [], hit: false, roundPoints: 0, connected: false });
    if (room.phase === "question") room.players.get(t).guesses = [];
    broadcast(room);
    return json(res, 200, { token: t });
  }

  // POST /api/rooms/CODE/action {token, type, ...}
  if (parts[3] === "action") {
    const t = String(body.token || "");
    if (t === room.hostToken) {
      let error = null;
      if (body.type === "topics" && room.phase === "lobby") {
        room.topics = GROUPS.filter((g) => Array.isArray(body.topics) && body.topics.includes(g));
        broadcast(room);
      } else if (body.type === "start" && (room.phase === "lobby" || room.phase === "final")) error = startGame(room);
      else if (body.type === "skip" && room.phase === "question") endQuestion(room);
      else if (body.type === "next" && room.phase === "reveal") nextQuestion(room);
      else if (body.type === "lobby" && room.phase === "final") {
        room.phase = "lobby";
        broadcast(room);
      }
      return error ? json(res, 400, { error }) : json(res, 200, { ok: true });
    }
    const p = room.players.get(t);
    if (!p) return json(res, 403, { error: "You're not in this room. Join again." });
    if (body.type === "guess") {
      const error = playerGuess(room, p, Number(body.value));
      return error ? json(res, 400, { error }) : json(res, 200, { ok: true });
    }
    return json(res, 400, { error: "Unknown action" });
  }

  json(res, 404, { error: "Not found" });
});

// Tidy up rooms nobody has used for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_IDLE_MS && room.clients.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Patata! is running on http://localhost:${PORT}`));
