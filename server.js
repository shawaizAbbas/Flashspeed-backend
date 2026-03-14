const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
const directory = path.resolve();
app.use(express.static(directory));

app.get('/', (req, res) => { res.sendFile(path.join(directory, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(directory, 'control_923426693085.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const mongoURI = process.env.MONGO_URI; 
let isDbConnected = false;
mongoose.connect(mongoURI).then(() => { isDbConnected = true; console.log("✅ DB Connected"); }).catch(err => console.log("❌ DB Error"));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

let gameState = { multiplier: 1.00, crashPoint: 0, status: "PREPARING", history: [] };
let activeBets = [];
let queuedBets = [];
let manualCrashTriggered = false;

function startRound() {
    gameState.status = "PREPARING";
    gameState.multiplier = 1.00;
    manualCrashTriggered = false;
    activeBets = [...queuedBets];
    queuedBets = [];
    gameState.crashPoint = (0.99 / (1 - Math.random())).toFixed(2);
    if (gameState.crashPoint < 1.01) gameState.crashPoint = 1.01;
    io.emit('game_state', { status: "PREPARING", history: gameState.history });
    io.emit('admin_update_bets', activeBets);
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

        if (gameState.multiplier >= gameState.crashPoint || manualCrashTriggered) {
            clearInterval(loop);
            gameState.status = "CRASHED";
            gameState.history.unshift(gameState.multiplier.toFixed(2));
            if (gameState.history.length > 15) gameState.history.pop();
            io.emit('crash', { point: gameState.multiplier.toFixed(2), history: gameState.history });
            activeBets = [];
            setTimeout(startRound, 3000);
        }
    }, 100);
}

io.on('connection', (socket) => {
    socket.on('login', async (data) => {
        const user = await User.findOne({ username: data.u.trim().toLowerCase() });
        if (!user) return socket.emit('login_error', "User not found");
        if (user.password !== data.p) return socket.emit('login_error', "Wrong Password");
        if (user.isBlocked) return socket.emit('login_error', "Blocked");
        socket.join(user.username);
        socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
    });

    socket.on('place_bet', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user && user.balance >= data.amt && !user.isBlocked) {
            user.balance -= data.amt;
            await user.save();
            const betObj = { u: data.u, amt: data.amt, cashed: false };
            if(gameState.status === "PREPARING") activeBets.push(betObj);
            else queuedBets.push(betObj);
            socket.emit('update_balance', user.balance);
            io.emit('admin_update_bets', activeBets);
        }
    });

    socket.on('cashout', async (data) => {
        const bIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (bIndex > -1 && gameState.status === "FLYING") {
            activeBets[bIndex].cashed = true;
            const user = await User.findOne({ username: data.u });
            const win = activeBets[bIndex].amt * gameState.multiplier;
            user.balance += win;
            await user.save();
            socket.emit('update_balance', user.balance);
            io.emit('admin_update_bets', activeBets);
        }
    });

    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        try { await User.create({ username: data.u.trim().toLowerCase(), password: data.p, balance: 0 }); 
        const users = await User.find({}); socket.emit('admin_user_list', users); } catch(e){}
    });

    socket.on('admin_adjust_balance', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user) {
            if(data.type === 'add') user.balance += parseFloat(data.amt);
            else user.balance -= parseFloat(data.amt);
            await user.save();
            io.to(user.username).emit('update_balance', user.balance);
            const users = await User.find({}); socket.emit('admin_user_list', users);
        }
    });

    socket.on('admin_delete_user', async (u) => {
        await User.deleteOne({ username: u });
        const users = await User.find({}); socket.emit('admin_user_list', users);
    });

    socket.on('admin_block_user', async (u) => {
        const user = await User.findOne({ username: u });
        if(user) { user.isBlocked = !user.isBlocked; await user.save(); 
        const users = await User.find({}); socket.emit('admin_user_list', users); }
    });

    socket.on('admin_crash_now', () => { manualCrashTriggered = true; });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { startRound(); });
