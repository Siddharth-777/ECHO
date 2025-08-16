// ---- config ----
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
  // For NAT-restricted networks you need a TURN server here.
];

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// ---- state ----
const displayName = localStorage.getItem("echoName") || "Guest";
const roomId = localStorage.getItem("echoRoom") || "demo";

const peers = new Map(); // peerId -> { pc, remoteStream }
let ws = null;
let localStream = null;
let screenStream = null;

// ---- elements ----
const grid = document.getElementById("video-grid");
const chatPanel = document.getElementById("chatPanel");
const chatBox = document.getElementById("chatBox");
const chatInput = document.getElementById("chatInput");

// ---- media ----
async function getLocalMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 360 } },
    audio: true
  });
  addVideo("me", displayName, localStream, true);
  return localStream;
}
const mediaReady = getLocalMedia();

// ---- websocket ----
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", roomId, name: displayName }));
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "joined":
        // We are the newcomer → initiate offers to existing peers
        for (const p of msg.peers || []) {
          await createPeerConnection(p.id, p.name, true);
        }
        break;

      case "peer-joined":
        // Someone new joined → we wait for their offer
        await createPeerConnection(msg.peer.id, msg.peer.name, false);
        break;

      case "offer":
        await handleOffer(msg.from, msg.sdp, msg.name);
        break;

      case "answer":
        await handleAnswer(msg.from, msg.sdp);
        break;

      case "ice-candidate":
        await handleCandidate(msg.from, msg.candidate);
        break;

      case "chat":
        appendChat(msg.name || "Participant", msg.text);
        break;

      case "peer-left":
        removePeer(msg.id);
        break;
    }
  };

  ws.onclose = () => {
    // cleanup on disconnect
    for (const [id] of peers) removePeer(id);
  };
}
connectWS();

// ---- rtc helpers ----
async function createPeerConnection(peerId, peerName, initiator) {
  if (peers.has(peerId)) return peers.get(peerId).pc;

  await mediaReady;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // add our tracks
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  if (screenStream) screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));

  // remote stream handling
  const remoteStream = new MediaStream();
  peers.set(peerId, { pc, remoteStream, name: peerName });

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach((trk) => {
      if (!remoteStream.getTracks().find((t) => t.id === trk.id)) {
        remoteStream.addTrack(trk);
      }
    });
    addVideo(peerId, peerName || "Peer", remoteStream, false);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "ice-candidate", to: peerId, candidate: ev.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log("Peer", peerId, "state:", pc.connectionState);
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  if (initiator) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", to: peerId, sdp: pc.localDescription }));
  }

  return pc;
}

async function handleOffer(fromId, sdp, peerName) {
  if (!peers.has(fromId)) await createPeerConnection(fromId, peerName, false);
  const { pc } = peers.get(fromId);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: "answer", to: fromId, sdp: pc.localDescription }));
}

async function handleAnswer(fromId, sdp) {
  const meta = peers.get(fromId);
  if (!meta) return;
  await meta.pc.setRemoteDescription(sdp);
}

async function handleCandidate(fromId, candidate) {
  const meta = peers.get(fromId);
  if (!meta || !candidate) return;
  try {
    await meta.pc.addIceCandidate(candidate);
  } catch (e) {
    console.warn("addIceCandidate failed", e);
  }
}

function removePeer(peerId) {
  const meta = peers.get(peerId);
  if (!meta) return;
  try { meta.pc.close(); } catch {}
  peers.delete(peerId);
  const el = document.getElementById("container-" + peerId);
  if (el) el.remove();
}

// ---- UI helpers ----
function addVideo(id, label, stream, isLocal) {
  if (document.getElementById("container-" + id)) return;

  const wrap = document.createElement("div");
  wrap.className = "video-container";
  wrap.id = "container-" + id;

  const v = document.createElement("video");
  v.autoplay = true;
  v.playsInline = true;
  if (isLocal) v.muted = true;
  v.srcObject = stream;

  const name = document.createElement("div");
  name.className = "name-label";
  name.textContent = label;

  wrap.appendChild(v);
  wrap.appendChild(name);
  grid.appendChild(wrap);

  // simple active speaker highlight
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const vol = buf.reduce((a, b) => a + b, 0) / buf.length;
      wrap.classList.toggle("active", vol > 40);
      requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}

function appendChat(sender, text) {
  const div = document.createElement("div");
  div.textContent = `${sender}: ${text}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ---- controls ----
document.getElementById("chatToggleBtn").onclick = () => {
  chatPanel.classList.toggle("active");
};

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const text = chatInput.value.trim();
    if (!text) return;
    // server rebroadcasts to all (including us)
    ws?.send(JSON.stringify({ type: "chat", text }));
    chatInput.value = "";
  }
});

document.getElementById("micBtn").onclick = () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
};

document.getElementById("camBtn").onclick = () => {
  if (!localStream) return;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
};

document.getElementById("inviteBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    alert("Invite link copied!");
  } catch {
    alert("Copy failed. Copy the URL manually.");
  }
};

document.getElementById("leaveBtn").onclick = () => {
  location.href = "/";
};

// optional screen share
document.getElementById("screenBtn").onclick = async () => {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      // add screen tracks to all current PCs
      for (const { pc } of peers.values()) {
        screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
      }
      const track = screenStream.getVideoTracks()[0];
      track.onended = () => {
        stopScreen();
      };
    } catch (e) {
      console.warn("Screen share cancelled", e);
    }
  } else {
    stopScreen();
  }
};

function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
}
