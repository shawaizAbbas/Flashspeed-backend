const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- 1. MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// This tells the server to look for your HTML files in the main folder
app.use(express.static(__dirname));

const server = http.createServer(app);

// Socket.io Setup
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- 2. DATABASE SETUP ---
const mongoURI = process.env.MONGO_URI; 
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Error:", err));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

// --- 3. GAME STATE ---
let gameState = { multiplier: 1.00, crashPoint: 0, status: "PREPARING", history: [] };
let activeBets = [];

function startRound() {
    gameState.status = "PREPARING";
    gameState.multiplier = 1.00;
    gameState.crashPoint = (0.99 / (1 - Math.random())).toFixed(2);
    if (gameState.crashPoint < 1.01) gameState.crashPoint = 1.01;
    io.emit('game_state', { status: "PREPARING", multiplier: "1.00", history: gameState.history });
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
            doCrash();
        }
    }, 100);
}

function doCrash() {
    gameState.status = "CRASHED";
    gameState.history.unshift(gameState.crashPoint);
    if (gameState.history.length > 15) gameState.history.pop();
    io.emit('crash', { point: gameState.crashPoint, history: gameState.history });
    activeBets = [];
    setTimeout(startRound, 3000);
}

// --- 4. SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.u, password: data.p });
        if (!user) return socket.emit('login_error', "Contact 00923426693085");
        if (user.isBlocked) return socket.emit('login_error', "BLOCKED");
        socket.join(user.username);
        socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
    });

    socket.on('place_bet', async (data) => {
        if (gameState.status !== "PREPARING") return;
        const user = await User.findOne({ username: data.u });
        if (user && !user.isBlocked && user.balance >= data.amt) {
            user.balance -= data.amt;
            await user.save();
            activeBets.push({ u: data.u, amt: data.amt, cashed: false });
            socket.emit('update_balance', user.balance);
        }
    });

    socket.on('cashout', async (data) => {
        if (gameState.status !== "FLYING") return;
        const betIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (betIndex > -1) {
            activeBets[betIndex].cashed = true;
            const user = await User.findOne({ username: data.u });
            const win = activeBets[betIndex].amt * gameState.multiplier;
            user.balance += win;
            await user.save();
            socket.emit('update_balance', user.balance);
            io.emit('player_won', { u: data.u, mult: gameState.multiplier.toFixed(2) });
        }
    });

    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        try {
            await User.create({ username: data.u, password: data.p, balance: 0 });
            const users = await User.find({});
            io.emit('admin_user_list', users);
        } catch (e) { }
    });

    socket.on('admin_set_balance', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user) {
            user.balance = parseFloat(data.amt);
            await user.save();
            io.to(data.u).emit('update_balance', user.balance);
            const users = await User.find({});
            io.emit('admin_user_list', users);
        }
    });

    socket.on('admin_block_user', async (username) => {
        const user = await User.findOne({ username: username });
        if (user) {
            user.isBlocked = true;
            await user.save();
            io.to(username).emit('forced_logout', "Blocked.");
            const users = await User.find({});
            io.emit('admin_user_list', users);
        }
    });

    socket.on('admin_unblock_user', async (username) => {
        const user = await User.findOne({ username: username });
        if (user) {
            user.isBlocked = false;
            await user.save();
            const users = await User.find({});
            io.emit('admin_user_list', users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Running on port ${PORT}`);
    startRound();
});
