/* ═══════════════════════════════════════════════════════════════════════
   SketchFlow — Collaborative Whiteboard Engine
   ═══════════════════════════════════════════════════════════════════════ */

// ─── CONSTANTS ───────────────────────────────────────────────────────
const COLORS = [
    '#e6edf3', '#f87171', '#fb923c', '#facc15', '#4ade80',
    '#34d399', '#22d3ee', '#60a5fa', '#818cf8', '#c084fc',
    '#f472b6', '#000000', '#343a40', '#868e96',
];
const FILL_COLORS = [
    'transparent', '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0',
    '#a7f3d0', '#a5f3fc', '#bfdbfe', '#c7d2fe', '#e9d5ff', '#fbcfe8',
];

const MIN_ZOOM = 0.1, MAX_ZOOM = 5, ZOOM_STEP = 0.1;
const GRID_SIZE = 40;
const HIT_MARGIN = 8;

// ─── STATE ───────────────────────────────────────────────────────────
const S = {
    view: 'landing',
    roomId: null, myId: null, myColor: '#818cf8',
    elements: new Map(),
    tool: 'select',
    strokeColor: '#e6edf3', fillColor: 'transparent',
    strokeWidth: 2, fontSize: 20, opacity: 1,
    vp: { x: 0, y: 0, zoom: 1 },
    drawing: false, current: null,
    selectedIds: new Set(),
    dragStart: null, dragOrigPositions: null,
    isPanning: false, panStart: null, spaceHeld: false,
    handMode: false, prevTool: 'select',
    showGrid: true, theme: 'dark',
    history: [], historyIdx: -1,
    cursors: new Map(), cursorTargets: new Map(), users: new Map(),
    needsRender: true,
    resizing: false, resizeHandle: null, resizeStart: null, resizeOrigEl: null,
    remotePreviews: new Map(), // userId -> in-progress element
    eraserSize: 16,
    eraserScreenPos: null, // {x, y} screen coords for canvas cursor circle
};

// ─── DOM REFS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const landing = $('landing'), app = $('app');
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const roomDisplay = $('room-id-display'), inviteBtn = $('invite-btn');
const undoBtn = $('undo-btn'), redoBtn = $('redo-btn');
const strokeColorInput = $('stroke-color'), fillColorInput = $('fill-color');
const strokeWidthInput = $('stroke-width'), widthVal = $('width-value');
const opacityInput = $('opacity-range'), opacityVal = $('opacity-value');
const fillSection = $('fill-section');
const zoomDisplay = $('zoom-level'), cursorPosDisplay = $('cursor-pos');
const textInput = $('text-input');
const toolBtns = document.querySelectorAll('.tool-btn[data-tool]');
const usersContainer = $('users-container');

// ─── SOCKET ──────────────────────────────────────────────────────────
const socket = io({ transports: ['polling', 'websocket'], upgrade: true });

// ─── UTILS ───────────────────────────────────────────────────────────
function uid() {
    return crypto.randomUUID ? crypto.randomUUID() :
        'xxxx-xxxx-xxxx'.replace(/x/g, () => (Math.random() * 16 | 0).toString(16));
}

function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn(...args); }
    };
}

function screenToWorld(sx, sy) {
    return {
        x: sx / S.vp.zoom + S.vp.x,
        y: sy / S.vp.zoom + S.vp.y,
    };
}

function worldToScreen(wx, wy) {
    return {
        x: (wx - S.vp.x) * S.vp.zoom,
        y: (wy - S.vp.y) * S.vp.zoom,
    };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function showToast(msg, duration = 2500) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    $('toast-container').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, duration);
}

function showModal(msg, confirmLabel = 'Confirm', cancelLabel = 'Cancel') {
    return new Promise(resolve => {
        $('modal-message').textContent = msg;
        $('modal-confirm').textContent = confirmLabel;
        $('modal-cancel').textContent = cancelLabel;
        $('modal-overlay').classList.remove('hidden');
        const yes = () => { cleanup(); resolve(true); };
        const no = () => { cleanup(); resolve(false); };
        const cleanup = () => {
            $('modal-overlay').classList.add('hidden');
            $('modal-confirm').removeEventListener('click', yes);
            $('modal-cancel').removeEventListener('click', no);
        };
        $('modal-confirm').addEventListener('click', yes);
        $('modal-cancel').addEventListener('click', no);
    });
}

// ─── HISTORY ─────────────────────────────────────────────────────────
// Undo/redo is LOCAL per user — restoring does NOT broadcast a board wipe.
// Each snapshot is a full deep-copy of S.elements at that point in time.
const MAX_HISTORY = 80;

function snapshot() {
    const snap = new Map();
    S.elements.forEach((el, id) => snap.set(id, JSON.parse(JSON.stringify(el))));
    return snap;
}

function pushHistory() {
    // Discard any "future" states if we branched
    S.history = S.history.slice(0, S.historyIdx + 1);
    S.history.push(snapshot());
    S.historyIdx = S.history.length - 1;
    // Cap size — drop oldest
    if (S.history.length > MAX_HISTORY) {
        S.history.shift();
        S.historyIdx = S.history.length - 1;
    }
    updateUndoRedo();
}

function undo() {
    if (S.historyIdx <= 0) return;
    S.historyIdx--;
    restoreSnapshot(S.history[S.historyIdx]);
}

function redo() {
    if (S.historyIdx >= S.history.length - 1) return;
    S.historyIdx++;
    restoreSnapshot(S.history[S.historyIdx]);
}

// Restore local canvas from snapshot — never broadcasts a board wipe to others.
// Uses targeted add/update/delete diffs to sync the server efficiently.
function restoreSnapshot(snap) {
    const prev = S.elements;

    S.elements = new Map();
    snap.forEach((el, id) => S.elements.set(id, JSON.parse(JSON.stringify(el))));
    S.selectedIds.clear();

    // Diff: figure out what changed vs what was on the server before
    // Add/update elements now in snap
    S.elements.forEach((el, id) => {
        const old = prev.get(id);
        if (!old) {
            socket.emit('add-element', el);          // element restored (re-add)
        } else if (JSON.stringify(old) !== JSON.stringify(el)) {
            socket.emit('update-element', el);       // element changed
        }
    });
    // Delete elements that no longer exist in the restored snap
    prev.forEach((el, id) => {
        if (!S.elements.has(id)) {
            socket.emit('delete-elements', [id]);    // element was undone away
        }
    });

    updateUndoRedo();
    requestRender();
}

function updateUndoRedo() {
    if (!undoBtn || !redoBtn) return;
    undoBtn.disabled = S.historyIdx <= 0;
    redoBtn.disabled = S.historyIdx >= S.history.length - 1;
}

// Full board sync — used only for explicit actions, NOT for undo/redo
function syncAllElements() {
    socket.emit('clear-board');
    S.elements.forEach(el => socket.emit('add-element', el));
}

// ─── ELEMENT MODEL ───────────────────────────────────────────────────
function createElement(type, extra = {}) {
    return {
        id: uid(), type,
        style: {
            strokeColor: S.strokeColor,
            fillColor: S.fillColor,
            strokeWidth: S.strokeWidth,
            fontSize: S.fontSize,
            opacity: S.opacity,
        },
        ...extra,
    };
}

function getElementBounds(el) {
    switch (el.type) {
        case 'pen': {
            if (!el.points || !el.points.length) return { x: 0, y: 0, w: 0, h: 0 };
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            el.points.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        case 'rectangle': case 'ellipse':
            return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
        case 'line': case 'arrow':
            return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
        case 'text': {
            ctx.font = `${el.style.fontSize}px Inter, sans-serif`;
            const lines = (el.text || '').split('\n');
            const w = Math.max(...lines.map(l => ctx.measureText(l).width), 20);
            return { x: el.x, y: el.y, w, h: lines.length * el.style.fontSize * 1.3 };
        }
        case 'image':
            return { x: el.x, y: el.y, w: el.w || 200, h: el.h || 200 };
        default: return { x: 0, y: 0, w: 0, h: 0 };
    }
}

function hitTest(el, wx, wy) {
    const m = HIT_MARGIN / S.vp.zoom;
    const b = getElementBounds(el);
    const expanded = { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
    if (wx < expanded.x || wx > expanded.x + expanded.w || wy < expanded.y || wy > expanded.y + expanded.h) return false;

    if (el.type === 'pen' && el.points) {
        for (let i = 1; i < el.points.length; i++) {
            if (distToSeg(wx, wy, el.points[i - 1].x, el.points[i - 1].y, el.points[i].x, el.points[i].y) < m + el.style.strokeWidth) return true;
        }
        return false;
    }
    if (el.type === 'line' || el.type === 'arrow') {
        return distToSeg(wx, wy, el.x1, el.y1, el.x2, el.y2) < m + el.style.strokeWidth;
    }
    return true;
}

function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? clamp(((px - x1) * dx + (py - y1) * dy) / lenSq, 0, 1) : 0;
    const nx = x1 + t * dx, ny = y1 + t * dy;
    return Math.hypot(px - nx, py - ny);
}

function moveElement(el, dx, dy) {
    switch (el.type) {
        case 'pen': el.points.forEach(p => { p.x += dx; p.y += dy; }); break;
        case 'rectangle': case 'ellipse': el.x += dx; el.y += dy; break;
        case 'line': case 'arrow': el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy; break;
        case 'text': el.x += dx; el.y += dy; break;
        case 'image': el.x += dx; el.y += dy; break;
    }
}

// ─── RENDERER ────────────────────────────────────────────────────────
let renderRequested = false;
function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(render);
    }
}

function render() {
    renderRequested = false;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr; canvas.height = ch * dpr;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fill canvas background
    const theme = document.documentElement.getAttribute('data-theme');
    ctx.fillStyle = theme === 'dark' ? '#1a1a2e' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);

    // Apply viewport transform
    ctx.save();
    ctx.translate(-S.vp.x * S.vp.zoom, -S.vp.y * S.vp.zoom);
    ctx.scale(S.vp.zoom, S.vp.zoom);

    if (S.showGrid) drawGrid(cw, ch);

    // Draw all elements
    S.elements.forEach(el => {
        // Skip element being actively typed — the textarea DOM overlay covers it
        if (el.id === textEditingId) {
            // Draw a subtle editing indicator for the local user
            const b = getElementBounds(el);
            ctx.save();
            ctx.strokeStyle = 'rgba(129, 140, 248, 0.3)';
            ctx.lineWidth = 1 / S.vp.zoom;
            ctx.setLineDash([4 / S.vp.zoom, 4 / S.vp.zoom]);
            ctx.strokeRect(b.x - 4 / S.vp.zoom, b.y - 4 / S.vp.zoom, b.w + 8 / S.vp.zoom, b.h + 8 / S.vp.zoom);
            ctx.restore();
            return;
        }
        // Draw a lock indicator for text locked by remote users
        if (el.type === 'text' && textLocked === el.id) {
            drawElement(el);
            const b = getElementBounds(el);
            ctx.save();
            ctx.strokeStyle = 'rgba(251, 146, 60, 0.5)';
            ctx.lineWidth = 1.5 / S.vp.zoom;
            ctx.setLineDash([3 / S.vp.zoom, 3 / S.vp.zoom]);
            ctx.strokeRect(b.x - 3 / S.vp.zoom, b.y - 3 / S.vp.zoom, b.w + 6 / S.vp.zoom, b.h + 6 / S.vp.zoom);
            ctx.restore();
            return;
        }
        drawElement(el);
    });
    if (S.current) drawElement(S.current);
    // Draw other users' in-progress strokes
    S.remotePreviews.forEach(el => drawElement(el));

    // Draw selection
    S.selectedIds.forEach(id => {
        const el = S.elements.get(id);
        if (el) drawSelectionBox(el);
    });

    ctx.restore(); // viewport

    // Reposition the text overlay if currently editing
    repositionTextInput();

    // Draw cursors in screen space
    drawRemoteCursors();

    // Draw eraser cursor circle
    if (S.tool === 'eraser' && S.eraserScreenPos) {
        const r = (S.eraserSize / 2) * S.vp.zoom;
        ctx.beginPath();
        ctx.arc(S.eraserScreenPos.x, S.eraserScreenPos.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(129, 140, 248, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(129, 140, 248, 0.08)';
        ctx.fill();
    }

    ctx.restore(); // dpr
}

function drawGrid(cw, ch) {
    const startX = Math.floor(S.vp.x / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(S.vp.y / GRID_SIZE) * GRID_SIZE;
    const endX = S.vp.x + cw / S.vp.zoom;
    const endY = S.vp.y + ch / S.vp.zoom;
    const theme = document.documentElement.getAttribute('data-theme');
    ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1 / S.vp.zoom;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += GRID_SIZE) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
    for (let y = startY; y <= endY; y += GRID_SIZE) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
    ctx.stroke();
}

function drawElement(el) {
    ctx.globalAlpha = el.style.opacity;
    ctx.strokeStyle = el.style.strokeColor;
    ctx.fillStyle = el.style.fillColor || 'transparent';
    ctx.lineWidth = el.style.strokeWidth;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    switch (el.type) {
        case 'pen': drawPen(el); break;
        case 'rectangle': drawRect(el); break;
        case 'ellipse': drawEllipse(el); break;
        case 'line': drawLine(el); break;
        case 'arrow': drawArrow(el); break;
        case 'text': drawText(el); break;
        case 'image': drawImageEl(el); break;
    }
    ctx.globalAlpha = 1;
}

function drawPen(el) {
    if (!el.points || el.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length - 1; i++) {
        const xc = (el.points[i].x + el.points[i + 1].x) / 2;
        const yc = (el.points[i].y + el.points[i + 1].y) / 2;
        ctx.quadraticCurveTo(el.points[i].x, el.points[i].y, xc, yc);
    }
    const last = el.points[el.points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
}

function drawRect(el) {
    const x = Math.min(el.x, el.x + el.w), y = Math.min(el.y, el.y + el.h);
    const w = Math.abs(el.w), h = Math.abs(el.h);
    if (el.style.fillColor && el.style.fillColor !== 'transparent') {
        ctx.fillRect(x, y, w, h);
    }
    ctx.strokeRect(x, y, w, h);
}

function drawEllipse(el) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    const rx = Math.abs(el.w / 2), ry = Math.abs(el.h / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (el.style.fillColor && el.style.fillColor !== 'transparent') ctx.fill();
    ctx.stroke();
}

function drawLine(el) {
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1); ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
}

function drawArrow(el) {
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1); ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
    const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const hl = 14;
    ctx.beginPath();
    ctx.moveTo(el.x2, el.y2);
    ctx.lineTo(el.x2 - hl * Math.cos(angle - 0.4), el.y2 - hl * Math.sin(angle - 0.4));
    ctx.moveTo(el.x2, el.y2);
    ctx.lineTo(el.x2 - hl * Math.cos(angle + 0.4), el.y2 - hl * Math.sin(angle + 0.4));
    ctx.stroke();
}

function drawText(el) {
    if (!el.text) return;
    ctx.font = `${el.style.fontSize}px Inter, sans-serif`;
    ctx.fillStyle = el.style.strokeColor;
    ctx.textBaseline = 'top';
    el.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, el.x, el.y + i * el.style.fontSize * 1.3);
    });
}

// Image cache so we don't reload img objects on every frame
const imgCache = new Map();
function drawImageEl(el) {
    if (!el.src) return;
    let img = imgCache.get(el.id);
    if (!img) {
        img = new Image();
        img.src = el.src;
        img.onload = () => requestRender();
        imgCache.set(el.id, img);
    }
    if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, el.x, el.y, el.w || 200, el.h || 200);
    }
}

function drawSelectionBox(el) {
    const b = getElementBounds(el);
    const pad = 6 / S.vp.zoom;
    const handleSize = 5 / S.vp.zoom;
    ctx.save();
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 1.5 / S.vp.zoom;
    ctx.setLineDash([6 / S.vp.zoom, 4 / S.vp.zoom]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);

    // Draw corner resize handles
    ctx.fillStyle = '#818cf8';
    const corners = [
        { x: b.x - pad, y: b.y - pad },
        { x: b.x + b.w + pad, y: b.y - pad },
        { x: b.x - pad, y: b.y + b.h + pad },
        { x: b.x + b.w + pad, y: b.y + b.h + pad },
    ];
    corners.forEach(c => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, handleSize, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

function getResizeHandle(el, wx, wy) {
    const b = getElementBounds(el);
    const pad = 6 / S.vp.zoom;
    const hitR = 10 / S.vp.zoom;
    const corners = [
        { name: 'tl', x: b.x - pad, y: b.y - pad },
        { name: 'tr', x: b.x + b.w + pad, y: b.y - pad },
        { name: 'bl', x: b.x - pad, y: b.y + b.h + pad },
        { name: 'br', x: b.x + b.w + pad, y: b.y + b.h + pad },
    ];
    for (const c of corners) {
        if (Math.hypot(wx - c.x, wy - c.y) < hitR) return c.name;
    }
    return null;
}

function drawRemoteCursors() {
    const LERP_SPEED = 0.25;
    let needsMore = false;

    S.cursorTargets.forEach((target, id) => {
        let cur = S.cursors.get(id);
        if (!cur) {
            cur = { x: target.x, y: target.y };
            S.cursors.set(id, cur);
        }

        // Lerp toward target
        cur.x = lerp(cur.x, target.x, LERP_SPEED);
        cur.y = lerp(cur.y, target.y, LERP_SPEED);

        // Keep animating if not close enough
        if (Math.abs(cur.x - target.x) > 0.5 || Math.abs(cur.y - target.y) > 0.5) {
            needsMore = true;
        }

        const user = S.users.get(id);
        if (!user) return;
        const sp = worldToScreen(cur.x, cur.y);
        ctx.save();
        ctx.translate(sp.x, sp.y);
        // Cursor arrow
        ctx.fillStyle = user.color;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, 14); ctx.lineTo(4, 11); ctx.lineTo(9, 18); ctx.lineTo(12, 16);
        ctx.lineTo(7, 9); ctx.lineTo(12, 8); ctx.closePath();
        ctx.fill();
        // Label
        ctx.font = '10px Inter, sans-serif';
        const name = user.name || 'User';
        const tw = ctx.measureText(name).width;
        ctx.fillStyle = user.color;
        ctx.beginPath();
        ctx.roundRect(14, 14, tw + 8, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(name, 18, 26);
        ctx.restore();
    });

    // Continue animating if cursors are still moving
    if (needsMore) requestRender();
}

// ─── POINTER HANDLERS ────────────────────────────────────────────────
function getPointerWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    return { sx, sy, ...screenToWorld(sx, sy) };
}

// ─── Long-press to pan (mobile) ──────────────────────────────────────
let longPressTimer = null;
let longPressFired = false;
const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_THRESHOLD = 8; // px movement cancels long-press
// Double-tap constants (used in both pointerdown handler and double-tap listener)
const DOUBLE_TAP_DELAY = 300; // ms
const DOUBLE_TAP_DIST = 40;   // px tolerance

function cancelLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

function handlePointerDown(e) {
    // Hand mode — always pan, ignore drawing tools
    if (S.handMode || e.button === 1 || (e.button === 0 && S.spaceHeld)) {
        S.isPanning = true;
        S.panStart = { x: e.clientX, y: e.clientY, vpx: S.vp.x, vpy: S.vp.y };
        canvas.style.cursor = 'grabbing';
        return;
    }
    if (e.button !== 0) return;

    // Start long-press timer on touch devices
    longPressFired = false;
    if (e.pointerType === 'touch') {
        const startX = e.clientX, startY = e.clientY;
        longPressTimer = setTimeout(() => {
            longPressFired = true;
            S.isPanning = true;
            S.panStart = { x: startX, y: startY, vpx: S.vp.x, vpy: S.vp.y };
            S.drawing = false;   // cancel any in-progress draw
            S.current = null;
            canvas.style.cursor = 'grabbing';
            // Haptic feedback
            if (navigator.vibrate) navigator.vibrate(30);
            requestRender();
        }, LONG_PRESS_MS);

        // Store start coords to detect movement cancellation
        S._longPressStart = { x: startX, y: startY };
    } else {
        // Store mouse start coords too (for drag detection in text tool)
        S._longPressStart = { x: e.clientX, y: e.clientY };
    }

    const p = getPointerWorld(e);

    // For text tool on touch: cancel long-press immediately (don't pan) and
    // prevent touch-to-mouse simulation so we stay in the gesture boundary
    if (S.tool === 'text' && e.pointerType === 'touch') {
        cancelLongPress();
        e.preventDefault();
    }

    S.drawing = true;

    switch (S.tool) {
        case 'select': handleSelectDown(p); break;
        case 'pen': handlePenDown(p); break;
        case 'rectangle': case 'ellipse': handleShapeDown(p); break;
        case 'line': case 'arrow': handleLineDown(p); break;
        case 'text':
            if (e.pointerType === 'touch') {
                // Mobile: delay opening the editor by the double-tap window.
                clearTimeout(S._textTapTimer);
                S._textTapTimer = setTimeout(() => {
                    S._textTapTimer = null;
                    handleTextDown(p, e);
                }, DOUBLE_TAP_DELAY + 30);
            } else {
                // Desktop: detect double-click HERE in pointerdown (before click fires)
                // by tracking click timing ourselves.
                const now = Date.now();
                const mdx = e.clientX - (S._lastTextClickX || 0);
                const mdy = e.clientY - (S._lastTextClickY || 0);
                const isDoubleClick = (now - (S._lastTextClickTime || 0)) < 350
                    && Math.hypot(mdx, mdy) < 40;

                // Hit-test for existing text at this point
                let textHit = null;
                for (const el of [...S.elements.values()].reverse()) {
                    if (el.type === 'text' && hitTest(el, p.x, p.y)) { textHit = el; break; }
                }

                if (isDoubleClick && textHit) {
                    e.preventDefault();
                    clearTimeout(_desktopTextTimer);
                    _desktopTextTimer = null;
                    S._pendingTextPoint = null;
                    S._lastTextClickTime = 0;
                    S.drawing = false; // prevent stuck drag state
                    selectTextElement(textHit);
                    return;
                }

                // Track this click for future double-click detection
                S._lastTextClickTime = now;
                S._lastTextClickX = e.clientX;
                S._lastTextClickY = e.clientY;

                // Defer to click event
                S._pendingTextPoint = p;
            }
            break;
        case 'eraser': handleEraserDown(p); break;
    }
}

function handlePointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    cursorPosDisplay.textContent = `${Math.round(w.x)}, ${Math.round(w.y)}`;

    // Track eraser cursor position for canvas circle
    if (S.tool === 'eraser') {
        S.eraserScreenPos = { x: sx, y: sy };
        requestRender();
    }

    // Emit cursor
    throttledCursorEmit(w.x, w.y);

    // Cancel long-press if finger moved too far before it fired
    if (longPressTimer && S._longPressStart) {
        const moved = Math.hypot(e.clientX - S._longPressStart.x, e.clientY - S._longPressStart.y);
        if (moved > LONG_PRESS_MOVE_THRESHOLD) cancelLongPress();
    }

    // Clear pending text point if mouse moved (it was a drag, not a click)
    if (S._pendingTextPoint && S._longPressStart) {
        const moved = Math.hypot(e.clientX - S._longPressStart.x, e.clientY - S._longPressStart.y);
        if (moved > 5) S._pendingTextPoint = null;
    }

    if (S.isPanning) {
        const dx = (e.clientX - S.panStart.x) / S.vp.zoom;
        const dy = (e.clientY - S.panStart.y) / S.vp.zoom;
        S.vp.x = S.panStart.vpx - dx;
        S.vp.y = S.panStart.vpy - dy;
        requestRender();
        return;
    }
    if (!S.drawing) {
        updateCursor(w);
        return;
    }
    const p = { sx, sy, ...w };

    switch (S.tool) {
        case 'select': handleSelectMove(p); break;
        case 'pen': handlePenMove(p, e); break;
        case 'rectangle': case 'ellipse': handleShapeMove(p, e.shiftKey); break;
        case 'line': case 'arrow': handleLineMove(p, e.shiftKey); break;
        case 'eraser': handleEraserMove(p); break;
    }
    requestRender(); // single rAF per pointermove, regardless of tool
}

function handlePointerUp(e) {
    cancelLongPress();
    longPressFired = false;
    if (S.isPanning) {
        S.isPanning = false;
        // Stay in grab after drag if hand mode is on
        canvas.style.cursor = S.handMode ? 'grab' : (S.spaceHeld ? 'grab' : '');
        updateCursorStyle();
        return;
    }
    if (!S.drawing) return;
    S.drawing = false;

    switch (S.tool) {
        case 'select': handleSelectUp(); break;
        case 'pen': handlePenUp(); break;
        case 'rectangle': case 'ellipse': handleShapeUp(); break;
        case 'line': case 'arrow': handleLineUp(); break;
        case 'eraser': handleEraserUp(); break;
    }
}

// ─── SELECT TOOL ─────────────────────────────────────────────────────
function handleSelectDown(p) {
    // First check if clicking a resize handle on already-selected element
    if (S.selectedIds.size === 1) {
        const selId = [...S.selectedIds][0];
        const selEl = S.elements.get(selId);
        if (selEl) {
            const handle = getResizeHandle(selEl, p.x, p.y);
            if (handle) {
                S.resizing = true;
                S.resizeHandle = handle;
                S.resizeStart = { x: p.x, y: p.y };
                S.resizeOrigEl = JSON.parse(JSON.stringify(selEl));
                return;
            }
        }
    }

    // Hit test in reverse order
    let hit = null;
    const els = [...S.elements.values()].reverse();
    for (const el of els) {
        if (hitTest(el, p.x, p.y)) { hit = el; break; }
    }

    if (hit) {
        if (!S.selectedIds.has(hit.id)) {
            S.selectedIds.clear();
            S.selectedIds.add(hit.id);
        }
        showPropsForSelection();
        S.dragStart = { x: p.x, y: p.y };
        S.dragOrigPositions = new Map();
        S.selectedIds.forEach(id => {
            const el = S.elements.get(id);
            if (el) S.dragOrigPositions.set(id, JSON.parse(JSON.stringify(el)));
        });
    } else {
        S.selectedIds.clear();
        S.dragStart = null;
        hideMobileColorBar();
    }
    requestRender();
}

function handleSelectMove(p) {
    // Resizing
    if (S.resizing && S.resizeOrigEl) {
        const orig = S.resizeOrigEl;
        const el = S.elements.get(orig.id);
        if (!el) return;
        const dx = p.x - S.resizeStart.x;
        const dy = p.y - S.resizeStart.y;

        if (el.type === 'text') {
            // Scale font size based on drag distance from bottom-right
            const origBounds = getElementBounds(orig);
            const diagOrig = Math.hypot(origBounds.w, origBounds.h) || 50;
            let diagDelta = 0;
            if (S.resizeHandle === 'br') diagDelta = (dx + dy) * 0.5;
            else if (S.resizeHandle === 'bl') diagDelta = (-dx + dy) * 0.5;
            else if (S.resizeHandle === 'tr') diagDelta = (dx - dy) * 0.5;
            else if (S.resizeHandle === 'tl') diagDelta = (-dx - dy) * 0.5;
            const scale = Math.max(0.3, 1 + diagDelta / diagOrig);
            el.style.fontSize = Math.max(8, Math.round(orig.style.fontSize * scale));
        } else if (el.type === 'rectangle' || el.type === 'ellipse') {
            if (S.resizeHandle.includes('r')) el.w = orig.w + dx;
            if (S.resizeHandle.includes('l')) { el.x = orig.x + dx; el.w = orig.w - dx; }
            if (S.resizeHandle.includes('b')) el.h = orig.h + dy;
            if (S.resizeHandle.includes('t')) { el.y = orig.y + dy; el.h = orig.h - dy; }
        } else if (el.type === 'image') {
            if (S.resizeHandle.includes('r')) el.w = Math.max(20, orig.w + dx);
            if (S.resizeHandle.includes('l')) { el.x = orig.x + dx; el.w = Math.max(20, orig.w - dx); }
            if (S.resizeHandle.includes('b')) el.h = Math.max(20, orig.h + dy);
            if (S.resizeHandle.includes('t')) { el.y = orig.y + dy; el.h = Math.max(20, orig.h - dy); }
        } else if (el.type === 'line' || el.type === 'arrow') {
            if (S.resizeHandle === 'tl' || S.resizeHandle === 'bl') { el.x1 = orig.x1 + dx; el.y1 = orig.y1 + dy; }
            if (S.resizeHandle === 'tr' || S.resizeHandle === 'br') { el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy; }
        }
        requestRender();
        return;
    }

    if (!S.dragStart || S.selectedIds.size === 0) return;
    const dx = p.x - S.dragStart.x, dy = p.y - S.dragStart.y;
    S.selectedIds.forEach(id => {
        const orig = S.dragOrigPositions.get(id);
        const el = S.elements.get(id);
        if (!orig || !el) return;
        const origCopy = JSON.parse(JSON.stringify(orig));
        moveElement(origCopy, dx, dy);
        Object.assign(el, origCopy);
    });
    requestRender();
}

function handleSelectUp() {
    if (S.resizing) {
        S.resizing = false;
        S.resizeHandle = null;
        S.resizeStart = null;
        const orig = S.resizeOrigEl;
        S.resizeOrigEl = null;
        if (orig) {
            pushHistory();
            const el = S.elements.get(orig.id);
            if (el) socket.emit('update-element', el);
        }
        return;
    }
    if (S.dragStart && S.selectedIds.size > 0) {
        pushHistory();
        S.selectedIds.forEach(id => {
            const el = S.elements.get(id);
            if (el) socket.emit('update-element', el);
        });
    }
    S.dragStart = null;
    S.dragOrigPositions = null;
}

// ─── PEN TOOL ────────────────────────────────────────────────────────
function handlePenDown(p) {
    S.current = createElement('pen', { points: [{ x: p.x, y: p.y }] });
    S._syncedPointCount = 1; // track how many points have been synced
    // Immediately broadcast the stroke start so remote previews appear instantly
    if (S.roomId) socket.emit('pen-delta', {
        id: S.current.id,
        pts: [{ x: p.x, y: p.y }],
        style: S.current.style,
    });
    requestRender();
}

// Minimum squared distance between stored points (2px^2 in world space at zoom=1)
const MIN_POINT_DIST_SQ = 4;

function handlePenMove(p, e) {
    if (!S.current) return;
    // getCoalescedEvents() recovers all intermediate points the browser
    // batched between animation frames — critical for fast strokes on mobile.
    const events = (e && e.getCoalescedEvents) ? e.getCoalescedEvents() : null;
    if (events && events.length > 1) {
        const rect = canvas.getBoundingClientRect();
        for (const ce of events) {
            const pt = screenToWorld(ce.clientX - rect.left, ce.clientY - rect.top);
            const last = S.current.points[S.current.points.length - 1];
            const dx = pt.x - last.x, dy = pt.y - last.y;
            if (dx * dx + dy * dy >= MIN_POINT_DIST_SQ) {
                S.current.points.push(pt);
            }
        }
    } else {
        const last = S.current.points[S.current.points.length - 1];
        const dx = p.x - last.x, dy = p.y - last.y;
        if (dx * dx + dy * dy >= MIN_POINT_DIST_SQ) {
            S.current.points.push({ x: p.x, y: p.y });
        }
    }
    // Delta sync: only send points the remote hasn't seen yet.
    // Keeps packet size O(1) instead of O(n) as stroke grows.
    const synced = S._syncedPointCount || 0;
    const allPts = S.current.points;
    if (allPts.length > synced) {
        const newPts = allPts.slice(synced);
        S._syncedPointCount = allPts.length;
        if (S.roomId) socket.emit('pen-delta', { id: S.current.id, pts: newPts });
    }
    // requestRender() is called by handlePointerMove after this returns.
}

function handlePenUp() {
    if (!S.current) return;
    if (S.current.points.length > 1) {
        S.elements.set(S.current.id, S.current);
        socket.emit('add-element', S.current);
        socket.emit('drawing-done', { id: S.current.id });
        pushHistory();
    }
    S.current = null;
    requestRender();
}

// ─── SHAPE TOOL (RECT / ELLIPSE) ────────────────────────────────────
function handleShapeDown(p) {
    S.current = createElement(S.tool, { x: p.x, y: p.y, w: 0, h: 0 });
    S.dragStart = { x: p.x, y: p.y };
}

function handleShapeMove(p, shift) {
    if (!S.current) return;
    let w = p.x - S.dragStart.x, h = p.y - S.dragStart.y;
    if (shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = s * Math.sign(w); h = s * Math.sign(h); }
    S.current.w = w; S.current.h = h;
    throttledPreviewEmit(S.current);
    requestRender();
}

function handleShapeUp() {
    if (!S.current) return;
    if (Math.abs(S.current.w) > 2 || Math.abs(S.current.h) > 2) {
        S.elements.set(S.current.id, S.current);
        socket.emit('add-element', S.current);
        socket.emit('drawing-done', { id: S.current.id });
        pushHistory();
    }
    S.current = null; S.dragStart = null;
    requestRender();
}

// ─── LINE / ARROW TOOL ──────────────────────────────────────────────
function handleLineDown(p) {
    S.current = createElement(S.tool, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
}

function handleLineMove(p, shift) {
    if (!S.current) return;
    if (shift) {
        const dx = p.x - S.current.x1, dy = p.y - S.current.y1;
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        S.current.x2 = S.current.x1 + len * Math.cos(angle);
        S.current.y2 = S.current.y1 + len * Math.sin(angle);
    } else {
        S.current.x2 = p.x; S.current.y2 = p.y;
    }
    throttledPreviewEmit(S.current);
    requestRender();
}

function handleLineUp() {
    if (!S.current) return;
    const d = Math.hypot(S.current.x2 - S.current.x1, S.current.y2 - S.current.y1);
    if (d > 2) {
        S.elements.set(S.current.id, S.current);
        socket.emit('add-element', S.current);
        socket.emit('drawing-done', { id: S.current.id });
        pushHistory();
    }
    S.current = null;
    requestRender();
}

// ─── TEXT TOOL ───────────────────────────────────────────────────────
let textEditingId = null;   // ID of the element currently being typed into
let textLocked = null;      // ID of element locked by a remote user
let _textCommitting = false; // guard against recursive commitText calls

const throttledTextPreview = throttle((el) => {
    if (S.roomId) socket.emit('text-preview', el);
}, 50);

// Reposition the textarea to stay aligned with the text element during pan/zoom
function repositionTextInput() {
    if (!textEditingId) return;
    const el = S.elements.get(textEditingId);
    if (!el) return;
    const sp = worldToScreen(el.x, el.y);
    const rect = canvas.getBoundingClientRect();
    textInput.style.left = (rect.left + sp.x) + 'px';
    textInput.style.top = (rect.top + sp.y) + 'px';
    const fs = (el.style.fontSize * S.vp.zoom);
    textInput.style.fontSize = fs + 'px';
    textInput.style.lineHeight = (fs * 1.3) + 'px';
}

// Auto-resize textarea to fit its content
function autoResizeTextInput() {
    textInput.style.height = 'auto';
    textInput.style.height = textInput.scrollHeight + 'px';
    // Also expand width to fit longest line
    const minW = 80;
    textInput.style.width = 'auto';
    textInput.style.width = Math.max(minW, textInput.scrollWidth + 8) + 'px';
}

function openTextInput(p, existingEl, pointerEvent) {
    // If already editing the same element, just refocus
    if (existingEl && textEditingId === existingEl.id) {
        textInput.focus();
        return;
    }
    // Commit any previously open text first
    if (textEditingId) {
        commitText();
    }

    const rect = canvas.getBoundingClientRect();

    if (existingEl) {
        // ── Edit existing element ──
        textEditingId = existingEl.id;
        textInput.value = existingEl.text || '';
        const esSp = worldToScreen(existingEl.x, existingEl.y);
        textInput.style.left = (rect.left + esSp.x) + 'px';
        textInput.style.top = (rect.top + esSp.y) + 'px';
        const fs = existingEl.style.fontSize * S.vp.zoom;
        textInput.style.fontSize = fs + 'px';
        textInput.style.lineHeight = (fs * 1.3) + 'px';
        textInput.style.color = existingEl.style.strokeColor;
        textInput.dataset.wx = existingEl.x;
        textInput.dataset.wy = existingEl.y;
        // Lock for others
        if (S.roomId) socket.emit('text-lock', { id: existingEl.id });
    } else {
        // ── New element — create immediately so remote users see placeholder ──
        const el = createElement('text', {
            x: p.x, y: p.y, text: '',
        });
        textEditingId = el.id;
        S.elements.set(el.id, el);
        socket.emit('add-element', el);
        if (S.roomId) socket.emit('text-lock', { id: el.id });

        const sp = worldToScreen(p.x, p.y);
        textInput.style.left = (rect.left + sp.x) + 'px';
        textInput.style.top = (rect.top + sp.y) + 'px';
        const fs = S.fontSize * S.vp.zoom;
        textInput.style.fontSize = fs + 'px';
        textInput.style.lineHeight = (fs * 1.3) + 'px';
        textInput.style.color = S.strokeColor;
        textInput.value = '';
        textInput.dataset.wx = p.x;
        textInput.dataset.wy = p.y;
    }

    textInput.style.display = 'block';
    autoResizeTextInput();

    // Focus the textarea. This is called either:
    //  • from a canvas 'click' handler (desktop) — focus always works here
    //  • from pointerdown (mobile touch) — sync focus opens the iOS keyboard
    textInput.focus();
    textInput.selectionStart = textInput.selectionEnd = textInput.value.length;

    S.drawing = false;
    requestRender();
}

function handleTextDown(p, pointerEvent) {
    // If already editing, commit the old text first
    if (textEditingId) {
        commitText();
    }
    // Hit-test: check if clicking on an existing text element
    let found = null;
    const els = [...S.elements.values()].reverse();
    for (const el of els) {
        if (el.type === 'text' && hitTest(el, p.x, p.y)) { found = el; break; }
    }
    if (found) {
        if (textLocked === found.id) {
            showToast('Another user is editing this text');
            return;
        }
        openTextInput({ x: found.x, y: found.y }, found, pointerEvent);
    } else {
        openTextInput(p, null, pointerEvent);
    }
}

function commitText() {
    if (_textCommitting) return; // prevent recursive calls
    _textCommitting = true;

    const text = textInput.value.trim();
    const id = textEditingId;
    textInput.style.display = 'none';
    textInput.value = '';
    textEditingId = null;

    if (id) {
        const el = S.elements.get(id);
        if (text && el) {
            el.text = text;
            socket.emit('update-element', el);
            pushHistory();
        } else if (!text && el) {
            // Empty — delete the placeholder
            S.elements.delete(id);
            socket.emit('delete-elements', [id]);
            pushHistory();
        }
        if (S.roomId) socket.emit('text-unlock', { id });
    }
    _textCommitting = false;
    requestRender();
}

textInput.addEventListener('input', () => {
    if (!textEditingId) return;
    const el = S.elements.get(textEditingId);
    if (!el) return;
    el.text = textInput.value;          // keep local element in sync
    throttledTextPreview(el);           // broadcast live typing
    autoResizeTextInput();
    requestRender();
});

textInput.addEventListener('blur', () => {
    // Capture the ID at blur time. handleTextDown may synchronously commit
    // the current element and open a NEW one within the same pointer event.
    // Without capturing here, the 100ms delayed callback would see the NEW
    // textEditingId and accidentally commit (delete) the freshly created element.
    const idAtBlur = textEditingId;
    setTimeout(() => {
        if (textEditingId && textEditingId === idAtBlur) {
            commitText();
        }
    }, 150);
});

textInput.addEventListener('keydown', e => {
    e.stopPropagation(); // prevent global shortcuts while typing
    if (e.key === 'Escape') {
        textInput.value = '';
        commitText();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitText();
    }
});

// ─── TEXT SYNC SOCKET EVENTS ─────────────────────────────────────────
socket.on('text-preview', el => {
    // Update the stored element's text so remote typing is visible
    if (el.id === textEditingId) return; // don't overwrite our own edits
    const existing = S.elements.get(el.id);
    if (existing) Object.assign(existing, { text: el.text });
    requestRender();
});

socket.on('text-lock', data => {
    textLocked = data.id;
});

socket.on('text-unlock', data => {
    if (textLocked === data.id) textLocked = null;
    requestRender();
});


// ─── ERASER TOOL ─────────────────────────────────────────────────────
let eraserChanged = false;

function handleEraserDown(p) {
    eraserChanged = false;
    checkErase(p);
}

function handleEraserMove(p) { checkErase(p); }

function handleEraserUp() {
    if (eraserChanged) {
        pushHistory();
    }
    eraserChanged = false;
}

function checkErase(p) {
    const radius = S.eraserSize / 2;
    const toDelete = [];
    const toAdd = [];  // new split segments from pen strokes

    S.elements.forEach((el, id) => {
        if (el.type === 'pen' && el.points && el.points.length >= 2) {
            // Partial pen erasing: remove points within eraser radius
            const hitMargin = radius + (el.style.strokeWidth || 2);
            let hasHit = false;
            for (let i = 0; i < el.points.length; i++) {
                if (Math.hypot(el.points[i].x - p.x, el.points[i].y - p.y) < hitMargin) {
                    hasHit = true;
                    break;
                }
            }
            // Also check line segments between points
            if (!hasHit) {
                for (let i = 1; i < el.points.length; i++) {
                    if (distToSeg(p.x, p.y, el.points[i - 1].x, el.points[i - 1].y, el.points[i].x, el.points[i].y) < hitMargin) {
                        hasHit = true;
                        break;
                    }
                }
            }
            if (!hasHit) return;

            // Mark points to keep (outside eraser radius)
            const surviving = el.points.filter(pt =>
                Math.hypot(pt.x - p.x, pt.y - p.y) >= radius
            );

            if (surviving.length === el.points.length) return; // nothing erased

            // Split surviving points into contiguous segments
            // Points are contiguous if they were adjacent in the original array
            const origIndices = surviving.map(pt => el.points.indexOf(pt));
            const segments = [];
            let seg = [surviving[0]];
            for (let i = 1; i < surviving.length; i++) {
                if (origIndices[i] - origIndices[i - 1] === 1) {
                    seg.push(surviving[i]);
                } else {
                    if (seg.length >= 2) segments.push(seg);
                    seg = [surviving[i]];
                }
            }
            if (seg.length >= 2) segments.push(seg);

            // Delete the original
            toDelete.push(id);

            // Create new elements for each surviving segment
            segments.forEach(pts => {
                const newEl = {
                    id: uid(),
                    type: 'pen',
                    points: pts.map(pt => ({ x: pt.x, y: pt.y })),
                    style: { ...el.style },
                };
                toAdd.push(newEl);
            });
        } else {
            // Non-pen elements: delete whole element if hit
            if (hitTest(el, p.x, p.y)) {
                toDelete.push(id);
            }
        }
    });

    if (toDelete.length || toAdd.length) {
        toDelete.forEach(id => S.elements.delete(id));
        if (toDelete.length) socket.emit('delete-elements', toDelete);
        toAdd.forEach(el => {
            S.elements.set(el.id, el);
            socket.emit('add-element', el);
        });
        eraserChanged = true;
        requestRender();
    }
}

// ─── CURSOR STYLE ────────────────────────────────────────────────────
function updateCursorStyle() {
    if (S.handMode) { canvas.style.cursor = 'grab'; return; }
    if (S.spaceHeld) { canvas.style.cursor = 'grab'; return; }
    switch (S.tool) {
        case 'select': canvas.style.cursor = 'default'; break;
        case 'pen': canvas.style.cursor = 'crosshair'; break;
        case 'eraser': canvas.style.cursor = 'none'; break;
        case 'text': canvas.style.cursor = 'text'; break;
        default: canvas.style.cursor = 'crosshair';
    }
}

function toggleHandMode(on) {
    S.handMode = (on === undefined) ? !S.handMode : on;
    if (S.handMode) {
        S.prevTool = S.tool;
        // Show hand mode toast hint once per session
        if (!toggleHandMode._hinted) {
            showToast('Hand Mode — drag to pan · double-click or Esc to exit');
            toggleHandMode._hinted = true;
        }
    } else {
        // Restore the toolbar button highlight
        toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === S.prevTool));
    }
    updateCursorStyle();
    // Visual indicator on toolbar: dim all tools when in hand mode
    document.getElementById('toolbar').classList.toggle('hand-mode-active', S.handMode);
}

function updateCursor(w) {
    if (S.tool === 'select') {
        let onEl = false;
        S.elements.forEach(el => { if (hitTest(el, w.x, w.y)) onEl = true; });
        canvas.style.cursor = onEl ? 'move' : 'default';
    }
}

// ─── ZOOM ────────────────────────────────────────────────────────────
function zoomTo(newZoom, cx, cy) {
    newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    const wx = cx / S.vp.zoom + S.vp.x;
    const wy = cy / S.vp.zoom + S.vp.y;
    S.vp.zoom = newZoom;
    S.vp.x = wx - cx / S.vp.zoom;
    S.vp.y = wy - cy / S.vp.zoom;
    zoomDisplay.textContent = Math.round(S.vp.zoom * 100) + '%';
    requestRender();
}

function handleWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    if (e.ctrlKey || e.metaKey) {
        // Ctrl+Scroll = Zoom (pinch-to-zoom on trackpad also fires this)
        const delta = -Math.sign(e.deltaY) * ZOOM_STEP;
        zoomTo(S.vp.zoom + delta, sx, sy);
    } else {
        // Plain scroll = Pan the canvas (Miro-style)
        S.vp.x += e.deltaX / S.vp.zoom;
        S.vp.y += e.deltaY / S.vp.zoom;
        requestRender();
    }
}

// ─── COLLABORATION ───────────────────────────────────────────────────
const throttledCursorEmit = throttle((x, y) => {
    if (S.roomId) socket.emit('cursor-move', { x, y });
}, 50);

// Live drawing preview — immediate for pen strokes, throttled for shapes
// Pen needs the lowest possible latency; shapes update rarely so throttle is fine.
function immediatePreviewEmit(el) {
    if (S.roomId) socket.emit('drawing-preview', el);
}
const throttledPreviewEmit = throttle(immediatePreviewEmit, 32);

socket.on('room-state', data => {
    S.myId = data.yourId;
    S.myColor = data.yourColor;
    S.elements.clear();
    data.elements.forEach(el => S.elements.set(el.id, el));
    S.users.clear();
    Object.entries(data.users).forEach(([id, u]) => S.users.set(id, u));
    S.history = [snapshot()]; S.historyIdx = 0;
    updateUndoRedo();
    renderUsers();
    requestRender();
});

socket.on('element-added', el => {
    if (el.type === 'image') imgCache.delete(el.id); // ensure fresh load
    S.elements.set(el.id, el);
    requestRender();
});
socket.on('element-updated', el => {
    if (el.type === 'image') imgCache.delete(el.id); // reload if src changed
    S.elements.set(el.id, el);
    requestRender();
});
socket.on('elements-deleted', ids => {
    ids.forEach(id => { S.elements.delete(id); imgCache.delete(id); });
    requestRender();
});
socket.on('board-cleared', () => { S.elements.clear(); imgCache.clear(); S.remotePreviews.clear(); requestRender(); });

// Live drawing preview from other users
socket.on('drawing-preview', data => {
    if (!data || !data.el || !data.userId) return;
    S.remotePreviews.set(data.userId, data.el);
    requestRender();
});

// Drawing finished — remove preview (element-added will add the final element)
socket.on('drawing-done', data => {
    if (!data || !data.userId) return;
    S.remotePreviews.delete(data.userId);
    requestRender();
});

// Pen delta: incrementally append new points to remote user's in-progress stroke.
// Much more efficient than full drawing-preview for long strokes.
socket.on('pen-delta', data => {
    if (!data || !data.userId || !data.id || !Array.isArray(data.pts)) return;
    let preview = S.remotePreviews.get(data.userId);
    if (!preview || preview.id !== data.id) {
        // First delta for this stroke — create the preview element
        preview = { id: data.id, type: 'pen', points: [], style: data.style || {} };
        S.remotePreviews.set(data.userId, preview);
    }
    for (const pt of data.pts) preview.points.push(pt);
    requestRender();
});

socket.on('cursor-moved', data => {
    S.cursorTargets.set(data.id, { x: data.x, y: data.y });
    requestRender();
});

socket.on('user-joined', data => {
    S.users.set(data.id, data);
    showToast(`${data.name} joined`);
    renderUsers();
});

socket.on('user-left', data => {
    S.users.delete(data.id);
    S.cursors.delete(data.id);
    S.cursorTargets.delete(data.id);
    S.remotePreviews.delete(data.id); // clean up any in-progress stroke
    renderUsers();
    requestRender();
});

function renderUsers() {
    usersContainer.innerHTML = '';
    S.users.forEach((u, id) => {
        const div = document.createElement('div');
        div.className = 'user-avatar' + (id === S.myId ? ' you' : '');
        div.style.background = u.color;
        div.textContent = (u.name || 'U')[0].toUpperCase();
        div.title = u.name || 'User';
        usersContainer.appendChild(div);
    });
}

// ─── UI CONTROLLERS ──────────────────────────────────────────────────
function initColorSwatches() {
    const strokeSw = $('stroke-swatches');
    COLORS.forEach(c => {
        const d = document.createElement('div');
        d.className = 'color-swatch' + (c === S.strokeColor ? ' active' : '');
        d.style.background = c;
        d.addEventListener('click', () => {
            S.strokeColor = c; strokeColorInput.value = c;
            strokeSw.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            d.classList.add('active');
            applyColorToSelected();
        });
        strokeSw.appendChild(d);
    });

    const fillSw = $('fill-swatches');
    FILL_COLORS.forEach(c => {
        const d = document.createElement('div');
        d.className = 'color-swatch' + (c === S.fillColor ? ' active' : '');
        d.style.background = c === 'transparent' ? 'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50%/10px 10px' : c;
        d.addEventListener('click', () => {
            S.fillColor = c;
            fillColorInput.value = c === 'transparent' ? '#000000' : c;
            fillSw.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            d.classList.add('active');
            applyColorToSelected();
        });
        fillSw.appendChild(d);
    });
}

// Show props panel with selected element's current colors
function showPropsForSelection() {
    if (S.selectedIds.size !== 1) return;
    const el = S.elements.get([...S.selectedIds][0]);
    if (!el) return;
    const panel = $('props-panel');
    panel.classList.add('panel-open');
    // Show fill section only for shapes
    fillSection.style.display = ['rectangle', 'ellipse'].includes(el.type) ? '' : 'none';
    // Sync swatches to element's current colors
    S.strokeColor = el.style.strokeColor;
    strokeColorInput.value = el.style.strokeColor;
    const strokeSw = $('stroke-swatches');
    strokeSw.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', s.style.background === el.style.strokeColor);
    });
    if (el.style.fillColor) {
        S.fillColor = el.style.fillColor;
        fillColorInput.value = el.style.fillColor === 'transparent' ? '#000000' : el.style.fillColor;
    }
    // Show mobile color bar
    showMobileColorBar(el);
}

// Apply current colors to selected elements
function applyColorToSelected() {
    if (S.tool !== 'select' || S.selectedIds.size === 0) return;
    S.selectedIds.forEach(id => {
        const el = S.elements.get(id);
        if (!el) return;
        el.style.strokeColor = S.strokeColor;
        if (['rectangle', 'ellipse'].includes(el.type)) {
            el.style.fillColor = S.fillColor;
        }
        socket.emit('update-element', el);
    });
    pushHistory();
    requestRender();
    // Update toolbar dot if visible
    if (selColorDot) selColorDot.style.background = S.strokeColor;
}

// ─── MOBILE SELECTION COLOR BUTTON ───────────────────────────────────
const selColorBtn = $('sel-color-btn');
const selColorDot = $('sel-color-dot');
const selColorDivider = $('sel-color-divider');

function showSelColorBtn(el) {
    if (!el) return;
    selColorDot.style.background = el.style.strokeColor || '#000';
    selColorBtn.style.display = '';
    selColorDivider.style.display = '';
}

function hideSelColorBtn() {
    selColorBtn.style.display = 'none';
    selColorDivider.style.display = 'none';
}

selColorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('props-panel');
    panel.classList.toggle('panel-open');
});

function initMobileColorBar() { } // no-op, kept for compat
function showMobileColorBar(el) { showSelColorBtn(el); }
function hideMobileColorBar() { hideSelColorBtn(); }

function setTool(t) {
    // Commit any in-progress text editing when switching tools
    if (textEditingId) commitText();
    S.tool = t;
    toolBtns.forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    fillSection.style.display = ['rectangle', 'ellipse'].includes(t) ? '' : 'none';
    updateCursorStyle();
    // Show props panel for drawing tools, hide for select/eraser
    const drawTools = ['pen', 'rectangle', 'ellipse', 'line', 'arrow', 'text'];
    const panel = $('props-panel');
    if (drawTools.includes(t)) {
        panel.classList.add('panel-open');
    } else {
        panel.classList.remove('panel-open');
    }
    // Eraser size panel: show when eraser selected, hide otherwise
    const eraserPanel = $('eraser-size-panel');
    if (t === 'eraser') {
        eraserPanel.classList.add('open');
    } else {
        eraserPanel.classList.remove('open');
        S.eraserScreenPos = null;
    }
    // Hide mobile color bar when switching away from select
    if (t !== 'select') hideMobileColorBar();
}

// Tool buttons (excluding shapes which are in the dropdown)
toolBtns.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

// ─── ERASER SIZE SLIDER ──────────────────────────────────────────────
const eraserSlider = $('eraser-size-slider');
const eraserSizeLabel = $('eraser-size-label');
const eraserPreviewDot = $('eraser-preview-dot');
const eraserPanel = $('eraser-size-panel');

eraserSlider.addEventListener('input', () => {
    const size = parseInt(eraserSlider.value, 10);
    S.eraserSize = size;
    eraserSizeLabel.textContent = size + 'px';
    eraserPreviewDot.style.width = size + 'px';
    eraserPreviewDot.style.height = size + 'px';
});

// Auto-close eraser panel when user starts drawing on canvas
canvas.addEventListener('pointerdown', () => {
    eraserPanel.classList.remove('open');
}, { capture: false });

// Prevent clicks inside eraser panel from closing it
eraserPanel.addEventListener('pointerdown', (e) => e.stopPropagation());

// ─── SHAPES DROPDOWN ─────────────────────────────────────────────────
const shapesBtn = $('shapes-btn');
const shapesDropdown = $('shapes-dropdown');
const shapeOptions = document.querySelectorAll('.shape-option');
const SHAPE_TOOLS = ['rectangle', 'ellipse', 'line', 'arrow'];

// SVG icons for each shape (to update the Shapes button icon)
const SHAPE_ICONS = {
    rectangle: '<rect x="3" y="3" width="18" height="18" rx="2" />',
    ellipse: '<ellipse cx="12" cy="12" rx="10" ry="8" />',
    line: '<line x1="5" y1="19" x2="19" y2="5" />',
    arrow: '<line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />',
};

shapesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = shapesDropdown.classList.toggle('open');
    if (isOpen) {
        // Position dropdown below the button
        const rect = shapesBtn.getBoundingClientRect();
        shapesDropdown.style.position = 'fixed';
        shapesDropdown.style.top = (rect.bottom + 6) + 'px';
        shapesDropdown.style.left = rect.left + 'px';
        shapesDropdown.style.transform = 'none';
    }
});

shapeOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const tool = opt.dataset.tool;
        setTool(tool);
        updateShapesBtn(tool);
        shapesDropdown.classList.remove('open');
    });
});

function updateShapesBtn(tool) {
    // Highlight the Shapes button when a shape tool is active
    shapesBtn.classList.toggle('active', SHAPE_TOOLS.includes(tool));
    // Update icon to match selected shape
    if (SHAPE_ICONS[tool]) {
        shapesBtn.querySelector('svg').innerHTML = SHAPE_ICONS[tool];
    }
    // Highlight the selected option inside dropdown
    shapeOptions.forEach(opt => opt.classList.toggle('active', opt.dataset.tool === tool));
}

// Close dropdown when clicking outside
document.addEventListener('click', () => {
    shapesDropdown.classList.remove('open');
});

// Color inputs
strokeColorInput.addEventListener('input', e => { S.strokeColor = e.target.value; applyColorToSelected(); });
fillColorInput.addEventListener('input', e => { S.fillColor = e.target.value; applyColorToSelected(); });

// Width / Opacity
strokeWidthInput.addEventListener('input', e => { S.strokeWidth = +e.target.value; widthVal.textContent = e.target.value; });
opacityInput.addEventListener('input', e => { S.opacity = +e.target.value / 100; opacityVal.textContent = e.target.value + '%'; });

// Zoom buttons
$('zoom-in').addEventListener('click', () => zoomTo(S.vp.zoom + ZOOM_STEP, canvas.clientWidth / 2, canvas.clientHeight / 2));
$('zoom-out').addEventListener('click', () => zoomTo(S.vp.zoom - ZOOM_STEP, canvas.clientWidth / 2, canvas.clientHeight / 2));
$('zoom-reset').addEventListener('click', () => { S.vp = { x: 0, y: 0, zoom: 1 }; zoomDisplay.textContent = '100%'; requestRender(); });

// Grid
$('grid-btn').addEventListener('click', () => { S.showGrid = !S.showGrid; $('grid-btn').classList.toggle('active', S.showGrid); requestRender(); });

// Undo / Redo
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// Export
$('export-btn').addEventListener('click', exportPNG);
function exportPNG() {
    const tmpCanvas = document.createElement('canvas');
    const b = getAllBounds();
    const pad = 40;
    tmpCanvas.width = (b.w + pad * 2) || 800;
    tmpCanvas.height = (b.h + pad * 2) || 600;
    const tctx = tmpCanvas.getContext('2d');
    const theme = document.documentElement.getAttribute('data-theme');
    tctx.fillStyle = theme === 'dark' ? '#1a1a2e' : '#ffffff';
    tctx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);
    tctx.translate(-b.x + pad, -b.y + pad);
    S.elements.forEach(el => {
        tctx.globalAlpha = el.style.opacity;
        tctx.strokeStyle = el.style.strokeColor;
        tctx.fillStyle = el.style.fillColor || 'transparent';
        tctx.lineWidth = el.style.strokeWidth;
        tctx.lineCap = 'round'; tctx.lineJoin = 'round';
        drawElementToCtx(tctx, el);
        tctx.globalAlpha = 1;
    });
    const link = document.createElement('a');
    link.download = 'sketchflow-board.png';
    link.href = tmpCanvas.toDataURL('image/png');
    link.click();
    showToast('Board exported as PNG');
}

function drawElementToCtx(c, el) {
    switch (el.type) {
        case 'pen':
            if (!el.points || el.points.length < 2) return;
            c.beginPath(); c.moveTo(el.points[0].x, el.points[0].y);
            for (let i = 1; i < el.points.length - 1; i++) {
                const xc = (el.points[i].x + el.points[i + 1].x) / 2;
                const yc = (el.points[i].y + el.points[i + 1].y) / 2;
                c.quadraticCurveTo(el.points[i].x, el.points[i].y, xc, yc);
            }
            c.lineTo(el.points[el.points.length - 1].x, el.points[el.points.length - 1].y); c.stroke();
            break;
        case 'rectangle': {
            const x = Math.min(el.x, el.x + el.w), y = Math.min(el.y, el.y + el.h);
            if (el.style.fillColor && el.style.fillColor !== 'transparent') c.fillRect(x, y, Math.abs(el.w), Math.abs(el.h));
            c.strokeRect(x, y, Math.abs(el.w), Math.abs(el.h)); break;
        }
        case 'ellipse': {
            c.beginPath(); c.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
            if (el.style.fillColor && el.style.fillColor !== 'transparent') c.fill(); c.stroke(); break;
        }
        case 'line': c.beginPath(); c.moveTo(el.x1, el.y1); c.lineTo(el.x2, el.y2); c.stroke(); break;
        case 'arrow': {
            c.beginPath(); c.moveTo(el.x1, el.y1); c.lineTo(el.x2, el.y2); c.stroke();
            const a = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
            c.beginPath(); c.moveTo(el.x2, el.y2);
            c.lineTo(el.x2 - 14 * Math.cos(a - 0.4), el.y2 - 14 * Math.sin(a - 0.4));
            c.moveTo(el.x2, el.y2);
            c.lineTo(el.x2 - 14 * Math.cos(a + 0.4), el.y2 - 14 * Math.sin(a + 0.4)); c.stroke(); break;
        }
        case 'text':
            if (!el.text) return;
            c.font = `${el.style.fontSize}px Inter, sans-serif`; c.fillStyle = el.style.strokeColor; c.textBaseline = 'top';
            el.text.split('\n').forEach((l, i) => c.fillText(l, el.x, el.y + i * el.style.fontSize * 1.3));
            break;
    }
}

function getAllBounds() {
    let mx = Infinity, my = Infinity, MX = -Infinity, MY = -Infinity;
    S.elements.forEach(el => {
        const b = getElementBounds(el);
        mx = Math.min(mx, b.x); my = Math.min(my, b.y);
        MX = Math.max(MX, b.x + b.w); MY = Math.max(MY, b.y + b.h);
    });
    if (!isFinite(mx)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: mx, y: my, w: MX - mx, h: MY - my };
}

// Theme
$('theme-btn').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', S.theme);
    requestRender();
});

// Clear
$('clear-btn').addEventListener('click', async () => {
    if (S.elements.size === 0) return;
    const ok = await showModal('Clear the entire board? This cannot be undone.');
    if (ok) {
        S.elements.clear(); S.selectedIds.clear();
        socket.emit('clear-board');
        pushHistory();
        requestRender();
        showToast('Board cleared');
    }
});


// Exit
$('exit-btn').addEventListener('click', async () => {
    const confirmed = await showModal('Are you sure you want to exit this board?', 'Exit', 'Cancel');
    if (!confirmed) return;

    // Leave the room cleanly — board data stays on the server
    if (S.roomId) socket.emit('leave-room', { roomId: S.roomId });

    // Reset local state
    S.elements.clear();
    S.selectedIds.clear();
    S.cursors.clear();
    S.users.clear();
    S.remotePreviews.clear();
    S.history = [];
    S.historyIdx = -1;
    S.roomId = null;
    S.drawing = false;
    S.current = null;
    S.isPanning = false;
    cancelLongPress();

    // Return to landing
    landing.classList.add('active');
    app.classList.remove('active');
    S.view = 'landing';
    window.history.pushState({}, '', '/');
    updateUndoRedo();
    requestRender();
});

// ─── KEYBOARD SHORTCUTS ─────────────────────────────────────────────
window.addEventListener('keydown', e => {
    if (textInput.style.display === 'block') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (S.view !== 'whiteboard') return;

    if (e.code === 'Space' && !S.spaceHeld) { S.spaceHeld = true; updateCursorStyle(); e.preventDefault(); }
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        if (e.key === 'y') { e.preventDefault(); redo(); }
        if (e.key === 's') { e.preventDefault(); exportPNG(); }
        if (e.key === 'a') { e.preventDefault(); S.selectedIds.clear(); S.elements.forEach((_, id) => S.selectedIds.add(id)); setTool('select'); requestRender(); }
        return;
    }
    switch (e.key.toLowerCase()) {
        case 'v': setTool('select'); updateShapesBtn('select'); break;
        case 'p': setTool('pen'); updateShapesBtn('pen'); break;
        case 'r': setTool('rectangle'); updateShapesBtn('rectangle'); break;
        case 'o': setTool('ellipse'); updateShapesBtn('ellipse'); break;
        case 'l': setTool('line'); updateShapesBtn('line'); break;
        case 'a': setTool('arrow'); updateShapesBtn('arrow'); break;
        case 't': setTool('text'); updateShapesBtn('text'); break;
        case 'e': setTool('eraser'); updateShapesBtn('eraser'); break;
        case 'g': $('grid-btn').click(); break;
        case 'delete': case 'backspace':
            if (S.selectedIds.size) {
                const ids = [...S.selectedIds];
                ids.forEach(id => S.elements.delete(id));
                socket.emit('delete-elements', ids);
                S.selectedIds.clear();
                pushHistory();
                requestRender();
            }
            break;
        case 'escape':
            if (S.handMode) { toggleHandMode(false); break; }
            S.selectedIds.clear(); requestRender(); break;
    }
});

window.addEventListener('keyup', e => {
    if (e.code === 'Space') { S.spaceHeld = false; updateCursorStyle(); }
});

// ─── CANVAS EVENTS ───────────────────────────────────────────────────
// non-passive so we can e.preventDefault() inside handlers (e.g. text tool on touch)
canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
canvas.addEventListener('pointerup', handlePointerUp);
canvas.addEventListener('pointerleave', handlePointerUp);
canvas.addEventListener('wheel', handleWheel, { passive: false });

// Prevent context menu on canvas
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ─── DESKTOP TEXT: create text on 'click' (after pointerup) ─────────
// The 'click' event fires after mouseup when implicit pointer capture is
// already released, making textarea.focus() 100% reliable on all browsers.
let _desktopTextTimer = null;
canvas.addEventListener('click', e => {
    if (S.tool !== 'text') { S._pendingTextPoint = null; return; }
    if (e.pointerType === 'touch') return;
    if (!S._pendingTextPoint) return;
    if (S.isPanning) { S._pendingTextPoint = null; return; }

    const pt = S._pendingTextPoint;
    S._pendingTextPoint = null;
    clearTimeout(_desktopTextTimer);
    _desktopTextTimer = setTimeout(() => {
        _desktopTextTimer = null;
        handleTextDown(pt, null);
    }, 0);
});

// ─── TOUCH GESTURES (pinch-to-zoom, two-finger pan) ──────────────────
let lastTouchDist = 0;
let lastTouchMid = null;
let touchCount = 0;

canvas.addEventListener('touchstart', e => {
    touchCount = e.touches.length;
    if (e.touches.length === 2) {
        e.preventDefault();
        // Cancel any single-finger drawing in progress
        S.drawing = false;
        S.current = null;
        const t0 = e.touches[0], t1 = e.touches[1];
        lastTouchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        lastTouchMid = {
            x: (t0.clientX + t1.clientX) / 2,
            y: (t0.clientY + t1.clientY) / 2,
        };
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t0 = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const mid = {
            x: (t0.clientX + t1.clientX) / 2,
            y: (t0.clientY + t1.clientY) / 2,
        };

        // Pinch zoom
        if (lastTouchDist > 0) {
            const scale = dist / lastTouchDist;
            const rect = canvas.getBoundingClientRect();
            const sx = mid.x - rect.left, sy = mid.y - rect.top;
            zoomTo(S.vp.zoom * scale, sx, sy);
        }

        // Two-finger pan
        if (lastTouchMid) {
            const dx = (mid.x - lastTouchMid.x) / S.vp.zoom;
            const dy = (mid.y - lastTouchMid.y) / S.vp.zoom;
            S.vp.x -= dx;
            S.vp.y -= dy;
            requestRender();
        }

        lastTouchDist = dist;
        lastTouchMid = mid;
    }
}, { passive: false });

canvas.addEventListener('touchend', e => {
    touchCount = e.touches.length;
    if (e.touches.length < 2) {
        lastTouchDist = 0;
        lastTouchMid = null;
    }
});

// ─── DOUBLE-CLICK / DOUBLE-TAP: Select element or Hand Mode ──────────
// Shared helper: select a text element on double-click/tap
function selectTextElement(el) {
    // If text is locked by another user, just show a toast
    if (textLocked === el.id) { showToast('Another user is editing this text'); return; }
    // Commit any currently open text edit first
    if (textEditingId) commitText();
    // Switch to select tool and select this element
    setTool('select');
    updateShapesBtn('select');
    S.selectedIds.clear();
    S.selectedIds.add(el.id);
    // showPropsForSelection opens the props panel + mobile color bar
    showPropsForSelection();
    requestRender();
}

// Desktop: dblclick
canvas.addEventListener('dblclick', e => {
    // Cancel any pending single-click editor open so editor doesn't flash
    clearTimeout(_desktopTextTimer);
    _desktopTextTimer = null;
    S._pendingTextPoint = null;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    let hit = null;
    const els = [...S.elements.values()].reverse();
    for (const el of els) {
        if (hitTest(el, w.x, w.y)) { hit = el; break; }
    }
    if (hit) {
        // Double-click on any element → select it (works for text AND shapes)
        setTool('select');
        updateShapesBtn('select');
        S.selectedIds.clear();
        S.selectedIds.add(hit.id);
        showPropsForSelection();
        requestRender();
    } else if (S.tool !== 'text') {
        toggleHandMode();
    }
});

// Mobile: detect double-tap via pointerdown — capture phase so this runs
// BEFORE handlePointerDown, allowing us to stopPropagation on double-tap.
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return; // touch only
    const now = Date.now();
    const dx = e.clientX - lastTapX;
    const dy = e.clientY - lastTapY;
    const dist = Math.hypot(dx, dy);

    if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DIST) {
        // Double-tap confirmed — intercept BEFORE handlePointerDown fires
        e.preventDefault();
        e.stopPropagation(); // ← block handlePointerDown from running
        // Cancel any delayed text-editor open scheduled from the 1st tap
        clearTimeout(S._textTapTimer);
        S._textTapTimer = null;
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const w = screenToWorld(sx, sy);
        let hit = null;
        const els = [...S.elements.values()].reverse();
        for (const el of els) {
            if (hitTest(el, w.x, w.y)) { hit = el; break; }
        }
        if (hit) {
            selectTextElement(hit);
        } else if (S.tool !== 'text') {
            toggleHandMode();
        }
        lastTapTime = 0; // reset so triple-tap doesn't retrigger
    } else {
        lastTapTime = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
    }
}, { capture: true }); // capture phase = fires before handlePointerDown


// ─── MOBILE: Auto-close props panel on canvas tap ────────────────────
const propsPanel = $('props-panel');

canvas.addEventListener('pointerdown', () => {
    if (propsPanel.classList.contains('panel-open')) {
        propsPanel.classList.remove('panel-open');
    }
});

// ─── WINDOW RESIZE ───────────────────────────────────────────────────
window.addEventListener('resize', () => requestRender());

// ─── NAVIGATION ──────────────────────────────────────────────────────
function joinRoom(id, name) {
    S.roomId = id;
    S.myName = name || 'Anonymous';
    roomDisplay.textContent = id;
    const url = new URL(window.location);
    url.searchParams.set('room', id);
    window.history.pushState({}, '', url);
    landing.classList.remove('active');
    app.classList.add('active');
    S.view = 'whiteboard';

    // Seed undo history with baseline (empty board) immediately
    S.history = [snapshot()];
    S.historyIdx = 0;
    updateUndoRedo();

    socket.emit('join-room', { roomId: id, name: S.myName });
    requestRender();
}

// ─── NAME PROMPT ─────────────────────────────────────────────────────
function promptName() {
    return new Promise(resolve => {
        const modal = $('name-modal');
        const input = $('name-input');
        const btn = $('name-submit');

        // Pre-fill from localStorage if returning user
        const saved = localStorage.getItem('sketchflow-name') || '';
        input.value = saved;

        modal.classList.remove('hidden');
        setTimeout(() => input.focus(), 80);

        const submit = () => {
            const name = input.value.trim();
            if (!name) {
                input.style.borderColor = '#ef4444';
                input.setAttribute('placeholder', 'Please enter your name');
                input.focus();
                return;
            }
            localStorage.setItem('sketchflow-name', name);
            modal.classList.add('hidden');
            btn.removeEventListener('click', submit);
            input.removeEventListener('keydown', onKey);
            resolve(name);
        };

        const onKey = (e) => {
            input.style.borderColor = '';  // reset error highlight on typing
            if (e.key === 'Enter') submit();
        };

        btn.addEventListener('click', submit);
        input.addEventListener('keydown', onKey);
    });
}

// ─── ENTRY POINTS ────────────────────────────────────────────────────
$('create-btn').addEventListener('click', async () => {
    const name = await promptName();
    const id = uid().split('-')[0];
    joinRoom(id, name);
});

$('join-btn').addEventListener('click', async () => {
    const id = $('join-id').value.trim();
    if (!id) { showToast('Please enter a Board ID'); return; }
    const name = await promptName();
    joinRoom(id, name);
});

$('join-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('join-btn').click();
});

// ─── INVITE / SHARE ──────────────────────────────────────────────────
inviteBtn.addEventListener('click', async () => {
    const url = new URL(window.location);
    url.searchParams.set('room', S.roomId);
    const inviteLink = url.toString();

    // Try native share API first (mobile)
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'SketchFlow Board',
                text: 'Join my whiteboard!',
                url: inviteLink,
            });
            return;
        } catch (e) {
            // User cancelled or share failed — fall through to clipboard
        }
    }

    // Fallback: copy to clipboard
    try {
        await navigator.clipboard.writeText(inviteLink);
        showToast('Invite link copied!');
    } catch (e) {
        // Last resort: prompt
        prompt('Copy this invite link:', inviteLink);
    }
});

// ─── IMAGE UPLOAD ─────────────────────────────────────────────────────
const imgUploadBtn = $('img-upload-btn');
const imgUploadInput = $('img-upload-input');

imgUploadBtn.addEventListener('click', () => {
    imgUploadInput.value = ''; // reset so same file can be re-selected
    imgUploadInput.click();
});

imgUploadInput.addEventListener('change', () => {
    const file = imgUploadInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        const tmpImg = new Image();
        tmpImg.onload = () => {
            // ── 1. Compress: draw into an off-screen canvas ──────────────
            const MAX_PX = 1200;   // max dimension for the stored data URL
            let iw = tmpImg.naturalWidth, ih = tmpImg.naturalHeight;
            if (iw > MAX_PX || ih > MAX_PX) {
                const scale = Math.min(MAX_PX / iw, MAX_PX / ih);
                iw = Math.round(iw * scale);
                ih = Math.round(ih * scale);
            }
            const offscreen = document.createElement('canvas');
            offscreen.width = iw;
            offscreen.height = ih;
            offscreen.getContext('2d').drawImage(tmpImg, 0, 0, iw, ih);
            const compressedSrc = offscreen.toDataURL('image/jpeg', 0.75);

            // ── 2. Size on canvas: fit to 400px display area ─────────────
            const MAX_DISPLAY = 400;
            let dw = iw, dh = ih;
            if (dw > MAX_DISPLAY || dh > MAX_DISPLAY) {
                const s = Math.min(MAX_DISPLAY / dw, MAX_DISPLAY / dh);
                dw = Math.round(dw * s);
                dh = Math.round(dh * s);
            }

            // ── 3. Center in visible viewport ─────────────────────────────
            // screenToWorld() accounts for current pan & zoom correctly.
            const toolbarEl = document.getElementById('toolbar');
            const statusEl = document.getElementById('status-bar');
            const tbH = toolbarEl ? toolbarEl.offsetHeight : 0;
            const sbH = statusEl ? statusEl.offsetHeight : 0;
            const screenCx = window.innerWidth / 2;
            const screenCy = tbH + (window.innerHeight - tbH - sbH) / 2;
            const { x: cx, y: cy } = screenToWorld(screenCx, screenCy);

            // ── 4. Create element ─────────────────────────────────────────
            const el = {
                id: uid(), type: 'image',
                x: cx - dw / 2, y: cy - dh / 2,
                w: dw, h: dh,
                src: compressedSrc,
                style: { strokeColor: '#000', fillColor: 'transparent', strokeWidth: 1, fontSize: 16, opacity: 1 },
            };

            // ── 5. Register locally with pre-cached img ───────────────────
            const cachedImg = new Image();
            cachedImg.src = compressedSrc;
            imgCache.set(el.id, cachedImg);
            S.elements.set(el.id, el);

            // ── 6. Select & sync ─────────────────────────────────────────
            setTool('select');
            updateShapesBtn('select');
            S.selectedIds.clear();
            S.selectedIds.add(el.id);
            socket.emit('add-element', el);
            pushHistory();
            showToast('Image added — drag corners to resize');
            requestRender();
        };
        tmpImg.src = ev.target.result;
    };
    reader.readAsDataURL(file);
});

// ─── INIT ────────────────────────────────────────────────────────────
async function init() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
        const name = await promptName();
        joinRoom(room, name);
    }

    // Detect theme first so default color is correct
    const isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    if (isLight) {
        S.theme = 'light';
        document.documentElement.setAttribute('data-theme', 'light');
    }

    // ── Default tool: Pen with theme-aware color ──────────────────────
    const defaultColor = isLight ? '#000000' : '#ffffff';
    S.strokeColor = defaultColor;
    strokeColorInput.value = defaultColor;
    setTool('pen');
    updateShapesBtn('pen');

    initColorSwatches();
    initMobileColorBar();
    fillSection.style.display = 'none';
    pushHistory();
    updateCursorStyle();
}

init();
