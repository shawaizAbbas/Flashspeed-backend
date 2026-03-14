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
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000 
});

// --- DATABASE CONNECTION ---
const mongoURI = process.env.MONGO_URI; 
let isDbConnected = false;

if (mongoURI) {
    // We tell Mongoose to try connecting and not give up
    mongoose.connect(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    }).then(() => {
        console.log("✅ ✅ ✅ DATABASE CONNECTED SUCCESSFULLY ✅ ✅ ✅");
        isDbConnected = true;
    }).catch(err => {
        console.log("❌ DB CONNECTION ERROR: ", err.message);
        isDbConnected = false;
    });
} else {
    console.log("❌ ERROR: MONGO_URI variable is missing in Render!");
}

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// --- GAME LOGIC ---
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
        if (!isDbConnected) {
            return socket.emit('login_error', "DB Connection is still starting. Try again in 10 seconds.");
        }
        try {
            const user = await User.findOne({ username: data.u.toLowerCase(), password: data.p });
            if (user) {
                socket.join(user.username);
                socket.emit('login_success', { u: user.username, balance: user.balance, history: gameState.history });
            } else {
                socket.emit('login_error', "Invalid Username or Password.");
            }
        } catch (e) {
            socket.emit('login_error', "Database is busy. Click login again.");
        }
    });

    socket.on('admin_get_users', async () => {
        if (!isDbConnected) return;
        const users = await User.find({});
        socket.emit('admin_user_list', users);
    });

    socket.on('admin_create_user', async (data) => {
        if (!isDbConnected) return;
        try {
            await User.create({ username: data.u.toLowerCase(), password: data.p, balance: 0 });
            const users = await User.find({});
            io.emit('admin_user_list', users);
        } catch (e) { console.log("Create Error"); }
    });

    socket.on('admin_set_balance', async (data) => {
        if (!isDbConnected) return;
        const user = await User.findOne({ username: data.u.toLowerCase() });
        if (user) {
            user.balance = parseFloat(data.amt);
            await user.save();
            const users = await User.find({});
            io.emit('admin_user_list', users);
            io.to(data.u.toLowerCase()).emit('update_balance', user.balance);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Server listening on port ${PORT}`);
    startRound();
});
