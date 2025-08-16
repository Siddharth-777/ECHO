// client/public/main.js
// ECHO client logic (WebRTC mesh + signaling + polished UI + chat toggle + active-speaker highlight)

// ----- Config -----
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
  // Add TURN entry if you deploy a TURN server
];

// ----- State -----
let ws = null;
let roomId = null;
let name = null;
let clientId = null;

let localStream = null;
let screenStream = null;

// WebRTC maps
const pcs = new Map();        // peerId -> RTCPeerConnection
const remoteStreams = new Map(); // peerId -> MediaStream

// Audio analyzers for active-speaker detection
const analyzers = new Map(); // peerId -> { audioContext, source, analyser, interval }

// ----- UI refs -----
const els = {
  roomId: document.getElementById('roomId'),
  name: document.getElementById('name'),
  joinBtn: document.getElementById('joinBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  peersGrid: document.getElementById('peersGrid'),
  status: document.getElementById('status'),
  chatLog: document.getElementById('chatLog'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  countTag: document.getElementById('countTag'),
  micBtn: document.getElementById('micBtn'),
  camBtn: document.getElementById('camBtn'),
  screenBtn: document.getElementById('screenBtn'),
  leaveFab: document.getElementById('leaveFab'),
  copyInviteBtn: document.getElementById('copyInviteBtn'),
  toggleChatBtn: document.getElementById('toggleChatBtn'),
  chatPanel: document.getElementById('chatPanel')
};

// prefill if path /r/:roomId
const m = location.pathname.match(/^\/r\/([^/]+)$/);
if (m) els.roomId.value = decodeURIComponent(m[1]);

// ----- events -----
els.joinBtn.onclick = joinRoom;
els.leaveBtn.onclick = leaveRoom;
els.chatForm.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
els.micBtn.onclick = toggleMic;
els.camBtn.onclick = toggleCam;
els.screenBtn.onclick = toggleScreen;
els.leaveFab.onclick = () => leaveRoom();
els.copyInviteBtn.onclick = copyInvite;
els.toggleChatBtn.onclick = toggleChatPanel;

// ----- helpers -----
function setStatus(t) { els.status.textContent = t; }
function setParticipantCount(n) { els.countTag.textContent = `${n} participants`; }

// Chat append
function appendChat(nameText, text, ts) {
  const wrap = document.createElement('div');
  wrap.style.margin = '6px 0';
  const who = document.createElement('div');
  who.style.fontWeight = '600';
  who.textContent = nameText + ' ';
  const timeEl = document.createElement('span');
  timeEl.style.fontWeight = '400';
  timeEl.style.fontSize = '12px';
  timeEl.style.color = 'var(--muted)';
  timeEl.textContent = new Date(ts || Date.now()).toLocaleTimeString();
  who.appendChild(timeEl);
  const msg = document.createElement('div');
  msg.textContent = text;
  msg.style.marginTop = '4px';
  wrap.appendChild(who);
  wrap.appendChild(msg);
  els.chatLog.appendChild(wrap);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

// Invite copy: /r/roomId link
function copyInvite() {
  if (!roomId) {
    alert('Join a room first to copy invite link.');
    return;
  }
  const url = new URL(location.href);
  url.pathname = `/r/${encodeURIComponent(roomId)}`;
  navigator.clipboard.writeText(url.toString()).then(() => {
    setStatus('Invite link copied to clipboard');
    setTimeout(() => setStatus(`In room ${roomId}`), 1800);
  }).catch(() => {
    alert('Copy failed — copy the URL manually.');
  });
}

// Chat panel toggle
let chatVisible = true;
function toggleChatPanel() {
  chatVisible = !chatVisible;
  if (chatVisible) {
    els.chatPanel.classList.remove('hidden');
    els.toggleChatBtn.textContent = 'Hide chat';
  } else {
    els.chatPanel.classList.add('hidden');
    els.toggleChatBtn.textContent = 'Show chat';
  }
}

// ----- media -----
async function getLocalMedia() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } }
    });
    ensureTile('local', `${name || 'You'} (local)`, true);
    const v = document.getElementById('video-local');
    if (v) v.srcObject = localStream;
    updateControlButtons();
    startLocalAnalyzer(); // detect local active speaker
  } catch (e) {
    alert('Camera/Microphone permission required.');
    throw e;
  }
  return localStream;
}

function updateControlButtons() {
  const micOn = localStream && localStream.getAudioTracks().some(t => t.enabled);
  const camOn = localStream && localStream.getVideoTracks().some(t => t.enabled);
  els.micBtn.textContent = micOn ? 'Mic: On' : 'Mic: Off';
  els.camBtn.textContent = camOn ? 'Camera: On' : 'Camera: Off';
}

// mic toggle
function toggleMic() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
  updateControlButtons();
}

// cam toggle
function toggleCam() {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
  updateControlButtons();
}

// screen share toggle
async function toggleScreen() {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      // add screen tracks to all peers
      for (const pc of pcs.values()) {
        screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
      }
      // when user stops share
      const sTrack = screenStream.getVideoTracks()[0];
      sTrack.onended = () => stopScreen();
      els.screenBtn.textContent = 'Stop screen';
    } catch (e) {
      console.warn('Screen share cancelled', e);
    }
  } else {
    stopScreen();
  }
}
function stopScreen() {
  if (!screenStream) return;
  for (const pc of pcs.values()) {
    const senders = pc.getSenders();
    for (const s of senders) {
      if (!s.track) continue;
      if (screenStream.getTracks().includes(s.track)) {
        try { pc.removeTrack(s); } catch {}
      }
    }
  }
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  els.screenBtn.textContent = 'Screen';
}

// ----- video tile helpers -----
function ensureTile(peerId, displayName, isLocal = false) {
  let tile = document.getElementById(`tile-${peerId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${peerId}`;

    const vid = document.createElement('video');
    vid.id = `video-${peerId}`;
    vid.autoplay = true;
    vid.playsInline = true;
    if (isLocal) vid.muted = true;
    tile.appendChild(vid);

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = displayName || (isLocal ? 'You' : 'Participant');
    label.id = `label-${peerId}`;
    tile.appendChild(label);

    els.peersGrid.appendChild(tile);
  } else {
    const label = tile.querySelector('.label') || document.getElementById(`label-${peerId}`);
    if (label) label.textContent = displayName || label.textContent;
  }
  updateParticipantCount();
  return tile;
}

function removeTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
  updateParticipantCount();
}

// ----- active-speaker detection (WebAudio) -----
function startAnalyserForStream(peerId, stream) {
  // avoid duplicate
  if (analyzers.has(peerId)) return;
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const data = new Float32Array(analyser.fftSize);
    let lastSpeak = 0;
    const interval = setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      // compute RMS
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      // threshold tuned empirically
      const speaking = rms > 0.02;
      const tile = document.getElementById(`tile-${peerId}`);
      if (tile) {
        if (speaking) {
          tile.classList.add('speaking');
          lastSpeak = Date.now();
        } else {
          // keep highlight a short time to avoid flicker
          if (Date.now() - lastSpeak > 400) tile.classList.remove('speaking');
        }
      }
    }, 120);

    analyzers.set(peerId, { audioContext, source, analyser, interval });
  } catch (e) {
    // some browsers restrict AudioContext creation; ignore if fails
    console.warn('Analyser failed for', peerId, e);
  }
}

function stopAnalyser(peerId) {
  const meta = analyzers.get(peerId);
  if (!meta) return;
  clearInterval(meta.interval);
  try { meta.audioContext.close(); } catch {}
  analyzers.delete(peerId);
}

// local analyzer
function startLocalAnalyzer() {
  if (!localStream) return;
  startAnalyserForStream('local', localStream);
}

// ----- WebRTC helpers -----
function makePeerConnection(peerId, peerName) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pcs.set(peerId, pc);

  // add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
  }

  // remote stream collect
  const remote = new MediaStream();
  remoteStreams.set(peerId, remote);
  pc.ontrack = (ev) => {
    // Some browsers provide ev.streams
    if (ev.streams && ev.streams[0]) {
      ev.streams[0].getTracks().forEach(t => {
        if (!remote.getTracks().find(x => x.id === t.id)) remote.addTrack(t);
      });
    } else {
      if (ev.track) remote.addTrack(ev.track);
    }
    ensureTile(peerId, peerName);
    const v = document.getElementById(`video-${peerId}`);
    if (v) v.srcObject = remote;

    // start analyser on audio tracks (for active speaker)
    const audioTracks = remote.getAudioTracks();
    if (audioTracks.length > 0) {
      // create a short-lived MediaStream for analyser
      const audioOnlyStream = new MediaStream(audioTracks);
      startAnalyserForStream(peerId, audioOnlyStream);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ice-candidate', to: peerId, candidate: e.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

async function startPeerConnection(peerId, isInitiator, peerName) {
  if (peerId === clientId) return;
  if (pcs.has(peerId)) return;
  const pc = makePeerConnection(peerId, peerName);
  if (isInitiator) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription }));
    } catch (e) {
      console.error('createOffer failed', e);
    }
  }
}

async function handleOffer(fromId, sdp) {
  if (!pcs.has(fromId)) makePeerConnection(fromId, 'Participant');
  const pc = pcs.get(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', to: fromId, sdp: pc.localDescription }));
}

async function handleAnswer(fromId, sdp) {
  const pc = pcs.get(fromId);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleRemoteCandidate(fromId, candidate) {
  const pc = pcs.get(fromId);
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn('addIceCandidate failed', e);
  }
}

function removePeer(peerId) {
  const pc = pcs.get(peerId);
  if (pc) {
    try { pc.close(); } catch {}
    pcs.delete(peerId);
  }
  remoteStreams.delete(peerId);
  stopAnalyser(peerId);
  removeTile(peerId);
  updateParticipantCount();
}

// ----- signaling (WebSocket) -----
async function joinRoom() {
  roomId = els.roomId.value.trim();
  name = els.name.value.trim() || 'Guest';
  if (!roomId) { alert('Please enter Room ID'); return; }

  await getLocalMedia();

  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId, name }));
    setStatus('Connecting...');
    els.joinBtn.disabled = true;
    els.leaveBtn.disabled = false;
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'room-full':
        alert(`Room full (limit: ${msg.limit})`);
        ws.close();
        break;

      case 'joined':
        clientId = msg.clientId;
        setStatus(`In room ${msg.roomId} as ${msg.name}`);
        ensureTile('local', `${name} (you)`, true);
        // Create initiator connections to existing peers
        (msg.peers || []).forEach(p => startPeerConnection(p.id, true, p.name || 'Participant'));
        updateParticipantCount();
        break;

      case 'peer-joined':
        startPeerConnection(msg.peer.id, true, msg.peer.name);
        break;

      case 'peer-left':
        removePeer(msg.id);
        break;

      case 'offer':
        handleOffer(msg.from, msg.sdp);
        break;

      case 'answer':
        handleAnswer(msg.from, msg.sdp);
        break;

      case 'ice-candidate':
        handleRemoteCandidate(msg.from, msg.candidate);
        break;

      case 'chat':
        // server excludes sender - only others reach here
        appendChat(msg.from.name || 'Participant', msg.text, msg.ts);
        break;

      default:
        console.warn('Unknown message type', msg.type);
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected');
    cleanupAll();
    els.joinBtn.disabled = false;
    els.leaveBtn.disabled = true;
  };

  ws.onerror = (e) => {
    console.warn('WS error', e);
  };
}

function leaveRoom() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'leave' }));
  if (ws) ws.close();
  cleanupAll();
}

function cleanupAll() {
  stopScreen();
  for (const pc of pcs.values()) {
    try { pc.close(); } catch {}
  }
  pcs.clear();
  remoteStreams.clear();
  for (const [peerId] of analyzers) stopAnalyser(peerId);
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  // remove tiles
  const tiles = Array.from(document.querySelectorAll('.tile'));
  tiles.forEach(t => t.remove());
  setParticipantCount(0);
}

 
function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  appendChat('You', text, Date.now()); 
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'chat', text }));
  }
  els.chatInput.value = '';
}

// ----- participant count UI -----
function updateParticipantCount() {
  const total = document.querySelectorAll('.tile').length;
  setParticipantCount(total);
}

// ----- window unload -----
window.addEventListener('beforeunload', () => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'leave' })); } catch {}
});

// ----- end -----
