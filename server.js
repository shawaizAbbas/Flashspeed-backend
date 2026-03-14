const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- MAGIC FIX: This tells the server to look everywhere for your HTML files ---
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

// Root message (so you know it's working)
app.get('/', (req, res) => {
    res.send('<h1>Flashspeed Backend is Online</h1><p>Ready for connections!</p>');
});

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// Database
const mongoURI = process.env.MONGO_URI; 
mongoose.connect(mongoURI).then(() => console.log("✅ MongoDB Connected")).catch(err => console.log("❌ DB Error:", err));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

let gameState = { multiplier: 1.00, crashPoint: 0, status: "PREPARING", history: [] };
let activeBets = [];

function startRound() {
    gameState.status = "PREPARING";
    gameState.multiplier = 1.00;
    gameState.crashPoint = (0.99 / (1 - Math.random())).toFixed(2);
    if (gameState.crashPoint < 1.01) gameState.crashPoint = 1.01;
    io.emit('game_state', { status: "PREPARING", history: gameState.history });
    setTimeout(() => {
        gameState.status = "FLYING";
        io.emit('game_state', { status: "FLYING" });
        runFlightLoop();
    }, 5000);
}

function runFlightLoop() {
    let loop = setInterval(() => {
        gameState.multiplier += (gameState.multiplier * 0.005) + 0.01;
        io.emit('tick', gameState.multiplier.toFixed(2));
        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(loop);
            gameState.status = "CRASHED";
            gameState.history.unshift(gameState.crashPoint);
            if (gameState.history.length > 15) gameState.history.pop();
            io.emit('crash', { point: gameState.crashPoint, history: gameState.history });
            activeBets = [];
            setTimeout(startRound, 3000);
        }
    }, 100);
}

io.on('connection', (socket) => {
    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.u, password: data.p });
        if (user) {
            if (user.isBlocked) return socket.emit('login_error', "BLOCKED");
            socket.join(user.username);
            socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
        } else {
            socket.emit('login_error', "Invalid Login");
        }
    });

    socket.on('place_bet', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user && user.balance >= data.amt && gameState.status === "PREPARING") {
            user.balance -= data.amt;
            await user.save();
            activeBets.push({ u: data.u, amt: data.amt, cashed: false });
            socket.emit('update_balance', user.balance);
        }
    });

    socket.on('cashout', async (data) => {
        const bIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (bIndex > -1) {
            activeBets[bIndex].
