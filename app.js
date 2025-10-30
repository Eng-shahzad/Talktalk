// app.js — TalkTalk client (mobile-first), simulated OTP, profile upload, WS, messages, mic-only voice notes, camera snaps, emoji dropdown, search/add, WebRTC calls

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

let ws = null;
let me = JSON.parse(localStorage.getItem('me') || 'null');
let contacts = JSON.parse(localStorage.getItem('contacts') || '[]');
let currentChat = null;
let mediaRecorder = null, recordedChunks = [];
let pc = null;
const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM
const searchInput = document.getElementById('searchInput');
const addPeopleBtn = document.getElementById('addPeopleBtn');
const myAvatarPreview = document.getElementById('myAvatarPreview');
const myName = document.getElementById('myName');
const myMobile = document.getElementById('myMobile');
const contactsList = document.getElementById('contactsList');
const addMobileInput = document.getElementById('addMobileInput');
const addContactBtn = document.getElementById('addContactBtn');

const messagesEl = document.getElementById('messages');
const chatAvatar = document.getElementById('chatAvatar');
const chatName = document.getElementById('chatName');
const chatMobileView = document.getElementById('chatMobileView');

const emojiMain = document.getElementById('emojiMain');
const emojiDropdown = document.getElementById('emojiDropdown');
const cameraBtn = document.getElementById('cameraBtn');
const messageInput = document.getElementById('messageInput');
const recordBtn = document.getElementById('recordBtn');
const sendBtn = document.getElementById('sendBtn');

const callBtn = document.getElementById('callBtn'), hangupBtn = document.getElementById('hangupBtn');
const remoteAudio = document.getElementById('remoteAudio');

const modal = document.getElementById('modal');
const nameInput = document.getElementById('nameInput');
const mobileInput = document.getElementById('mobileInput');
const requestOtpBtn = document.getElementById('requestOtpBtn');
const verifyOtpBtn = document.getElementById('verifyOtpBtn');
const otpInput = document.getElementById('otpInput');
const avatarFile = document.getElementById('avatarFile');
const avatarPreviewSmall = document.getElementById('avatarPreviewSmall');
const closeModal = document.getElementById('closeModal');

// helpers
function saveLocal(){ localStorage.setItem('me', JSON.stringify(me)); localStorage.setItem('contacts', JSON.stringify(contacts)); }
function el(html){ const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
function blobToDataURL(blob){ return new Promise((res, rej)=>{ const r = new FileReader(); r.onload = ()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); }); }
function fileToDataURL(file){ return new Promise((res, rej)=>{ const r = new FileReader(); r.onload = ()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); }

// UI render contacts
function renderContacts(filter=''){
  contactsList.innerHTML = '';
  const list = contacts.filter(c => c.name?.toLowerCase().includes(filter.toLowerCase()) || c.mobile.includes(filter));
  list.forEach(c=>{
    const node = document.createElement('div'); node.className = 'contact';
    node.innerHTML = `<div class="thumb">${c.avatar?`<img src="${c.avatar}" style="width:100%;height:100%;object-fit:cover">`:''}</div>
                      <div class="meta"><div class="name">${c.name||c.mobile}</div><div class="small">${c.mobile}</div></div>`;
    node.onclick = ()=> selectChat(c.mobile);
    contactsList.appendChild(node);
  });
}

// connect WS
function connectWS(){
  if(!me || !me.mobile) return;
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', ()=> ws.send(JSON.stringify({ type:'auth', mobile: me.mobile })));
  ws.addEventListener('message', e=>{ try{ const msg = JSON.parse(e.data); handleWS(msg); }catch{} });
  ws.addEventListener('close', ()=> console.log('ws closed'));
}

// handle WS messages
function handleWS(msg){
  if(!msg) return;
  if(msg.type === 'users_list'){
    // update contact meta if present
    msg.users.forEach(u=>{
      const idx = contacts.findIndex(c=>c.mobile===u.mobile);
      if(idx > -1){ contacts[idx].name = u.name; contacts[idx].avatar = u.avatar; }
    });
    renderContacts(searchInput.value || '');
    saveLocal();
  } else if(msg.type === 'message') receiveMessage(msg);
  else if(msg.type === 'webrtc-offer') onIncomingOffer(msg);
  else if(msg.type === 'webrtc-answer') onIncomingAnswer(msg);
  else if(msg.type === 'webrtc-ice') onIncomingIce(msg);
}

// receive message
function receiveMessage(msg){
  if(!contacts.find(c=>c.mobile===msg.from)) { contacts.unshift({ mobile: msg.from, name: msg.from, avatar: msg.avatar||null }); saveLocal(); renderContacts(); }
  if(currentChat === msg.from || currentChat === msg.to) renderMessage(msg);
}

// render single message bubble
function renderMessage(m){
  const isMe = m.from === me.mobile;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg ' + (isMe ? 'me' : 'them');
  if(m.kind === 'text'){ wrapper.textContent = m.text; }
  else if(m.kind === 'voice'){ const a = document.createElement('audio'); a.controls = true; a.src = m.audio; wrapper.appendChild(a); }
  else if(m.kind === 'image'){ const im = document.createElement('img'); im.src = m.image; im.style.maxWidth = '220px'; im.style.borderRadius='8px'; wrapper.appendChild(im); }
  const t = document.createElement('div'); t.className = 'time'; t.textContent = new Date(m.time||Date.now()).toLocaleTimeString(); wrapper.appendChild(t);
  messagesEl.appendChild(wrapper); messagesEl.scrollTop = messagesEl.scrollHeight;
}

// select chat & load history
async function selectChat(mobile){
  currentChat = mobile;
  const c = contacts.find(x=>x.mobile===mobile) || { mobile };
  chatName.innerText = c.name || c.mobile; chatMobileView.innerText = c.mobile;
  chatAvatar.innerHTML = c.avatar?`<img src="${c.avatar}" style="width:100%;height:100%;object-fit:cover">`:'';
  messagesEl.innerHTML = '';
  try{
    const res = await fetch(`/history/${encodeURIComponent(me.mobile)}/${encodeURIComponent(mobile)}`);
    const conv = await res.json();
    conv.forEach(m => renderMessage(m));
  } catch(err){}
}

// OTP functions
async function requestOtpAPI(mobile){
  const r = await fetch('/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ mobile })});
  return r.json();
}
async function verifyOtpAPI(mobile, code, name, avatar){
  const r = await fetch('/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ mobile, code, name, avatar })});
  return r.json();
}

// Events: Add people button -> open modal
addPeopleBtn.onclick = ()=> openModal();

// modal controls
function openModal(){ modal.classList.remove('hidden'); }
function closeModalFn(){ modal.classList.add('hidden'); }
closeModal.onclick = closeModalFn;

// avatar preview in modal
avatarFile.onchange = async e => {
  const f = e.target.files[0]; if(!f) return;
  const d = await fileToDataURL(f);
  avatarPreviewSmall.innerHTML = `<img src="${d}" style="width:100%;height:100%;object-fit:cover">`;
};

// Request OTP
requestOtpBtn.onclick = async () => {
  const mobile = mobileInput.value.trim(); if(!mobile) return alert('Enter mobile');
  const r = await requestOtpAPI(mobile);
  alert(r.message || 'OTP requested — check server console');
};

// Verify OTP and create profile
verifyOtpBtn.onclick = async () => {
  const mobile = mobileInput.value.trim(); const code = otpInput.value.trim(); const name = nameInput.value.trim();
  if(!mobile || !code) return alert('Enter mobile & OTP');
  let avatarData = null; if(avatarFile.files && avatarFile.files[0]) avatarData = await fileToDataURL(avatarFile.files[0]);
  const r = await verifyOtpAPI(mobile, code, name || mobile, avatarData);
  if(r.ok){ me = r.user; myName.innerText = me.name; myMobile.innerText = me.mobile; myAvatarPreview.innerHTML = me.avatar?`<img src="${me.avatar}" style="width:100%;height:100%;object-fit:cover">`:''; saveLocal(); connectWS(); closeModalFn(); } else alert(r.error || 'Verify failed');
};

// Add contact input
addContactBtn.onclick = () => {
  const m = addMobileInput.value.trim(); if(!m) return;
  if(!contacts.find(c=>c.mobile===m)) contacts.unshift({ mobile:m, name:m });
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'add_contact', from: me.mobile, to: m }));
  addMobileInput.value=''; saveLocal(); renderContacts();
};

// search contacts
searchInput.addEventListener('input', e => renderContacts(e.target.value));

// sending text
sendBtn.onclick = () => sendText();
messageInput.addEventListener('keydown', e => { if(e.key === 'Enter') sendText(); });

function sendText(){
  const text = messageInput.value.trim(); if(!text) return;
  if(!currentChat) return alert('Select a contact');
  const msg = { type:'message', from: me.mobile, to: currentChat, kind:'text', text, avatar: me.avatar };
  if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  renderMessage({...msg, time: Date.now()});
  messageInput.value='';
}

// emoji main & dropdown
emojiMain.onclick = ()=> {
  const hidden = emojiDropdown.getAttribute('aria-hidden') === 'true';
  emojiDropdown.setAttribute('aria-hidden', String(!hidden));
};
emojiDropdown.addEventListener('click', e => {
  if(e.target.classList.contains('emoji')){
    messageInput.focus();
    const emoji = e.target.innerText;
    const s = messageInput.selectionStart || 0;
    const txt = messageInput.value;
    messageInput.value = txt.slice(0,s) + emoji + txt.slice(s);
    messageInput.selectionStart = messageInput.selectionEnd = s + emoji.length;
    emojiDropdown.setAttribute('aria-hidden', 'true');
  }
});

// camera snaps
cameraBtn.onclick = async () => {
  // open camera, take one photo, send as image
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();
    // draw to canvas
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap,0,0);
    const dataUrl = c.toDataURL('image/jpeg', 0.8);
    track.stop();
    // send as message
    if(!currentChat) return alert('Select a contact');
    const msg = { type:'message', from: me.mobile, to: currentChat, kind:'image', image: dataUrl, avatar: me.avatar };
    if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    renderMessage({...msg, time: Date.now()});
  } catch (err) {
    alert('Camera not available or permission denied');
  }
};

// voice note (mic only)
recordBtn.onclick = async () => {
  if(!mediaRecorder || mediaRecorder.state === 'inactive'){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = ev => { if(ev.data.size) recordedChunks.push(ev.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        const dataUrl = await blobToDataURL(blob);
        if(!currentChat) return alert('Select a contact');
        const msg = { type:'message', from: me.mobile, to: currentChat, kind:'voice', audio: dataUrl, avatar: me.avatar };
        if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        renderMessage({...msg, time: Date.now()});
      };
      mediaRecorder.start();
      recordBtn.textContent = '⏹️';
    } catch (e) {
      alert('Microphone access is required');
    }
  } else if(mediaRecorder && mediaRecorder.state === 'recording'){
    mediaRecorder.stop();
    recordBtn.textContent = '🎙️';
  }
};

// WebRTC calls
callBtn.onclick = ()=> startCall();
hangupBtn.onclick = ()=> endCall();

async function startCall(){
  if(!currentChat) return alert('Select contact');
  pc = new RTCPeerConnection(STUN);
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
  } catch(e){ return alert('Microphone access needed'); }
  pc.ontrack = e => { remoteAudio.srcObject = e.streams[0]; };
  pc.onicecandidate = e => { if(e.candidate) ws.send(JSON.stringify({ type:'webrtc-ice', from: me.mobile, to: currentChat, candidate: e.candidate })); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type:'webrtc-offer', from: me.mobile, to: currentChat, sdp: offer }));
  callBtn.style.display = 'none'; hangupBtn.style.display = 'inline-block';
}

async function onIncomingOffer(msg){
  if(msg && msg.from){
    const accept = confirm(`Incoming call from ${msg.from}. Accept?`);
    if(!accept) return;
    currentChat = msg.from; selectChat(currentChat);
    pc = new RTCPeerConnection(STUN);
    pc.ontrack = e => { remoteAudio.srcObject = e.streams[0]; };
    pc.onicecandidate = e => { if(e.candidate) ws.send(JSON.stringify({ type:'webrtc-ice', from: me.mobile, to: msg.from, candidate: e.candidate })); };
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
    } catch(e){ alert('Microphone required to accept call'); return; }
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type:'webrtc-answer', from: me.mobile, to: msg.from, sdp: answer }));
    callBtn.style.display = 'none'; hangupBtn.style.display = 'inline-block';
  }
}

async function onIncomingAnswer(msg){ if(pc && msg.sdp) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); }
async function onIncomingIce(msg){ if(pc && msg.candidate) try{ await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }catch(e){} }

function endCall(){
  if(pc){
    pc.getSenders().forEach(s=>{ if(s.track) s.track.stop(); });
    pc.close(); pc=null; remoteAudio.srcObject=null;
    callBtn.style.display = 'inline-block'; hangupBtn.style.display = 'none';
  }
}

// init ui & data
(function init(){
  // show modal if not signed
  if(!me){ openModal(); } else {
    myName.innerText = me.name || 'You'; myMobile.innerText = me.mobile || ''; myAvatarPreview.innerHTML = me.avatar?`<img src="${me.avatar}" style="width:100%;height:100%;object-fit:cover">`:'';
    connectWS();
  }
  // load contacts
  renderContacts();

  // wire avatar preview on main page (if user uploads after sign-in)
  document.getElementById('avatarFile')?.addEventListener('change', async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    const d = await fileToDataURL(f);
    avatarPreviewSmall.innerHTML = `<img src="${d}" style="width:100%;height:100%;object-fit:cover">`;
  });
})();

// helper: convert file input in both places
async function fileToDataURL(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = ()=> res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
