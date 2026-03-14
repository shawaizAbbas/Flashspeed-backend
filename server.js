const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- 1. CONFIGURATION & MIDDLEWARE ---
app.use(cors());
app.use(express.json());
// This line allows your HTML files to be seen by the server
app.use(express.static(__dirname));

// Fix for the main link page
app.get('/', (req, res) => {
    res.send('<h1>Flashspeed Server is Online</h1><p>Database Status: Checking...</p>');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 2. DATABASE (MongoDB) ---
const mongoURI = process.env.MONGO_URI; 
let isDbConnected = false;

mongoose.connect(mongoURI)
    .then(() => {
        console.log("✅ MongoDB Connected Successfully");
        isDbConnected = true;
    })
    .catch(err => {
        console.log("❌ DB Connection Error:", err);
        isDbConnected = false;
    });

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

// --- 3. GLOBAL GAME STATE ---
let gameState = {
    multiplier: 1.00,
    crashPoint: 0,
    status: "PREPARING", // PREPARING, FLYING, CRASHED
    history: []
};
let activeBets = [];

// --- 4. THE ENGINE ---
function startRound() {
    gameState.status = "PREPARING";
    gameState.multiplier = 1.00;
    
    // Provably Fair Formula
    gameState.crashPoint = (0.99 / (1 - Math.random())).toFixed(2);
    if (gameState.crashPoint < 1.01) gameState.crashPoint = 1.01;

    console.log(`New Round! Crash: ${gameState.crashPoint}x`);
    
    io.emit('game_state', { 
        status: "PREPARING", 
        multiplier: "1.00", 
        history: gameState.history 
    });

    // 5 second betting phase
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

        // Simulate fake players for the lobby view
        if (Math.random() < 0.05) {
            io.emit('fake_cashout', {
                name: ["Ali", "Ahmed", "User99", "Zain", "Maya"][Math.floor(Math.random()*5)],
                mult: gameState.multiplier.toFixed(2)
            });
        }

        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(loop);
            doCrash();
        }
    }, 100);
}

function doCrash() {
    gameState.status = "CRASHED";
    gameState.history.unshift(gameState.crashPoint);
    if (gameState.history.length > 20) gameState.history.pop();

    io.emit('crash', { point: gameState.crashPoint, history: gameState.history });
    activeBets = [];
    setTimeout(startRound, 3000);
}

// --- 5. SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('User joined connection');

    // Login logic
    socket.on('login', async (data) => {
        if (!isDbConnected) return socket.emit('login_error', "Database Error. Try again in 1 minute.");
        
        try {
            const user = await User.findOne({ username: data.u, password: data.p });
            if (user) {
                if (user.isBlocked) return socket.emit('login_error', "ACCOUNT BLOCKED. Contact Admin.");
                socket.join(user.username);
                socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
            } else {
                socket.emit('login_error', "Invalid login. Contact 00923426693085");
            }
        } catch (e) { socket.emit('login_error', "Server Busy."); }
    });

    // Betting logic
    socket.on('place_bet', async (data) => {
        try {
            const user = await User.findOne({ username: data.u });
            if (user && user.balance >= data.amt && gameState.status === "PREPARING") {
                user.balance -= data.amt;
                await user.save();
                activeBets.push({ u: data.u, amt: data.amt, cashed: false });
                socket.emit('update_balance', user.balance);
            }
        } catch (e) { console.log(e); }
    });

    // Cashout logic
    socket.on('cashout', async (data) => {
        if (gameState.status !== "FLYING") return;
        const bIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (bIndex > -1) {
            activeBets[bIndex].cashed = true;
            const user = await User.findOne({ username: data.u });
            const win = activeBets[bIndex].amt * gameState.multiplier;
            user.balance += win;
            await user.save();
            socket.emit('update_balance', user.balance);
            io.emit('player_won', { u: data.u, mult: gameState.multiplier.toFixed(2) });
        }
    });

    // --- ADMIN COMMANDS ---
    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        await User.create({ username: data.u, password: data.p, balance: 0 });
        const users = await User.find({});
        io.emit('admin_user_list', users);
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
            io.to(username).emit('forced_logout', "Admin has blocked your account.");
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
server.listen(PORT, () => { startRound(); });
