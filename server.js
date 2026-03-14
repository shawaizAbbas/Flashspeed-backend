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
mongoose.connect(mongoURI).then(() => { isDbConnected = true; console.log("✅ DB Connected"); }).catch(err => console.log("❌ DB Error: ", err.message));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }
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

        // Send Fake Players to Client Lobby
        if(Math.random() < 0.08) {
            const names = ["Ahmed", "Ali", "Zain", "Lucas", "Musa", "John", "Sara", "Elena"];
            io.emit('fake_cashout', { name: names[Math.floor(Math.random()*names.length)], mult: gameState.multiplier.toFixed(2) });
        }

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
        if (!isDbConnected) return socket.emit('login_error', "DB starting...");
        const user = await User.findOne({ username: data.u.toLowerCase(), password: data.p });
        if (user) {
            socket.join(user.username);
            socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
        } else { socket.emit('login_error', "Invalid login"); }
    });

    socket.on('place_bet', async (data) => {
        const user = await User.findOne({ username: data.u.toLowerCase() });
        if (user && user.balance >= data.amt && gameState.status === "PREPARING") {
            user.balance -= data.amt;
            await user.save();
            activeBets.push({ u: data.u.toLowerCase(), amt: data.amt, cashed: false });
            socket.emit('update_balance', user.balance);
        }
    });

    socket.on('cashout', async (data) => {
        const bIndex = activeBets.findIndex(b => b.u === data.u.toLowerCase() && !b.cashed);
        if (bIndex > -1 && gameState.status === "FLYING") {
            activeBets[bIndex].cashed = true;
            const user = await User.findOne({ username: data.u.toLowerCase() });
            const win = activeBets[bIndex].amt * gameState.multiplier;
            user.balance += win;
            await user.save();
            socket.emit('update_balance', user.balance);
        }
    });

    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        try { await User.create({ username: data.u.toLowerCase(), password: data.p, balance: 0 }); const users = await User.find({}); io.emit('admin_user_list', users); } catch (e) {}
    });

    socket.on('admin_set_balance', async (data) => {
        const user = await User.findOne({ username: data.u.toLowerCase() });
        if (user) { user.balance = parseFloat(data.amt); await user.save(); const users = await User.find({}); io.emit('admin_user_list', users); io.to(data.u.toLowerCase()).emit('update_balance', user.balance); }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { startRound(); });
