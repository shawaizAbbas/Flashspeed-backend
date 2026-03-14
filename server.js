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
mongoose.connect(mongoURI).then(() => console.log("✅ DB Connected")).catch(err => console.log("❌ DB Error"));

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
    
    // Generate Fake Players
    const names = ["Ahmed", "Ali", "Zain", "Lucas", "Musa", "Sara", "John", "Elena", "Khan", "Sabiri"];
    let fakes = [];
    for(let i=0; i<12; i++) {
        fakes.push({ name: names[Math.floor(Math.random()*names.length)], amt: (Math.random()*100 + 10).toFixed(0) });
    }
    io.emit('fake_list', fakes);

    setTimeout(() => {
        gameState.status = "FLYING";
        io.emit('game_state', { status: "FLYING" });
        runFlightLoop();
    }, 5000);
}

function runFlightLoop() {
    let loop = setInterval(() => {
        gameState.multiplier += (gameState.multiplier * 0.007) + 0.01;
        io.emit('tick', gameState.multiplier.toFixed(2));

        if(Math.random() < 0.12) io.emit('fake_cashout_now', { mult: gameState.multiplier.toFixed(2) });

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
        const user = await User.findOne({ username: data.u.trim().toLowerCase(), password: data.p });
        if (user) {
            if (user.isBlocked) return socket.emit('login_error', "Account Blocked");
            socket.join(user.username);
            socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
        } else { socket.emit('login_error', "Wrong Username or Password"); }
    });

    socket.on('place_bet', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user && user.balance >= data.amt) {
            user.balance -= data.amt;
            await user.save();
            const betObj = { u: data.u, amt: data.amt, cashed: false };
            if(gameState.status === "PREPARING") activeBets.push(betObj);
            else queuedBets.push(betObj);
            io.to(user.username).emit('update_balance', user.balance);
            io.emit('admin_update_bets', {active: activeBets, queued: queuedBets});
        }
    });

    socket.on('cashout_request', async (data) => {
        const bIndex = activeBets.findIndex(b => b.u === data.u && !b.cashed);
        if (bIndex > -1 && gameState.status === "FLYING") {
            activeBets[bIndex].cashed = true;
            const user = await User.findOne({ username: data.u });
            const win = activeBets[bIndex].amt * gameState.multiplier;
            user.balance += win;
            await user.save();
            io.to(user.username).emit('update_balance', user.balance);
            socket.emit('cashout_ok', { win: win.toFixed(2) });
            io.emit('admin_update_bets', {active: activeBets, queued: queuedBets});
        }
    });

    // ADMIN EVENTS
    socket.on('admin_get_users', async () => {
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        try {
            await User.create({ username: data.u.trim().toLowerCase(), password: data.p, balance: 0 });
            const users = await User.find({});
            io.emit('admin_user_list', users);
        } catch (e) { console.log("User creation failed: " + e.message); }
    });

    socket.on('admin_adjust_balance', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user) {
            if(data.type === 'add') user.balance += parseFloat(data.amt);
            else user.balance -= parseFloat(data.amt);
            await user.save();
            io.to(user.username).emit('update_balance', user.balance);
            const users = await User.find({}); io.emit('admin_user_list', users);
        }
    });

    socket.on('admin_delete_user', async (u) => {
        await User.deleteOne({ username: u });
        const users = await User.find({}); io.emit('admin_user_list', users);
    });

    socket.on('admin_block_user', async (u) => {
        const user = await User.findOne({ username: u });
        if(user) { user.isBlocked = !user.isBlocked; await user.save(); 
        const users = await User.find({}); io.emit('admin_user_list', users); }
    });

    socket.on('admin_crash_now', () => { manualCrashTriggered = true; });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { startRound(); });
