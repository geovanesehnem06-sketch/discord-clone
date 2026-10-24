const API = window.location.origin + '/api';
const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

let S = {
  token: localStorage.getItem('dc_token') || '',
  user: null, guilds: [], channels: {}, messages: {}, members: {},
  friends: [], pendingFriends: [],
  activeGuildId: null, activeChannelId: null, activeView: 'chat',
  ws: null, loggedIn: false, error: '', loading: false, authMode: 'login',
  call: null, localStream: null, remoteStream: null, peerConn: null,
  screenStream: null, callType: null, callPartner: null, incomingCall: null,
};

function set(p) { S = { ...S, ...p }; render(); }

async function api(method, ep, body) {
  const h = { 'Content-Type': 'application/json' };
  if (S.token) h['Authorization'] = 'Bearer ' + S.token;
  const o = { method, headers: h };
  if (body) o.body = JSON.stringify(body);
  const r = await fetch(API + ep, o);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Erro ' + r.status);
  return d;
}

async function doLogin(email, password) {
  set({ loading: true, error: '' });
  try {
    const r = await api('POST', '/login', { email, password });
    localStorage.setItem('dc_token', r.token);
    set({ token: r.token, user: r.user, loggedIn: true, loading: false });
    connectWS(r.token); loadAll();
  } catch (e) { set({ error: e.message, loading: false }); }
}

async function doRegister(username, email, password) {
  set({ loading: true, error: '' });
  try {
    const r = await api('POST', '/register', { username, email, password });
    localStorage.setItem('dc_token', r.token);
    set({ token: r.token, user: r.user, loggedIn: true, loading: false });
    connectWS(r.token); loadAll();
  } catch (e) { set({ error: e.message, loading: false }); }
}

async function loadAll() {
  try {
    const [guilds, friends] = await Promise.all([
      api('GET', '/users/@me/guilds'),
      api('GET', '/users/@me/friends'),
    ]);
    const accepted = friends.filter(f => f.status === 'accepted');
    const pending = friends.filter(f => f.status === 'pending');
    set({ guilds, friends: accepted, pendingFriends: pending });
    if (guilds.length > 0) selectGuild(guilds[0].id);
  } catch (e) { console.error(e); }
}

function connectWS(token) {
  if (S.ws) S.ws.close();
  const ws = new WebSocket(WS_URL + '?token=' + token);
  set({ ws });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'MESSAGE_CREATE': {
        const msgs = { ...S.messages };
        const ch = msg.data.channelId;
        if (!msgs[ch]) msgs[ch] = [];
        msgs[ch] = [...msgs[ch], msg.data];
        set({ messages: msgs }); scrollBot();
        break;
      }
      case 'GUILD_CREATE': {
        const g = [...S.guilds];
        if (!g.find(x => x.id === msg.data.id)) g.push(msg.data);
        set({ guilds: g });
        break;
      }
      case 'PRESENCE_UPDATE': {
        const mem = { ...S.members };
        for (const gid of Object.keys(mem)) {
          mem[gid] = mem[gid].map(m => m.user.id === msg.data.userId ? { ...m, status: msg.data.status } : m);
        }
        const fr = S.friends.map(f => f.user.id === msg.data.userId ? { ...f, user: { ...f.user, status: msg.data.status } } : f);
        set({ members: mem, friends: fr });
        break;
      }
      case 'FRIEND_REQUEST': {
        set({ pendingFriends: [...S.pendingFriends, { id: msg.data.id, user: msg.data.from, status: 'pending', direction: 'incoming' }] });
        break;
      }
      case 'FRIEND_ACCEPTED': {
        const pf = S.pendingFriends.find(f => f.user.id === msg.data.user.id);
        if (pf) {
          set({
            pendingFriends: S.pendingFriends.filter(f => f.id !== pf.id),
            friends: [...S.friends, { ...pf, status: 'accepted', user: { ...pf.user, status: 'online' } }]
          });
        }
        break;
      }
      case 'FRIEND_REMOVED': {
        set({ friends: S.friends.filter(f => f.user.id !== msg.data.userId) });
        break;
      }
      case 'WEBRTC_SIGNAL': handleSignal(msg.data, msg.fromUserId); break;
      case 'CALL_REQUEST': {
        set({ incomingCall: { fromUser: msg.data.fromUser, callType: msg.data.callType, roomId: msg.data.roomId } });
        break;
      }
      case 'CALL_RESPONSE': {
        if (msg.data.accepted) startPeerConnection(msg.data.roomId, msg.fromUserId, true);
        else { endCallUI(); alert('Chamada recusada'); }
        break;
      }
      case 'CALL_END': endCallUI(); break;
    }
  };
  ws.onclose = () => { setTimeout(() => { if (S.loggedIn) connectWS(S.token); }, 3000); };
}

async function selectGuild(gid) {
  set({ activeGuildId: gid, activeChannelId: null, activeView: 'chat' });
  try {
    const [channels, members] = await Promise.all([
      api('GET', '/guilds/' + gid + '/channels'),
      api('GET', '/guilds/' + gid + '/members'),
    ]);
    const ch = { ...S.channels }; ch[gid] = channels;
    const mem = { ...S.members }; mem[gid] = members;
    set({ channels: ch, members: mem });
    const tch = channels.filter(c => c.type === 0);
    if (tch.length > 0) selectChannel(tch[0].id);
  } catch (e) { console.error(e); }
}

async function selectChannel(cid) {
  set({ activeChannelId: cid, activeView: 'chat' });
  try {
    if (!S.messages[cid]) {
      const msgs = await api('GET', '/channels/' + cid + '/messages?limit=50');
      const all = { ...S.messages }; all[cid] = msgs;
      set({ messages: all }); scrollBot();
    }
  } catch (e) { console.error(e); }
}

async function sendMsg(content) {
  if (!S.activeChannelId || !content.trim()) return;
  try { await api('POST', '/channels/' + S.activeChannelId + '/messages', { content: content.trim() }); }
  catch (e) { console.error(e); }
}

async function createGuild(name) {
  if (!name.trim()) return;
  try {
    const g = await api('POST', '/guilds', { name: name.trim() });
    set({ guilds: [...S.guilds, g] }); selectGuild(g.id);
  } catch (e) { console.error(e); }
}

async function addFriend(username) {
  if (!username.trim()) return;
  try {
    await api('POST', '/friends/request', { username: username.trim() });
    alert('Solicitação enviada!');
  } catch (e) { alert(e.message); }
}

async function acceptFriend(id) {
  try {
    await api('POST', '/friends/' + id + '/accept');
    const pf = S.pendingFriends.find(f => f.id === id);
    if (pf) set({
      pendingFriends: S.pendingFriends.filter(f => f.id !== id),
      friends: [...S.friends, { ...pf, status: 'accepted', user: { ...pf.user, status: 'online' } }]
    });
  } catch (e) { alert(e.message); }
}

async function removeFriend(id) {
  try {
    await api('DELETE', '/friends/' + id);
    set({ friends: S.friends.filter(f => f.id !== id) });
  } catch (e) { alert(e.message); }
}

// --- WebRTC ---
async function startCall(userId, type) {
  const partner = S.friends.find(f => f.user.id === userId);
  if (!partner) return;
  set({ callType: type, callPartner: partner, activeView: 'call' });
  try {
    const constraints = type === 'video' ? { audio: true, video: true } : { audio: true, video: false };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    set({ localStream: stream });
    const roomId = Math.random().toString(36).slice(2);
    S.ws.send(JSON.stringify({ type: 'CALL_REQUEST', targetUserId: userId, callType: type, roomId }));
    startPeerConnection(roomId, userId, false);
  } catch (e) { alert('Não foi possível acessar câmera/microfone: ' + e.message); endCallUI(); }
}

async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    set({ screenStream: stream });
    if (S.peerConn) {
      const videoTrack = stream.getVideoTracks()[0];
      const sender = S.peerConn.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
      else S.peerConn.addTrack(videoTrack, stream);
    }
    stream.getVideoTracks()[0].onended = () => stopScreenShare();
  } catch (e) { console.error(e); }
}

function stopScreenShare() {
  if (S.screenStream) { S.screenStream.getTracks().forEach(t => t.stop()); set({ screenStream: null }); }
}

function startPeerConnection(roomId, partnerId, isAnswerer) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  set({ peerConn: pc, call: { roomId, partnerId } });

  if (S.localStream) S.localStream.getTracks().forEach(t => pc.addTrack(t, S.localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) S.ws.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', targetUserId: partnerId, data: { type: 'ice', candidate: e.candidate, roomId } }));
  };

  pc.ontrack = (e) => {
    set({ remoteStream: e.streams[0] });
    const el = document.getElementById('remote-video');
    if (el) el.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') endCallUI();
  };

  if (isAnswerer) {
    // answerer waits for offer via handleSignal
  } else {
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
      S.ws.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', targetUserId: partnerId, data: { type: 'offer', sdp: pc.localDescription, roomId } }));
    });
  }
}

function handleSignal(data, fromUserId) {
  if (!S.peerConn) {
    if (data.type === 'offer') {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      set({ peerConn: pc, call: { roomId: data.roomId, partnerId: fromUserId } });
      if (S.localStream) S.localStream.getTracks().forEach(t => pc.addTrack(t, S.localStream));
      pc.onicecandidate = (e) => {
        if (e.candidate) S.ws.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', targetUserId: fromUserId, data: { type: 'ice', candidate: e.candidate, roomId: data.roomId } }));
      };
      pc.ontrack = (e) => {
        set({ remoteStream: e.streams[0] });
        const el = document.getElementById('remote-video');
        if (el) el.srcObject = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') endCallUI();
      };
      pc.setRemoteDescription(data.sdp).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => {
        S.ws.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', targetUserId: fromUserId, data: { type: 'answer', sdp: pc.localDescription, roomId: data.roomId } }));
      });
    }
    return;
  }
  if (data.type === 'offer') S.peerConn.setRemoteDescription(data.sdp).then(() => S.peerConn.createAnswer()).then(a => S.peerConn.setLocalDescription(a)).then(() => {
    S.ws.send(JSON.stringify({ type: 'WEBRTC_SIGNAL', targetUserId: fromUserId, data: { type: 'answer', sdp: S.peerConn.localDescription, roomId: data.roomId } }));
  });
  else if (data.type === 'answer') S.peerConn.setRemoteDescription(data.sdp);
  else if (data.type === 'ice') S.peerConn.addIceCandidate(data.candidate).catch(() => {});
}

function acceptIncomingCall() {
  const ic = S.incomingCall;
  if (!ic) return;
  set({ callType: ic.callType, callPartner: { user: ic.fromUser }, activeView: 'call', incomingCall: null });
  const constraints = ic.callType === 'video' ? { audio: true, video: true } : { audio: true, video: false };
  navigator.mediaDevices.getUserMedia(constraints).then(stream => {
    set({ localStream: stream });
    S.ws.send(JSON.stringify({ type: 'CALL_RESPONSE', targetUserId: ic.fromUser.id, accepted: true, roomId: ic.roomId }));
    startPeerConnection(ic.roomId, ic.fromUser.id, true);
  }).catch(e => { alert('Erro: ' + e.message); endCallUI(); });
}

function declineIncomingCall() {
  const ic = S.incomingCall;
  if (ic) S.ws.send(JSON.stringify({ type: 'CALL_RESPONSE', targetUserId: ic.fromUser.id, accepted: false, roomId: ic.roomId }));
  set({ incomingCall: null });
}

function endCall() {
  if (S.call) S.ws.send(JSON.stringify({ type: 'CALL_END', targetUserId: S.call.partnerId }));
  endCallUI();
}

function endCallUI() {
  if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());
  if (S.screenStream) S.screenStream.getTracks().forEach(t => t.stop());
  if (S.peerConn) S.peerConn.close();
  set({ localStream: null, remoteStream: null, peerConn: null, call: null, callType: null, callPartner: null, screenStream: null, activeView: 'chat' });
}

function logout() {
  if (S.ws) S.ws.close();
  localStorage.removeItem('dc_token');
  set({ token: '', user: null, guilds: [], channels: {}, messages: {}, members: {}, friends: [], pendingFriends: [], activeGuildId: null, activeChannelId: null, ws: null, loggedIn: false, error: '', authMode: 'login', activeView: 'chat' });
}

function scrollBot() { requestAnimationFrame(() => { const el = document.getElementById('chat-messages'); if (el) el.scrollTop = el.scrollHeight; }); }
function ini(n) { return (n || '?').split(/[\s#]/).map(w => w[0]).join('').toUpperCase().slice(0, 2); }
function fmtT(ts) { if (!ts) return ''; const d = new Date(ts), n = new Date(); return d.toDateString() === n.toDateString() ? 'Hoje às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function sCol(s) { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); const c = ['#5865f2','#57f287','#fee75c','#eb459e','#ed4245','#f47b67','#e67e22','#1abc9c','#2ecc71','#3498db','#9b59b6']; return c[Math.abs(h) % c.length]; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function render() {
  const root = document.getElementById('root');
  if (!root) return;
  if (!S.loggedIn) { root.innerHTML = renderAuth(); bindAuth(); return; }
  root.innerHTML = renderApp();
  bindApp();
  if (S.localStream) { const el = document.getElementById('local-video'); if (el) el.srcObject = S.localStream; }
  if (S.remoteStream) { const el = document.getElementById('remote-video'); if (el) el.srcObject = S.remoteStream; }
}

function renderAuth() {
  const il = S.authMode === 'login';
  return `<div class="auth-screen"><div class="auth-box">
<h2>${il ? 'Bem-vindo de volta!' : 'Criar conta'}</h2>
<p>${il ? 'Entre com seu email e senha.' : 'Preencha os dados para criar sua conta.'}</p>
${!il ? '<div class="form-group"><label class="form-label">Nome de usuário</label><input class="form-input" id="inp-user" placeholder="Seu nome..." /></div>' : ''}
<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="inp-email" type="email" placeholder="seu@email.com" /></div>
<div class="form-group"><label class="form-label">Senha</label><input class="form-input" id="inp-pass" type="password" placeholder="Mínimo 6 caracteres" /></div>
${S.error ? '<div class="auth-error">' + esc(S.error) + '</div>' : ''}
<button class="btn-primary" id="btn-auth" ${S.loading ? 'disabled' : ''}>${S.loading ? 'Carregando...' : (il ? 'Entrar' : 'Criar conta')}</button>
<div class="auth-switch">${il ? 'Não tem conta? <a id="lnk-reg">Cadastre-se</a>' : 'Já tem conta? <a id="lnk-log">Faça login</a>'}</div>
${il ? '<p style="margin-top:16px;font-size:12px;color:#72767d;text-align:center;">Conta padrão: <b>admin@discord.clone</b> / <b>admin123</b></p>' : ''}
</div></div>`;
}

function renderApp() {
  const ag = S.guilds.find(g => g.id === S.activeGuildId);
  const gch = S.channels[S.activeGuildId] || [];
  const tch = gch.filter(c => c.type === 0), vch = gch.filter(c => c.type === 2);
  const ach = gch.find(c => c.id === S.activeChannelId);
  const msgs = S.messages[S.activeChannelId] || [];
  const gm = S.members[S.activeGuildId] || [];
  const onl = gm.filter(m => m.status !== 'offline'), off = gm.filter(m => m.status === 'offline');
  const isCall = S.activeView === 'call';
  const isFriends = S.activeView === 'friends';

  return `<div class="titlebar"><span class="titlebar-logo">DC</span><span class="titlebar-title">Discord Clone</span></div>
<div class="app-container">
<div class="server-list">
<div class="server-icon home ${S.activeView === 'friends' ? 'active' : ''}" id="btn-friends" title="Amigos">
<span class="server-pill"></span>
<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
</div>
<div class="server-separator"></div>
${S.guilds.map(g => `<div class="server-icon ${g.id === S.activeGuildId ? 'active' : ''}" data-guild="${g.id}" title="${esc(g.name)}" style="background:${g.id === S.activeGuildId ? '#5865f2' : sCol(g.name)}"><span class="server-pill"></span>${esc(ini(g.name))}</div>`).join('')}
<div class="server-icon server-add" id="btn-add-guild" title="Criar servidor">+</div>
</div>

${isFriends ? renderFriendsView() : isCall ? renderCallView() : renderChatView(ag, tch, vch, ach, msgs, gm, onl, off)}

<div class="user-panel-wrap">
<div class="user-panel">
<div class="user-avatar" style="background:${sCol(S.user?.username || 'U')}">${ini(S.user?.username || 'U')}</div>
<div class="user-info"><div class="user-name">${esc(S.user?.username || '')}</div><div class="user-status">Online</div></div>
<div class="user-controls"><button class="user-ctrl-btn" id="btn-logout" title="Sair" style="color:#ed4245;">&#x23FB;</button></div>
</div>
</div>
</div>

${S.incomingCall ? `<div class="incoming-call-overlay">
<div class="incoming-call-box">
<div class="inc-avatar" style="background:${sCol(S.incomingCall.fromUser.username)}">${ini(S.incomingCall.fromUser.username)}</div>
<h3>${esc(S.incomingCall.fromUser.username)}</h3>
<p>${S.incomingCall.callType === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'}</p>
<div class="inc-buttons">
<button class="inc-decline" id="btn-decline">&#x2715;</button>
<button class="inc-accept" id="btn-accept">&#x2713;</button>
</div>
</div>
</div>` : ''}`;
}

function renderFriendsView() {
  return `<div class="channel-sidebar">
<div class="server-header"><span>Amigos</span></div>
<div class="channel-list">
<div class="channel-item ${S.activeView === 'friends' ? 'active' : ''}" id="btn-friends-all" style="gap:8px;">
<span style="font-size:18px;">&#x1F465;</span><span>Todos</span>
${S.pendingFriends.length ? '<span style="background:#ed4245;color:#fff;border-radius:8px;padding:1px 6px;font-size:11px;margin-left:auto;">' + S.pendingFriends.length + '</span>' : ''}
</div>
<div class="channel-item" id="btn-add-friend" style="gap:8px;color:#3ba55c;">
<span style="font-size:18px;">+</span><span>Adicionar Amigo</span>
</div>
</div>
</div>
<div class="chat-area">
<div class="chat-header"><span style="font-size:18px;margin-right:8px;">&#x1F465;</span><span>Amigos</span></div>
<div class="chat-messages" style="padding:16px;">
${S.pendingFriends.length ? '<div class="friend-section"><div class="friend-section-title">Solicitações Pendentes — ' + S.pendingFriends.length + '</div>' + S.pendingFriends.map(f => `<div class="friend-row">
<div class="friend-avatar" style="background:${sCol(f.user.username)}">${ini(f.user.username)}</div>
<div class="friend-info"><div class="friend-name">${esc(f.user.username)}</div><div class="friend-status">Solicitação recebida</div></div>
<button class="friend-accept" data-accept="${f.id}">&#x2713;</button>
<button class="friend-decline" data-decline="${f.id}">&#x2715;</button>
</div>`).join('') + '</div>' : ''}
<div class="friend-section"><div class="friend-section-title">Todos os Amigos — ${S.friends.length}</div>
${S.friends.length === 0 ? '<div style="color:#72767d;padding:16px;text-align:center;">Nenhum amigo ainda. Adicione alguém!</div>' : S.friends.map(f => `<div class="friend-row">
<div class="friend-avatar" style="background:${sCol(f.user.username)}">${ini(f.user.username)}<span class="status-dot status-${f.user.status || 'offline'}"></span></div>
<div class="friend-info"><div class="friend-name">${esc(f.user.username)}</div><div class="friend-status">${f.user.status === 'online' ? 'Online' : 'Offline'}</div></div>
<button class="friend-call-voice" data-call-voice="${f.user.id}" title="Chamada de voz">&#x1F4DE;</button>
<button class="friend-call-video" data-call-video="${f.user.id}" title="Chamada de vídeo">&#x1F4F9;</button>
<button class="friend-remove" data-remove="${f.id}" title="Remover">&#x2715;</button>
</div>`).join('')}
</div>
</div>
</div>`;
}

function renderCallView() {
  const partner = S.callPartner;
  const pName = partner?.user?.username || partner?.username || '...';
  return `<div class="chat-area call-view">
<div class="chat-header"><span>&#x1F4DE;</span><span>Chamada com ${esc(pName)}</span>
<div style="margin-left:auto;display:flex;gap:8px;">
<button class="call-btn" id="btn-screen" title="Compartilhar tela">&#x1F5A5;</button>
<button class="call-btn danger" id="btn-end-call" title="Encerrar">&#x2715;</button>
</div></div>
<div class="call-container">
<div class="call-video-wrap main">
<video id="remote-video" autoplay playsinline class="call-video"></video>
<div class="call-placeholder" style="background:${sCol(pName)}">${ini(pName)}</div>
</div>
<div class="call-video-wrap pip">
<video id="local-video" autoplay playsinline muted class="call-video-local"></video>
</div>
<div class="call-controls">
<button class="call-ctrl" id="btn-mute" title="Silenciar">&#x1F3A4;</button>
<button class="call-ctrl" id="btn-screen2" title="Compartilhar tela">&#x1F5A5;</button>
<button class="call-ctrl danger" id="btn-end-call2" title="Encerrar chamada">&#x2715;</button>
</div>
</div>
</div>`;
}

function renderChatView(ag, tch, vch, ach, msgs, gm, onl, off) {
  return `<div class="channel-sidebar">
<div class="server-header"><span>${ag ? esc(ag.name) : 'Selecione um servidor'}</span><span style="font-size:12px;color:#b9bbbe;">&#x25BC;</span></div>
<div class="channel-list">
${tch.length ? '<div class="channel-category">&#x25BC; Canais de Texto</div>' + tch.map(c => `<div class="channel-item ${c.id === S.activeChannelId ? 'active' : ''}" data-channel="${c.id}"><span class="channel-hash">#</span><span>${esc(c.name)}</span></div>`).join('') : ''}
${vch.length ? '<div class="channel-category">&#x25BC; Canais de Voz</div>' + vch.map(c => `<div class="channel-item" style="opacity:.6;"><span style="font-size:16px;">&#x1F50A;</span><span>${esc(c.name)}</span></div>`).join('') : ''}
${!ag ? '<div style="padding:16px;color:#72767d;font-size:14px;text-align:center;">Selecione um servidor</div>' : ''}
</div>
</div>
<div class="chat-area">
<div class="chat-header">${ach ? '<span class="channel-hash" style="font-size:20px;color:#8e9297;">#</span><span>' + esc(ach.name) + '</span>' : '<span style="color:#8e9297;">Selecione um canal</span>'}</div>
<div class="chat-messages" id="chat-messages">
${ach ? (msgs.length ? msgs.map(renderMsg).join('') : '<div style="padding:40px;text-align:center;color:#72767d;">Nenhuma mensagem ainda. Seja o primeiro!</div>') : '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#72767d;font-size:16px;">Selecione um canal para conversar</div>'}
</div>
${ach ? '<div class="chat-input-wrapper"><textarea class="chat-input" id="msg-input" rows="1" placeholder="Enviar mensagem em #' + esc(ach.name) + '" maxlength="2000"></textarea></div>' : ''}
</div>
<div class="member-list">
${gm.length ? ('<div class="member-category">Online — ' + onl.length + '</div>' + onl.map(renderMem).join('') + (off.length ? '<div class="member-category">Offline — ' + off.length + '</div>' + off.map(renderMem).join('') : '')) : (ag ? '<div style="padding:16px;color:#72767d;font-size:13px;text-align:center;">Carregando...</div>' : '')}
</div>`;
}

function renderMsg(m) {
  const n = m.author?.username || 'Unknown', c = sCol(n);
  return `<div class="message-group"><div class="msg-avatar" style="background:${c}">${ini(n)}</div>
<div class="msg-content"><div class="msg-header"><span class="msg-author" style="color:${c}">${esc(n)}</span><span class="msg-time">${fmtT(m.timestamp)}</span></div>
<div class="msg-text">${esc(m.content || '')}</div></div></div>`;
}

function renderMem(m) {
  if (!m.user) return '';
  const c = sCol(m.user.username), st = m.status || 'offline';
  return `<div class="member-item"><div class="member-avatar" style="background:${c}">${ini(m.user.username)}<span class="status-dot status-${st}"></span></div>
<span class="member-name">${esc(m.nick || m.user.username)}</span></div>`;
}

function bindAuth() {
  const btn = document.getElementById('btn-auth'), em = document.getElementById('inp-email'), pw = document.getElementById('inp-pass'), us = document.getElementById('inp-user');
  if (btn) btn.onclick = () => S.authMode === 'login' ? doLogin(em.value, pw.value) : doRegister(us.value, em.value, pw.value);
  if (pw) pw.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
  document.getElementById('lnk-reg')?.addEventListener('click', () => set({ authMode: 'register', error: '' }));
  document.getElementById('lnk-log')?.addEventListener('click', () => set({ authMode: 'login', error: '' }));
}

function bindApp() {
  document.getElementById('btn-logout')?.addEventListener('click', logout);
  document.getElementById('btn-friends')?.addEventListener('click', () => set({ activeView: 'friends' }));
  document.getElementById('btn-add-guild')?.addEventListener('click', () => { const n = prompt('Nome do novo servidor:'); if (n) createGuild(n); });
  document.getElementById('btn-add-friend')?.addEventListener('click', () => { const n = prompt('Nome de usuário do amigo:'); if (n) addFriend(n); });
  document.getElementById('btn-end-call')?.addEventListener('click', endCall);
  document.getElementById('btn-end-call2')?.addEventListener('click', endCall);
  document.getElementById('btn-screen')?.addEventListener('click', startScreenShare);
  document.getElementById('btn-screen2')?.addEventListener('click', startScreenShare);
  document.getElementById('btn-accept')?.addEventListener('click', acceptIncomingCall);
  document.getElementById('btn-decline')?.addEventListener('click', declineIncomingCall);

  document.querySelectorAll('[data-guild]').forEach(el => el.addEventListener('click', () => selectGuild(el.dataset.guild)));
  document.querySelectorAll('[data-channel]').forEach(el => el.addEventListener('click', () => selectChannel(el.dataset.channel)));
  document.querySelectorAll('[data-accept]').forEach(el => el.addEventListener('click', () => acceptFriend(el.dataset.accept)));
  document.querySelectorAll('[data-decline]').forEach(el => el.addEventListener('click', async () => { await api('DELETE', '/friends/' + el.dataset.decline); set({ pendingFriends: S.pendingFriends.filter(f => f.id !== el.dataset.decline) }); }));
  document.querySelectorAll('[data-remove]').forEach(el => el.addEventListener('click', () => removeFriend(el.dataset.remove)));
  document.querySelectorAll('[data-call-voice]').forEach(el => el.addEventListener('click', () => startCall(el.dataset.callVoice, 'voice')));
  document.querySelectorAll('[data-call-video]').forEach(el => el.addEventListener('click', () => startCall(el.dataset.callVideo, 'video')));

  const inp = document.getElementById('msg-input');
  if (inp) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(inp.value); inp.value = ''; inp.style.height = 'auto'; } });
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 200) + 'px'; });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (S.token) {
    (async () => {
      try {
        const user = await api('GET', '/users/@me');
        set({ user, loggedIn: true });
        connectWS(S.token); loadAll();
      } catch { localStorage.removeItem('dc_token'); set({ token: '' }); }
    })();
  } else render();
});