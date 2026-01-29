const socket = io();

// DOM Elements
const landingView = document.getElementById('landing-view');
const whiteboardView = document.getElementById('whiteboard-view');
const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
const joinIdInput = document.getElementById('join-id');
const roomIdDisplay = document.getElementById('room-id-display');
const copyBtn = document.getElementById('copy-btn');
const exitBtn = document.getElementById('exit-btn');
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
const colorPicker = document.getElementById('color-picker');
const lineWidthInput = document.getElementById('line-width');
const clearBtn = document.getElementById('clear-btn');
const toolBtns = document.querySelectorAll('.tool-btn[data-tool]');

// State
let currentRoom = '';
let isDrawing = false;
let currentTool = 'pen';
let currentColor = '#000000';
let currentLineWidth = 2;
let lastX = 0;
let lastY = 0;

// Initialize
function init() {
    // Resize canvas
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // URL Params check
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    if (roomId) {
        joinRoom(roomId);
    }
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - (window.innerWidth <= 640 ? 120 : 60);
}

// Navigation Logic
createBtn.addEventListener('click', () => {
    const roomId = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit random number
    joinRoom(roomId);
});

joinBtn.addEventListener('click', () => {
    const roomId = joinIdInput.value.trim();
    if (roomId) {
        joinRoom(roomId);
    } else {
        alert('Please enter a Room ID');
    }
});

exitBtn.addEventListener('click', () => {
    window.location.href = '/';
});

function joinRoom(roomId) {
    currentRoom = roomId;
    roomIdDisplay.textContent = roomId;

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    // Switch views
    landingView.classList.add('hidden');
    whiteboardView.classList.remove('hidden');

    // Socket join
    socket.emit('join-room', roomId);
}

copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoom).then(() => {
        alert('Room ID copied to clipboard!');
    });
});

// Drawing Logic
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Touch support
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousedown', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
});

canvas.addEventListener('touchend', (e) => {
    const mouseEvent = new MouseEvent('mouseup', {});
    canvas.dispatchEvent(mouseEvent);
});

function startDrawing(e) {
    isDrawing = true;
    [lastX, lastY] = [e.clientX - canvas.offsetLeft, e.clientY - canvas.offsetTop];
}

function draw(e) {
    if (!isDrawing) return;

    const x = e.clientX - canvas.offsetLeft;
    const y = e.clientY - canvas.offsetTop;

    const drawData = {
        roomId: currentRoom,
        x0: lastX,
        y0: lastY,
        x1: x,
        y1: y,
        color: currentTool === 'eraser' ? '#ffffff' : currentColor,
        width: currentLineWidth,
        tool: currentTool
    };

    // Draw locally
    drawLine(drawData);

    // Emit to server
    socket.emit('drawing', drawData);

    [lastX, lastY] = [x, y];
}

function stopDrawing() {
    isDrawing = false;
}

function drawLine(data) {
    ctx.beginPath();
    ctx.moveTo(data.x0, data.y0);
    ctx.lineTo(data.x1, data.y1);
    ctx.strokeStyle = data.color;
    ctx.lineWidth = data.width;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.closePath();
}

// Socket Events
socket.on('drawing', (data) => {
    drawLine(data);
});

socket.on('clear-board', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
});

// Tools Logic
toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelector('.tool-btn.active').classList.remove('active');
        btn.classList.add('active');
        currentTool = btn.dataset.tool;
    });
});

colorPicker.addEventListener('change', (e) => {
    currentColor = e.target.value;
    if (currentTool === 'eraser') {
        // Switch back to pen if color is picked
        document.querySelector('[data-tool="pen"]').click();
    }
});

lineWidthInput.addEventListener('change', (e) => {
    currentLineWidth = e.target.value;
});

clearBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the whiteboard?')) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        socket.emit('clear-board', currentRoom);
    }
});

init();
