const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const JWT_SECRET = process.env.JWT_SECRET || 'dc-clone-' + uuidv4();
const PORT = process.env.PORT || 3000;

const dbPath = path.join(__dirname, '..', 'data', 'discord.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  avatar TEXT,
  status TEXT DEFAULT 'offline',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 0,
  position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  timestamp TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(from_id, to_id, status);
`);

const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const adminId = uuidv4();
  const guildId = uuidv4();
  const ch1 = uuidv4(), ch2 = uuidv4(), ch3 = uuidv4();
  db.prepare('INSERT INTO users (id,username,email,password,status) VALUES (?,?,?,?,?)').run(
    adminId, 'Admin', 'admin@discord.clone', bcrypt.hashSync('admin123', 10), 'online'
  );
  db.prepare('INSERT INTO guilds (id,name,owner_id) VALUES (?,?,?)').run(guildId, 'Servidor Geral', adminId);
  db.prepare('INSERT INTO channels (id,guild_id,name,type,position) VALUES (?,?,?,?,?)').run(ch1, guildId, 'geral', 0, 0);
  db.prepare('INSERT INTO channels (id,guild_id,name,type,position) VALUES (?,?,?,?,?)').run(ch2, guildId, 'memes', 0, 1);
  db.prepare('INSERT INTO channels (id,guild_id,name,type,position) VALUES (?,?,?,?,?)').run(ch3, guildId, 'Voz Geral', 2, 2);
  db.prepare('INSERT INTO memberships (guild_id,user_id) VALUES (?,?)').run(guildId, adminId);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const clients = new Map();

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token necessário' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,username,email,avatar,status FROM users WHERE id=?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Nome deve ter 2-32 caracteres' });
  const exists = db.prepare('SELECT id FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)').get(email, username);
  if (exists) return res.status(409).json({ error: 'Email ou nome de usuário já existe' });
  const id = uuidv4();
  db.prepare('INSERT INTO users (id,username,email,password) VALUES (?,?,?,?)').run(id, username, email, bcrypt.hashSync(password, 10));
  const guilds = db.prepare('SELECT id FROM guilds').all();
  const insMem = db.prepare('INSERT OR IGNORE INTO memberships (guild_id,user_id) VALUES (?,?)');
  for (const g of guilds) insMem.run(g.id, id);
  const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username, email, avatar: null } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email)=LOWER(?)').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Email ou senha incorretos' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('online', user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar } });
});

app.get('/api/users/@me', auth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, email: req.user.email, avatar: req.user.avatar });
});

app.get('/api/users/@me/guilds', auth, (req, res) => {
  const rows = db.prepare(`SELECT g.id,g.name,g.icon,g.owner_id FROM guilds g
    JOIN memberships m ON m.guild_id=g.id WHERE m.user_id=? ORDER BY g.created_at`).all(req.user.id);
  res.json(rows);
});

app.get('/api/guilds/:guildId/channels', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM channels WHERE guild_id=? ORDER BY position').all(req.params.guildId);
  res.json(rows);
});

app.get('/api/channels/:channelId/messages', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const rows = db.prepare(`SELECT m.id,m.channel_id,m.content,m.timestamp,
    u.id as author_id,u.username as author_username,u.avatar as author_avatar
    FROM messages m JOIN users u ON u.id=m.author_id
    WHERE m.channel_id=? ORDER BY m.timestamp DESC LIMIT ?`).all(req.params.channelId, limit);
  res.json(rows.reverse().map(r => ({
    id: r.id, channelId: r.channel_id, content: r.content, timestamp: r.timestamp,
    author: { id: r.author_id, username: r.author_username, avatar: r.author_avatar }
  })));
});

app.post('/api/channels/:channelId/messages', auth, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  if (content.length > 2000) return res.status(400).json({ error: 'Mensagem muito longa (max 2000)' });
  const id = uuidv4();
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO messages (id,channel_id,author_id,content,timestamp) VALUES (?,?,?,?,?)').run(id, req.params.channelId, req.user.id, content.trim(), ts);
  const msg = { id, channelId: req.params.channelId, content: content.trim(), timestamp: ts, author: { id: req.user.id, username: req.user.username, avatar: req.user.avatar } };
  broadcastToChannel(req.params.channelId, { type: 'MESSAGE_CREATE', data: msg });
  res.status(201).json(msg);
});

app.post('/api/guilds', auth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });
  const id = uuidv4(), chId = uuidv4();
  db.prepare('INSERT INTO guilds (id,name,owner_id) VALUES (?,?,?)').run(id, name.trim(), req.user.id);
  db.prepare('INSERT INTO channels (id,guild_id,name,type,position) VALUES (?,?,?,?,?)').run(chId, id, 'geral', 0, 0);
  db.prepare('INSERT INTO memberships (guild_id,user_id) VALUES (?,?)').run(id, req.user.id);
  const guild = { id, name: name.trim(), icon: null, owner_id: req.user.id };
  broadcastAll({ type: 'GUILD_CREATE', data: guild, userId: req.user.id });
  res.status(201).json(guild);
});

app.get('/api/guilds/:guildId/members', auth, (req, res) => {
  const rows = db.prepare(`SELECT u.id,u.username,u.avatar,u.status,m.nick,m.joined_at
    FROM memberships mem JOIN users u ON u.id=mem.user_id
    LEFT JOIN memberships m ON m.guild_id=mem.guild_id AND m.user_id=u.id
    WHERE mem.guild_id=?`).all(req.params.guildId);
  res.json(rows.map(r => ({
    user: { id: r.id, username: r.username, avatar: r.avatar },
    nick: r.nick, status: clients.has(r.id) ? 'online' : 'offline', joinedAt: r.joined_at
  })));
});

app.get('/api/users/@me/friends', auth, (req, res) => {
  const rows = db.prepare(`SELECT f.id,f.status,f.created_at,
    CASE WHEN f.from_id=? THEN f.to_id ELSE f.from_id END as friend_id
    FROM friendships f WHERE (f.from_id=? OR f.to_id=?) AND f.status IN ('accepted','pending')
    ORDER BY f.created_at DESC`).all(req.user.id, req.user.id, req.user.id);
  const result = rows.map(r => {
    const u = db.prepare('SELECT id,username,avatar,status FROM users WHERE id=?').get(r.friend_id);
    if (!u) return null;
    return {
      id: r.id, status: r.status, createdAt: r.created_at,
      direction: r.friend_id === r.friend_id ? (db.prepare('SELECT from_id FROM friendships WHERE id=?').get(r.id).from_id === req.user.id ? 'outgoing' : 'incoming') : 'incoming',
      user: { id: u.id, username: u.username, avatar: u.avatar, status: clients.has(u.id) ? 'online' : 'offline' }
    };
  }).filter(Boolean);
  res.json(result);
});

app.post('/api/friends/request', auth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Nome de usuário é obrigatório' });
  const target = db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?)').get(username);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
  const existing = db.prepare('SELECT id,status FROM friendships WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').get(req.user.id, target.id, target.id, req.user.id);
  if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Já são amigos' : 'Solicitação já enviada' });
  const id = uuidv4();
  db.prepare('INSERT INTO friendships (id,from_id,to_id,status) VALUES (?,?,?,?)').run(id, req.user.id, target.id, 'pending');
  const ws = clients.get(target.id);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'FRIEND_REQUEST', data: { id, from: { id: req.user.id, username: req.user.username } } }));
  res.status(201).json({ id, status: 'pending' });
});

app.post('/api/friends/:id/accept', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM friendships WHERE id=? AND to_id=? AND status=?').get(req.params.id, req.user.id, 'pending');
  if (!f) return res.status(404).json({ error: 'Solicitação não encontrada' });
  db.prepare('UPDATE friendships SET status=? WHERE id=?').run('accepted', req.params.id);
  const fromUser = db.prepare('SELECT id,username FROM users WHERE id=?').get(f.from_id);
  const ws = clients.get(f.from_id);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'FRIEND_ACCEPTED', data: { user: { id: req.user.id, username: req.user.username } } }));
  res.json({ status: 'accepted' });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM friendships WHERE id=? AND (from_id=? OR to_id=?)').get(req.params.id, req.user.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  db.prepare('DELETE FROM friendships WHERE id=?').run(req.params.id);
  const otherId = f.from_id === req.user.id ? f.to_id : f.from_id;
  const ws = clients.get(otherId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'FRIEND_REMOVED', data: { userId: req.user.id } }));
  res.json({ ok: true });
});

app.get('/api/users/search', auth, (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);
  const rows = db.prepare('SELECT id,username,avatar FROM users WHERE LOWER(username) LIKE LOWER(?) AND id!=? LIMIT 10').all('%' + q + '%', req.user.id);
  res.json(rows);
});

function broadcastToChannel(channelId, payload) {
  const ch = db.prepare('SELECT guild_id FROM channels WHERE id=?').get(channelId);
  if (!ch) return;
  const memberIds = new Set(db.prepare('SELECT user_id FROM memberships WHERE guild_id=?').all(ch.guild_id).map(r => r.user_id));
  for (const [userId, ws] of clients) {
    if (memberIds.has(userId) && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }
}

function broadcastAll(payload) {
  for (const [, ws] of clients) { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); }
}

function broadcastToUser(userId, payload) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) { ws.close(4001, 'Token necessário'); return; }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,username FROM users WHERE id=?').get(decoded.userId);
    if (!user) { ws.close(4001, 'Usuário não encontrado'); return; }
    clients.set(user.id, ws);
    ws.userId = user.id;
    db.prepare('UPDATE users SET status=? WHERE id=?').run('online', user.id);
    broadcastAll({ type: 'PRESENCE_UPDATE', data: { userId: user.id, status: 'online' } });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'WEBRTC_SIGNAL') {
          const targetWs = clients.get(msg.targetUserId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', data: msg.data, fromUserId: user.id }));
          }
        } else if (msg.type === 'CALL_REQUEST') {
          const targetWs = clients.get(msg.targetUserId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ type: 'CALL_REQUEST', data: { fromUser: { id: user.id, username: user.username }, callType: msg.callType, roomId: msg.roomId } }));
          }
        } else if (msg.type === 'CALL_RESPONSE') {
          const targetWs = clients.get(msg.targetUserId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ type: 'CALL_RESPONSE', data: { accepted: msg.accepted, roomId: msg.roomId, fromUserId: user.id } }));
          }
        } else if (msg.type === 'CALL_END') {
          const targetWs = clients.get(msg.targetUserId);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({ type: 'CALL_END', data: { fromUserId: user.id } }));
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(user.id);
      db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', user.id);
      broadcastAll({ type: 'PRESENCE_UPDATE', data: { userId: user.id, status: 'offline' } });
    });
  } catch { ws.close(4001, 'Token inválido'); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Banco de dados: ${dbPath}`);
  console.log(`Conta padrão: admin@discord.clone / admin123`);
});