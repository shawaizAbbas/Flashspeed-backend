const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Force the server to see the current folder
const directory = path.resolve();
app.use(express.static(directory));

// Routes
app.get('/', (req, res) => { res.sendFile(path.join(directory, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(directory, 'control_923426693085.html')); });

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true 
});

// Database
const mongoURI = process.env.MONGO_URI; 
if (mongoURI) {
    mongoose.connect(mongoURI)
        .then(() => console.log("✅ DATABASE CONNECTED"))
        .catch(err => console.log("❌ DATABASE ERROR: " + err.message));
} else {
    console.log("❌ ERROR: MONGO_URI is missing in Environment Variables");
}

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

io.on('connection', (socket) => {
    console.log('📡 NEW CONNECTION: A user just opened the app');

    socket.on('admin_get_users', async () => {
        console.log("📝 Admin requested user list...");
        try {
            const users = await User.find({});
            socket.emit('admin_user_list', users);
        } catch (e) { console.log("DB Fetch Error: " + e.message); }
    });

    socket.on('admin_create_user', async (data) => {
        try {
            await User.create({ username: data.u, password: data.p, balance: 0 });
            const users = await User.find({});
            io.emit('admin_user_list', users);
        } catch (e) { console.log("Create error"); }
    });

    socket.on('admin_set_balance', async (data) => {
        const user = await User.findOne({ username: data.u });
        if (user) {
            user.balance = parseFloat(data.amt);
            await user.save();
            const users = await User.find({});
            io.emit('admin_user_list', users);
            io.emit('update_balance_global', { u: data.u, b: user.balance });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 SERVER IS LIVE ON PORT ${PORT}`); 
});
