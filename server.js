const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// This tells the server exactly where your files are
const directory = path.resolve();
app.use(express.static(directory));

// Show a message on the main page to prove it is working
app.get('/', (req, res) => {
    res.sendFile(path.join(directory, 'index.html'));
});

// The Admin Link
app.get('/admin', (req, res) => {
    res.sendFile(path.join(directory, 'control_923426693085.html'));
});

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] } 
});

// Database - With a timeout so it doesn't stay stuck on a white screen
const mongoURI = process.env.MONGO_URI; 
if (mongoURI) {
    mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 5000 })
        .then(() => console.log("✅ MongoDB Connected"))
        .catch(err => console.log("❌ DB Error: " + err.message));
}

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
        try {
            const user = await User.findOne({ username: data.u, password: data.p });
            if (user) {
                if (user.isBlocked) return socket.emit('login_error', "BLOCKED");
                socket.join(user.username);
                socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
            } else {
                socket.emit('login_error', "Invalid Login");
            }
        } catch (e) { socket.emit('login_error', "DB Error"); }
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
        } catch (e) {}
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
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); startRound(); });
