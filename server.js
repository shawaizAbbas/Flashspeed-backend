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

// This fix stops the "Cannot GET /" error
app.get('/', (req, res) => {
    res.send('<h1>Flashspeed Backend is Online</h1><p>Status: Ready for Connections</p>');
});

const server = http.createServer(app);

// Socket.io Setup with CORS for cross-device playing
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- 2. DATABASE SETUP (MongoDB) ---
const mongoURI = process.env.MONGO_URI; 

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.log("❌ MongoDB Connection Error:", err));

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

// --- 4. THE GAME ENGINE ---
function startRound() {
    gameState.status = "PREPARING";
    gameState.multiplier = 1.00;
    
    // Generate crash point (Server side)
    gameState.crashPoint = (0.99 / (1 - Math.random())).toFixed(2);
    if (gameState.crashPoint < 1.01) gameState.crashPoint = 1.01;

    console.log(`Round starting... Next Crash: ${gameState.crashPoint}x`);
    
    io.emit('game_state', { 
        status: "PREPARING", 
        multiplier: "1.00", 
        history: gameState.history 
    });

    // 5 second waiting/betting time
    setTimeout(() => {
        gameState.status = "FLYING";
        io.emit('game_state', { status: "FLYING" });
        runFlightLoop();
    }, 5000);
}

function runFlightLoop() {
    let loop = setInterval(() => {
        // Multiplier speed logic
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
    activeBets = []; // Reset bets
    
    setTimeout(startRound, 3000); // 3 second pause
}

// --- 5. PLAYER & ADMIN SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('A user connected');

    // --- LOGIN ---
    socket.on('login', async (data) => {
        try {
            const user = await User.findOne({ username: data.u, password: data.p });
            if (!user) {
                return socket.emit('login_error', "Invalid Login. Contact 00923426693085");
            }
            if (user.isBlocked) {
                return socket.emit('login_error', "ACCOUNT BLOCKED. Contact Admin.");
            }
            
            socket.join(user.username); // Join a private room for balance updates
            socket.emit('login_success', { 
                u: user.username, 
                balance: user.balance, 
                history: gameState.history 
            });
        } catch (e) {
            console.log("Login Logic Error:", e);
        }
    });

    // --- PLACING BETS ---
    socket.on('place_bet', async (data) => {
        if (gameState.status !== "PREPARING") return;
        
        try {
            const user = await User.findOne({ username: data.u });
            if (user && !user.isBlocked && user.balance >= data.amt) {
                user.balance -= data.amt;
                await user.save();
                activeBets.push({ u: data.u, amt: data.amt, cashed: false });
                socket.emit('update_balance', user.balance);
            }
        } catch (e) { console.log("Betting error:", e); }
    });

    // --- CASH OUT ---
    socket.on('cashout', async (data) => {
        if (gameState.status !== "FLYING") return;
        
        const betIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (betIndex > -1) {
            activeBets[betIndex].cashed = true;
            try {
                const user = await User.findOne({ username: data.u });
                const win = activeBets[betIndex].amt * gameState.multiplier;
                user.balance += win;
                await user.save();
                
                socket.emit('update_balance', user.balance);
                io.emit('player_won', { u: data.u, mult: gameState.multiplier.toFixed(2) });
            } catch (e) { console.log("Cashout error:", e); }
        }
    });

    // --- ADMIN COMMANDS ---

    // Get List
    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    // Create Account
    socket.on('admin_create_user', async (data) => {
        try {
            await User.create({ username: data.u, password: data.p, balance: 0 });
            const users = await User.find({});
            io.emit('admin_user_list', users);
        } catch (e) { console.log("Creation Error (User likely exists)"); }
    });

    // Set Balance (Add or Remove Money)
    socket.on('admin_set_balance', async (data) => {
        try {
            const user = await User.findOne({ username: data.u });
            if (user) {
                user.balance = parseFloat(data.amt);
                await user.save();
                io.to(data.u).emit('update_balance', user.balance);
                const users = await User.find({});
                io.emit('admin_user_list', users);
            }
        } catch (e) { console.log("Admin Balance Error:", e); }
    });

    // Block User
    socket.on('admin_block_user', async (username) => {
        try {
            const user = await User.findOne({ username: username });
            if (user) {
                user.isBlocked = true;
                await user.save();
                io.to(username).emit('forced_logout', "Your account has been blocked.");
                const users = await User.find({});
                io.emit('admin_user_list', users);
            }
        } catch (e) { console.log("Admin Block Error:", e); }
    });

    // Unblock User
    socket.on('admin_unblock_user', async (username) => {
        try {
            const user = await User.findOne({ username: username });
            if (user) {
                user.isBlocked = false;
                await user.save();
                const users = await User.find({});
                io.emit('admin_user_list', users);
            }
        } catch (e) { console.log("Admin Unblock Error:", e); }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- 6. START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Flashspeed Engine running on port ${PORT}`);
    startRound();
});