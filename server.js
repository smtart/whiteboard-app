
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10e6,  // 10MB – needed for image data URLs
    perMessageDeflate: true,
});

// ─── Security Headers ────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// ─── Static Files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
}));

// ─── Health Check ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: rooms.size,
        connections: io.engine.clientsCount,
        uptime: Math.floor(process.uptime()),
    });
});

// ─── Room State ──────────────────────────────────────────────────────
const rooms = new Map();

const USER_COLORS = [
    '#e03131', '#2f9e44', '#1971c2', '#9c36b5', '#e8590c',
    '#0c8599', '#6741d9', '#c2255c', '#f08c00', '#087f5b',
];

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            elements: new Map(),
            users: new Map(),
            createdAt: Date.now(),
        });
    }
    return rooms.get(roomId);
}

function pickUserColor(room) {
    const used = new Set([...room.users.values()].map(u => u.color));
    return USER_COLORS.find(c => !used.has(c)) ||
        USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

// ─── Rate Limiting ───────────────────────────────────────────────────
const rateBuckets = new Map();

function rateOk(socketId, limit = 200) {
    const now = Date.now();
    let b = rateBuckets.get(socketId);
    if (!b || now > b.reset) {
        b = { count: 0, reset: now + 1000 };
        rateBuckets.set(socketId, b);
    }
    return ++b.count <= limit;
}

// ─── Validation ──────────────────────────────────────────────────────
const VALID_TYPES = new Set([
    'pen', 'rectangle', 'ellipse', 'line', 'arrow', 'text', 'image',
]);

function validElement(el) {
    if (!el || typeof el !== 'object') return false;
    if (typeof el.id !== 'string' || el.id.length > 64) return false;
    if (!VALID_TYPES.has(el.type)) return false;
    return true;
}

// ─── Socket.io ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
    let roomId = null;
    let userName = 'User ' + Math.floor(1000 + Math.random() * 9000);

    // ── Join Room ──────────────────────────────────────────────────────
    socket.on('join-room', (data) => {
        if (!data || typeof data.roomId !== 'string') return;
        if (data.roomId.length > 50) return;

        roomId = data.roomId;
        if (data.name && typeof data.name === 'string') {
            userName = data.name.slice(0, 30);
        }

        socket.join(roomId);
        const room = getOrCreateRoom(roomId);
        const color = pickUserColor(room);

        room.users.set(socket.id, { name: userName, color, cursor: null });

        // Send full room state to the new user
        socket.emit('room-state', {
            elements: [...room.elements.values()],
            users: Object.fromEntries(
                [...room.users.entries()].map(([id, u]) => [id, { name: u.name, color: u.color }])
            ),
            yourId: socket.id,
            yourColor: color,
        });

        // Tell others about the new user
        socket.to(roomId).emit('user-joined', {
            id: socket.id,
            name: userName,
            color,
        });

        console.log(`[${roomId}] ${userName} joined (${room.users.size} users)`);
    });

    // ── Element Events ─────────────────────────────────────────────────
    socket.on('add-element', (el) => {
        if (!roomId || !rateOk(socket.id) || !validElement(el)) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.elements.set(el.id, el);
        socket.to(roomId).emit('element-added', el);
    });

    socket.on('update-element', (el) => {
        if (!roomId || !rateOk(socket.id) || !validElement(el)) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.elements.set(el.id, el);
        socket.to(roomId).emit('element-updated', el);
    });

    // ── Live drawing preview (high-frequency, not persisted) ───────────
    socket.on('drawing-preview', (el) => {
        if (!roomId || !rateOk(socket.id, 600)) return; // higher rate limit
        if (!el || typeof el !== 'object') return;
        socket.to(roomId).emit('drawing-preview', { userId: socket.id, el });
    });

    socket.on('drawing-done', (data) => {
        if (!roomId) return;
        socket.to(roomId).emit('drawing-done', { userId: socket.id, ...data });
    });

    // ── Text live sync ─────────────────────────────────────────────────
    socket.on('text-preview', (el) => {
        if (!roomId || !rateOk(socket.id, 400)) return;
        if (!el || typeof el !== 'object') return;
        // Update stored element so new joiners see current text
        const room = rooms.get(roomId);
        if (room && room.elements.has(el.id)) {
            const stored = room.elements.get(el.id);
            stored.text = el.text;
        }
        socket.to(roomId).emit('text-preview', el);
    });

    socket.on('text-lock', (data) => {
        if (!roomId || !data || typeof data.id !== 'string') return;
        socket.to(roomId).emit('text-lock', data);
    });

    socket.on('text-unlock', (data) => {
        if (!roomId || !data || typeof data.id !== 'string') return;
        socket.to(roomId).emit('text-unlock', data);
    });

    socket.on('delete-elements', (ids) => {
        if (!roomId || !rateOk(socket.id)) return;
        if (!Array.isArray(ids)) return;
        const room = rooms.get(roomId);
        if (!room) return;
        ids.forEach(id => { if (typeof id === 'string') room.elements.delete(id); });
        socket.to(roomId).emit('elements-deleted', ids);
    });

    // ── Cursor ─────────────────────────────────────────────────────────
    socket.on('cursor-move', (cur) => {
        if (!roomId || !rateOk(socket.id, 30)) return;
        if (!cur || typeof cur.x !== 'number' || typeof cur.y !== 'number') return;
        const room = rooms.get(roomId);
        if (!room) return;
        const u = room.users.get(socket.id);
        if (u) u.cursor = { x: cur.x, y: cur.y };
        socket.to(roomId).emit('cursor-moved', { id: socket.id, x: cur.x, y: cur.y });
    });

    // ── Clear Board ────────────────────────────────────────────────────
    socket.on('clear-board', () => {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.elements.clear();
        io.to(roomId).emit('board-cleared');
        console.log(`[${roomId}] Board cleared by ${userName}`);
    });

    // ── Disconnect ─────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        rateBuckets.delete(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        room.users.delete(socket.id);
        socket.to(roomId).emit('user-left', { id: socket.id });
        console.log(`[${roomId}] ${userName} left (${room.users.size} users)`);

        // Schedule cleanup of empty rooms
        if (room.users.size === 0) {
            setTimeout(() => {
                const r = rooms.get(roomId);
                if (r && r.users.size === 0) rooms.delete(roomId);
            }, 5 * 60 * 1000);
        }
    });
});

// ─── Periodic Cleanup ────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (room.users.size === 0 && now - room.createdAt > 24 * 3600 * 1000) {
            rooms.delete(id);
        }
    }
}, 3600 * 1000);

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n  SketchFlow server running → http://localhost:${PORT}\n`);
});
