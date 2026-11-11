// Watch party server — zero dependencies. Run: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function makeCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += a[crypto.randomInt(a.length)];
  return rooms.has(s) ? makeCode() : s;
}

const sse = (res, ev, data) =>
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

const broadcast = (room, ev, data) =>
  room.clients.forEach((c) => sse(c.res, ev, data));

const roster = (room) =>
  [...room.clients.values()].map((c) => ({
    id: c.id,
    name: c.name,
    host: c.host,
  }));

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const validUrl = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

function body(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  // Serve frontend
  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }

  // Create room
  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const b = await body(req);

    if (!validUrl(b.embedUrl)) {
      return json(res, 400, { error: "Embed URL must be https" });
    }

    const code = makeCode();
    const hostToken = crypto.randomBytes(16).toString("hex");

    rooms.set(code, {
      code,
      hostToken,
      embedUrl: b.embedUrl,
      clients: new Map(),
      player: null,
      yt: null,
      vidrift: null,
      last: Date.now(),
    });

    return json(res, 200, { code, hostToken });
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const room = rooms.get(parts[2].toUpperCase());

    if (!room) {
      return json(res, 404, { error: "Room not found" });
    }

    room.last = Date.now();

    if (req.method === "GET" && !parts[3]) {
      return json(res, 200, { ok: true });
    }

    // Server-sent event stream
    if (req.method === "GET" && parts[3] === "events") {
      const id = crypto.randomBytes(6).toString("hex");
      const name = (url.searchParams.get("name") || "Guest").slice(0, 24);
      const host = url.searchParams.get("token") === room.hostToken;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      room.clients.set(id, { id, name, host, res });

      const yt = room.yt && {
        playing: room.yt.playing,
        idx: room.yt.idx,
        time:
          room.yt.time +
          (room.yt.playing ? (Date.now() - room.yt.at) / 1000 : 0),
      };

      const vidrift = room.vidrift && {
        playing: room.vidrift.playing,
        time:
          room.vidrift.time +
          (room.vidrift.playing ? (Date.now() - room.vidrift.at) / 1000 : 0),
        duration: room.vidrift.duration || 0,
      };

      sse(res, "hello", {
        id,
        host,
        embedUrl: room.embedUrl,
        player: room.player,
        yt,
        vidrift,
        queue: room.queue || null,
        code: room.code,
      });

      broadcast(room, "roster", roster(room));

      const hb = setInterval(() => res.write(": hb\n\n"), 20000);

      req.on("close", () => {
        clearInterval(hb);
        room.clients.delete(id);
        broadcast(room, "roster", roster(room));
      });

      return;
    }

    // Room actions
    if (req.method === "POST" && parts[3] === "act") {
      const b = await body(req);
      const c = room.clients.get(b.id);

      if (!c) {
        return json(res, 403, { error: "Not connected" });
      }

      const hostOnly = [
        "seturl",
        "countdown",
        "callout",
        "player",
        "ytstate",
        "ytqueue",
        "vstate",
        "vseek",
      ];

      if (hostOnly.includes(b.type) && !c.host) {
        return json(res, 403, { error: "Host only" });
      }

      switch (b.type) {
        case "chat": {
          const text = String(b.text || "")
            .slice(0, 500)
            .trim();

          if (text) {
            broadcast(room, "chat", {
              name: c.name,
              host: c.host,
              text,
              t: Date.now(),
            });
          }
          break;
        }

        case "seturl":
          if (!validUrl(b.url)) {
            return json(res, 400, { error: "Must be https" });
          }

          room.embedUrl = b.url;
          room.player = null;
          room.yt = null;
          room.queue = null;
          room.vidrift = null;
          room.lastToggle = null;

          broadcast(room, "seturl", { url: b.url });
          break;

        case "ytqueue": {
          // Ordered YouTube video IDs and durations
          const ids = Array.isArray(b.ids) ? b.ids : [];
          const durs = Array.isArray(b.durs) ? b.durs : [];

          const keep = ids
            .map((id, i) => ({ id, d: +durs[i] }))
            .filter((x) => /^[\w-]{11}$/.test(x.id) && x.d > 0)
            .slice(0, 500);

          if (!keep.length) {
            return json(res, 400, { error: "No valid videos" });
          }

          room.queue = {
            ids: keep.map((x) => x.id),
            durs: keep.map((x) => x.d),
          };

          room.yt = null;
          room.lastToggle = null;

          broadcast(room, "ytqueue", room.queue);
          break;
        }

        case "ytstate": {
          // Host heartbeat / seek
          // Ignore stale heartbeat that would undo a recent toggle
          const lt = room.lastToggle;

          if (
            b.hb &&
            lt &&
            Date.now() - lt.at < 2500 &&
            !!b.playing !== lt.playing
          ) {
            break;
          }

          room.yt = {
            playing: !!b.playing,
            time: +b.time || 0,
            at: Date.now(),
            idx: Number.isInteger(b.idx) ? b.idx : null,
          };

          broadcast(room, "ytstate", {
            playing: room.yt.playing,
            time: room.yt.time,
            idx: room.yt.idx,
            by: c.id,
            kind: "state",
          });
          break;
        }

        case "ytplay":
          // Anyone can play or pause
          room.yt = {
            playing: !!b.playing,
            time: +b.time || 0,
            at: Date.now(),
            idx: Number.isInteger(b.idx) ? b.idx : room.yt ? room.yt.idx : null,
          };

          room.lastToggle = {
            at: Date.now(),
            playing: room.yt.playing,
          };

          broadcast(room, "ytstate", {
            playing: room.yt.playing,
            time: room.yt.time,
            idx: room.yt.idx,
            by: c.id,
            kind: "toggle",
          });
          break;

        case "vstate":
        case "vseek": {
          // Host state updates and seeking
          const lt = room.lastVidriftToggle;
          if ((b.kind === "progress" || b.kind === "state") && lt && Date.now() - lt.at < 2500 && !!b.playing !== lt.playing) break;
          const time = Math.max(0, Number(b.time) || 0);

          room.vidrift = {
            playing: !!b.playing,
            time,
            duration: Math.max(
              0,
              Number(b.duration) ||
                (room.vidrift && room.vidrift.duration) ||
                0,
            ),
            at: Date.now(),
          };

          broadcast(room, "vstate", {
            playing: room.vidrift.playing,
            time: room.vidrift.time,
            duration: room.vidrift.duration,
            by: c.id,
            kind: b.kind || (b.type === "vseek" ? "seek" : "state"),
          });
          break;
        }

        case "vplay": {
          // Anyone can play or pause
          const time = Math.max(0, Number(b.time) || 0);

          room.vidrift = {
            playing: !!b.playing,
            time,
            duration: Math.max(
              0,
              Number(b.duration) ||
                (room.vidrift && room.vidrift.duration) ||
                0,
            ),
            at: Date.now(),
          };

          room.lastVidriftToggle = {
            at: Date.now(),
            playing: room.vidrift.playing,
          };

          broadcast(room, "vstate", {
            playing: room.vidrift.playing,
            time: room.vidrift.time,
            duration: room.vidrift.duration,
            by: c.id,
            kind: "toggle",
          });
          break;
        }

        case "countdown":
          broadcast(room, "countdown", {
            n: Math.min(Math.max(+b.n || 3, 1), 10),
          });
          break;

        case "callout":
          broadcast(room, "callout", {
            kind: b.kind,
            time: b.time || null,
          });
          break;

        case "player":
          room.player = {
            event: String(b.event).slice(0, 20),
            time: +b.time || 0,
            at: Date.now(),
          };

          broadcast(room, "player", room.player);
          break;
      }

      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { error: "Not found" });
});

// Clean up idle empty rooms
setInterval(() => {
  for (const [k, r] of rooms) {
    if (!r.clients.size && Date.now() - r.last > 6 * 3600e3) {
      rooms.delete(k);
    }
  }
}, 600e3);

server.listen(PORT, () => {
  console.log(`Watch party running on http://localhost:${PORT}`);
});
