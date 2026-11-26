/* ============================================================
   Easy Talkers v2 – WhatsApp-style real-time chat
   Firebase Auth + Firestore
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyAChqhvE2euGLd7ByhAo_nGFZdItIkKZqM",
  authDomain: "easy-talkers.firebaseapp.com",
  projectId: "easy-talkers",
  storageBucket: "easy-talkers.firebasestorage.app",
  messagingSenderId: "533433245977",
  appId: "1:533433245977:web:82ffe12e9296d116a3e588"
};

let auth = null, db = null;
try {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
  // Enable offline persistence for faster feel
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
} catch (e) {
  console.error("Firebase init error", e);
}

/* ---------- State ---------- */
let me = null;
let allUsers = [];
let groups = [];
let statuses = [];
let chattingWith = null;   // user object
let chattingGroup = null;  // group object
let unsubUsers = null, unsubGroups = null, unsubStatus = null, unsubChat = null, unsubInbox = null;
let mediaRecorder = null, audioChunks = [], isRecording = false, recStart = 0, recTimer = null;
let unreadMap = {};
let viewedStatuses = new Set();
let currentStatusQueue = [], currentStatusIdx = 0, statusTimer = null, statusProgress = 0;
let _seen = new Set();
let lastRenderKey = "";
let currentTab = "chats";          // "chats" | "contacts"
let recentChats = {};              // uid or "g_xxx" -> { lastText, lastAt, count }

try { unreadMap = JSON.parse(localStorage.getItem("et_unread") || "{}"); } catch (_) {}
try { viewedStatuses = new Set(JSON.parse(localStorage.getItem("viewedStatus") || "[]")); } catch (_) {}
try { recentChats = JSON.parse(localStorage.getItem("et_recent") || "{}"); } catch (_) {}

/* ---------- Helpers ---------- */
function showToast(m) {
  const t = document.getElementById("toast");
  t.innerText = m;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 2800);
}

function msgKey(m) {
  return m.fbId || m.localId || `${m.from}|${m.to || ""}|${m.groupId || ""}|${m.text}|${m.createdAt}`;
}

function isDup(m) {
  const k = msgKey(m);
  if (_seen.has(k)) return true;
  _seen.add(k);
  return false;
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 604800) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
  // show send vs mic
  const hasText = el.value.trim().length > 0;
  document.getElementById("sendBtn").style.display = hasText ? "flex" : "none";
  document.getElementById("micBtn").style.display = hasText ? "none" : "flex";
}

function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

/* ---------- Auth UI ---------- */
function showLogin() {
  document.getElementById("loginForm").classList.remove("hidden");
  document.getElementById("signupForm").classList.add("hidden");
  document.getElementById("authTitle").innerText = "Welcome Back";
  document.getElementById("authSub").innerText = "Sign in to start chatting";
}

function showSignup() {
  document.getElementById("loginForm").classList.add("hidden");
  document.getElementById("signupForm").classList.remove("hidden");
  document.getElementById("authTitle").innerText = "Create Account";
  document.getElementById("authSub").innerText = "Join Easy Talkers";
}

function showAuth() {
  document.getElementById("authView").style.display = "flex";
  document.getElementById("mainLeft").style.display = "none";
  document.getElementById("mainLeft").classList.add("hidden");
}

function showApp() {
  document.getElementById("authView").style.display = "none";
  const ml = document.getElementById("mainLeft");
  ml.style.display = "flex";
  ml.classList.remove("hidden");
}

async function doLogin() {
  const email = document.getElementById("loginEmail").value.trim();
  const pass = document.getElementById("loginPass").value;
  const msg = document.getElementById("loginMsg");
  msg.innerText = "";
  if (!email || !pass) { msg.innerText = "Enter email and password"; return; }
  try {
    await auth.signInWithEmailAndPassword(email, pass);
  } catch (e) {
    msg.innerText = e.message.replace("Firebase: ", "").replace(/\(auth\/.*\)/, "");
  }
}

async function doRegister() {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const pass = document.getElementById("signupPass").value;
  const msg = document.getElementById("signupMsg");
  msg.innerText = "";
  if (!name || !email || !pass) { msg.innerText = "All fields required"; return; }
  if (pass.length < 6) { msg.innerText = "Password must be at least 6 characters"; return; }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await db.collection("users").doc(cred.user.uid).set({
      uid: cred.user.uid,
      name,
      email,
      photoURL: "",
      about: "Hey there! I am using Easy Talkers",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      online: true
    }, { merge: true });
  } catch (e) {
    msg.innerText = e.message.replace("Firebase: ", "").replace(/\(auth\/.*\)/, "");
  }
}

function logout() {
  if (unsubUsers) unsubUsers();
  if (unsubGroups) unsubGroups();
  if (unsubStatus) unsubStatus();
  if (unsubChat) unsubChat();
  if (unsubInbox) unsubInbox();
  auth.signOut();
  closeMenu();
}

/* ---------- User presence & profile ---------- */
async function upsertUser(user) {
  if (!user) return;
  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();
  const data = {
    uid: user.uid,
    email: user.email || "",
    name: user.displayName || user.email?.split("@")[0] || "User",
    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    online: true
  };
  if (!snap.exists) {
    data.photoURL = user.photoURL || "";
    data.about = "Hey there! I am using Easy Talkers";
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
  }
  await ref.set(data, { merge: true });
}

function setOnline(status) {
  if (!me || !db) return;
  db.collection("users").doc(me.uid).set({
    online: status,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(() => {});
}

/* ---------- Listeners ---------- */
function startListeners() {
  // Users
  unsubUsers = db.collection("users").onSnapshot(snap => {
    allUsers = [];
    snap.forEach(d => allUsers.push({ id: d.id, ...d.data() }));
    me = allUsers.find(u => u.uid === auth.currentUser?.uid) || me;
    renderCurrentTab();
    renderStatusBar();
    updateMenuProfile();
  }, err => console.error(err));

  // Groups (where I am a member)
  unsubGroups = db.collection("groups")
    .where("members", "array-contains", auth.currentUser.uid)
    .onSnapshot(snap => {
      groups = [];
      snap.forEach(d => groups.push({ id: d.id, ...d.data() }));
      renderCurrentTab();
    }, err => console.error(err));

  // Statuses (last 24h)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  unsubStatus = db.collection("statuses")
    .where("createdAt", ">", dayAgo)
    .orderBy("createdAt", "desc")
    .onSnapshot(snap => {
      statuses = [];
      snap.forEach(d => statuses.push({ id: d.id, ...d.data() }));
      renderStatusBar();
    }, err => console.error(err));

  // Inbox: listen to recent messages to build "old chats" list
  unsubInbox = db.collection("messages")
    .where("participants", "array-contains", auth.currentUser.uid)
    .orderBy("createdAt", "desc")
    .limit(80)
    .onSnapshot(snap => {
      snap.forEach(d => {
        const m = d.data();
        let key = null;
        if (m.groupId) {
          key = "g_" + m.groupId;
        } else {
          // the other person
          key = m.from === me.uid ? m.to : m.from;
        }
        if (!key) return;
        const at = m.createdAt?.toMillis?.() || Date.now();
        const existing = recentChats[key];
        if (!existing || at >= (existing.lastAt || 0)) {
          recentChats[key] = {
            lastText: m.text || (m.type === "image" ? "📷 Photo" : m.type === "audio" ? "🎤 Voice" : ""),
            lastAt: at,
            count: existing?.count || 0
          };
          // also keep unreadMap in sync for badge
          if (!unreadMap[key]) unreadMap[key] = { count: 0 };
          unreadMap[key].lastText = recentChats[key].lastText;
          unreadMap[key].lastAt = at;
        }
      });
      localStorage.setItem("et_recent", JSON.stringify(recentChats));
      localStorage.setItem("et_unread", JSON.stringify(unreadMap));
      if (currentTab === "chats") renderChatList();
    }, err => console.error("inbox", err));
}

/* ---------- Tabs ---------- */
function switchTab(tab) {
  currentTab = tab;
  document.getElementById("tabChats").classList.toggle("active", tab === "chats");
  document.getElementById("tabContacts").classList.toggle("active", tab === "contacts");

  const statusSec = document.getElementById("statusSection");
  const chatList = document.getElementById("chatList");
  const contactsList = document.getElementById("contactsListMain");
  const search = document.getElementById("searchInput");

  if (tab === "chats") {
    statusSec.style.display = "";
    chatList.classList.remove("hidden");
    contactsList.classList.add("hidden");
    search.placeholder = "Search chats…";
  } else {
    statusSec.style.display = "none";
    chatList.classList.add("hidden");
    contactsList.classList.remove("hidden");
    search.placeholder = "Search contacts…";
  }
  search.value = "";
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === "chats") renderChatList();
  else renderContactsList();
}

function onSearch() {
  renderCurrentTab();
}

/* ---------- Chats tab = only conversations that already exist (old + recent) ---------- */
function renderChatList() {
  const list = document.getElementById("chatList");
  if (!list) return;
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase();

  const items = [];

  // Direct chats that appear in recentChats or unreadMap
  const chatKeys = new Set([
    ...Object.keys(recentChats),
    ...Object.keys(unreadMap)
  ]);

  chatKeys.forEach(key => {
    if (key.startsWith("g_")) return; // groups handled below
    const u = allUsers.find(x => x.uid === key);
    if (!u || u.uid === me?.uid) return;
    if (q && !u.name?.toLowerCase().includes(q) && !u.email?.toLowerCase().includes(q)) return;

    const meta = recentChats[key] || unreadMap[key] || {};
    items.push({
      type: "user",
      id: u.uid,
      name: u.name || "User",
      photoURL: u.photoURL,
      lastMsg: meta.lastText || "",
      time: meta.lastAt || 0,
      unread: unreadMap[key]?.count || 0,
      online: u.online,
      data: u
    });
  });

  // Groups
  groups.forEach(g => {
    const key = "g_" + g.id;
    if (q && !g.name?.toLowerCase().includes(q)) return;
    const meta = recentChats[key] || unreadMap[key] || {};
    items.push({
      type: "group",
      id: g.id,
      name: g.name || "Group",
      photoURL: g.photoURL,
      lastMsg: meta.lastText || "Group chat",
      time: meta.lastAt || g.createdAt?.toMillis?.() || 0,
      unread: unreadMap[key]?.count || 0,
      data: g
    });
  });

  // Sort by most recent activity (old chats still appear, just lower)
  items.sort((a, b) => (b.time || 0) - (a.time || 0));

  // Update tab badge
  const totalUnread = items.reduce((s, it) => s + (it.unread || 0), 0);
  const tabChats = document.getElementById("tabChats");
  if (tabChats) {
    tabChats.innerHTML = totalUnread > 0
      ? `Chats <span class="tab-count">${totalUnread > 99 ? "99+" : totalUnread}</span>`
      : "Chats";
  }

  if (!items.length) {
    list.innerHTML = `<div style="padding:48px 24px;text-align:center;color:#667781">
      <div style="font-size:40px;margin-bottom:12px">💬</div>
      <p style="font-weight:600;color:#111b21;margin-bottom:6px">No chats yet</p>
      <p style="font-size:13px;margin-bottom:16px">Start a conversation from the Contacts tab</p>
      <button class="btn btn-green" style="width:auto;padding:10px 22px" onclick="switchTab('contacts')">Go to Contacts</button>
    </div>`;
    return;
  }

  list.innerHTML = items.map(it => {
    const isActive = (it.type === "user" && chattingWith?.uid === it.id) ||
                     (it.type === "group" && chattingGroup?.id === it.id);
    const initial = (it.name || "U")[0].toUpperCase();
    const avatar = it.photoURL
      ? `<img src="${escapeHtml(it.photoURL)}" alt="">`
      : initial;
    const online = it.online ? `<span class="online-dot"></span>` : "";
    const badge = it.unread > 0 ? `<span class="unread-badge">${it.unread > 99 ? "99+" : it.unread}</span>` : "";
    const lastPreview = it.lastMsg || (it.time ? " " : "Tap to open");
    return `
      <div class="${it.type === "group" ? "group-item" : "user"} ${isActive ? "active" : ""}"
           onclick="${it.type === "user" ? `openChat('${it.id}')` : `openGroupChat('${it.id}')`}">
        <div class="avatar">${avatar}${online}</div>
        <div class="user-info">
          <div class="user-name-row">
            <span class="user-name">${escapeHtml(it.name)}${it.type === "group" ? " 👥" : ""}</span>
            <span class="user-time">${it.time ? timeAgo(it.time) : ""}</span>
          </div>
          <div class="user-last">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(lastPreview)}</span>
            ${badge}
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ---------- Contacts tab = all users (not just people you've chatted with) ---------- */
function renderContactsList() {
  const list = document.getElementById("contactsListMain");
  if (!list) return;
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase();

  const users = allUsers
    .filter(u => u.uid !== me?.uid)
    .filter(u => !q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  // tab label
  const tabContacts = document.getElementById("tabContacts");
  if (tabContacts) {
    tabContacts.innerHTML = users.length
      ? `Contacts <span class="tab-count" style="background:#667781">${users.length}</span>`
      : "Contacts";
  }

  if (!users.length) {
    list.innerHTML = `<div style="padding:48px 24px;text-align:center;color:#667781">
      <div style="font-size:40px;margin-bottom:12px">👤</div>
      <p style="font-weight:600;color:#111b21;margin-bottom:6px">No contacts found</p>
      <p style="font-size:13px">Other users will appear here when they sign up</p>
    </div>`;
    return;
  }

  // Group by first letter for nicer contacts feel
  let html = "";
  let lastLetter = "";
  users.forEach(u => {
    const letter = (u.name || "U")[0].toUpperCase();
    if (letter !== lastLetter) {
      html += `<div style="padding:8px 16px 4px;font-size:13px;font-weight:700;color:var(--wa-green);background:#f7f8fa">${letter}</div>`;
      lastLetter = letter;
    }
    const hasChat = !!(recentChats[u.uid] || unreadMap[u.uid]);
    html += `
      <div class="user" onclick="openChat('${u.uid}');switchTab('chats')">
        <div class="avatar">${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}">` : (u.name || "U")[0].toUpperCase()}${u.online ? '<span class="online-dot"></span>' : ""}</div>
        <div class="user-info">
          <div class="user-name-row">
            <span class="user-name">${escapeHtml(u.name || "User")}</span>
            ${hasChat ? '<span style="font-size:11px;color:#00a884">Chat exists</span>' : ""}
          </div>
          <div class="user-last">${escapeHtml(u.about || u.email || "Hey there! I am using Easy Talkers")}</div>
        </div>
      </div>`;
  });
  list.innerHTML = html;
}

/* ---------- Status bar ---------- */
function getStatusesByUser() {
  const map = new Map();
  statuses.forEach(s => {
    if (!map.has(s.from)) map.set(s.from, []);
    map.get(s.from).push(s);
  });
  // sort each by time
  map.forEach((arr, k) => arr.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)));
  return map;
}

function renderStatusBar() {
  const line = document.getElementById("statusLine");
  if (!line || !me) return;
  const byUser = getStatusesByUser();
  const myStatuses = byUser.get(me.uid) || [];
  const others = [...byUser.entries()].filter(([uid]) => uid !== me.uid);

  let html = "";

  // My status
  if (myStatuses.length) {
    const last = myStatuses[myStatuses.length - 1];
    const viewed = myStatuses.every(s => viewedStatuses.has(s.id));
    html += `
      <div class="statusDotWrap" onclick="openStatusViewer('${me.uid}')">
        <div class="statusDot has-status ${viewed ? "viewed" : ""}">
          ${last.image ? `<img src="${escapeHtml(last.image)}">` : (me.photoURL ? `<img src="${escapeHtml(me.photoURL)}">` : (me.name || "Y")[0])}
        </div>
        <span class="statusDotLabel">My status</span>
      </div>`;
  } else {
    html += `
      <div class="statusDotWrap" onclick="document.getElementById('statusPicInput').click()">
        <div class="statusDot" style="background:#fff;color:#00a884;border:2.5px dashed #00a884;font-size:28px">+</div>
        <span class="statusDotLabel">My status</span>
      </div>`;
  }

  others.forEach(([uid, arr]) => {
    const last = arr[arr.length - 1];
    const u = allUsers.find(x => x.uid === uid);
    const name = last.fromName || u?.name || "User";
    const allViewed = arr.every(s => viewedStatuses.has(s.id));
    html += `
      <div class="statusDotWrap" onclick="openStatusViewer('${uid}')">
        <div class="statusDot has-status ${allViewed ? "viewed" : ""}">
          ${last.image ? `<img src="${escapeHtml(last.image)}">` : (last.photoURL || u?.photoURL ? `<img src="${escapeHtml(last.photoURL || u.photoURL)}">` : name[0].toUpperCase())}
        </div>
        <span class="statusDotLabel">${escapeHtml(name)}</span>
      </div>`;
  });

  line.innerHTML = html;
}

/* ---------- Open chat ---------- */
function openChat(uid) {
  const user = allUsers.find(u => u.uid === uid);
  if (!user) return;
  chattingWith = user;
  chattingGroup = null;
  if (unsubChat) unsubChat();
  _seen.clear();

  document.getElementById("emptyState").classList.add("hidden");
  const cv = document.getElementById("chatView");
  cv.classList.remove("hidden");
  cv.style.display = "flex";

  document.getElementById("chatName").innerText = user.name || "User";
  document.getElementById("chatStatus").innerText = user.online ? "online" : ("last seen " + timeAgo(user.lastSeen));
  const av = document.getElementById("chatAvatar");
  av.innerHTML = user.photoURL ? `<img src="${escapeHtml(user.photoURL)}">` : (user.name || "U")[0].toUpperCase();

  // mobile: hide left
  if (window.innerWidth <= 768) {
    document.getElementById("leftPanel").classList.add("hidden-mobile");
  }

  // Ensure this chat appears in Chats tab (even if first time)
  if (!recentChats[uid]) {
    recentChats[uid] = { lastText: "", lastAt: Date.now(), count: 0 };
    localStorage.setItem("et_recent", JSON.stringify(recentChats));
  }
  // clear unread
  if (unreadMap[uid]) {
    unreadMap[uid].count = 0;
    localStorage.setItem("et_unread", JSON.stringify(unreadMap));
  }
  if (currentTab !== "chats") switchTab("chats");
  else renderChatList();

  // listen to messages between me and this user
  const msgsEl = document.getElementById("msgs");
  msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#667781">Loading messages…</div>`;

  unsubChat = db.collection("messages")
    .where("participants", "array-contains", me.uid)
    .orderBy("createdAt", "asc")
    .limitToLast(100)
    .onSnapshot(snap => {
      const relevant = [];
      snap.forEach(d => {
        const m = { fbId: d.id, ...d.data() };
        if ((m.from === me.uid && m.to === uid) || (m.from === uid && m.to === me.uid)) {
          relevant.push(m);
        }
      });
      renderMessages(relevant);
    }, err => {
      console.error(err);
      msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#ea0038">Could not load messages</div>`;
    });
}

function openGroupChat(gid) {
  const g = groups.find(x => x.id === gid);
  if (!g) return;
  chattingGroup = g;
  chattingWith = null;
  if (unsubChat) unsubChat();
  _seen.clear();

  document.getElementById("emptyState").classList.add("hidden");
  const cv = document.getElementById("chatView");
  cv.classList.remove("hidden");
  cv.style.display = "flex";

  document.getElementById("chatName").innerText = g.name || "Group";
  document.getElementById("chatStatus").innerText = (g.members?.length || 0) + " members";
  const av = document.getElementById("chatAvatar");
  av.innerHTML = g.photoURL ? `<img src="${escapeHtml(g.photoURL)}">` : "👥";

  if (window.innerWidth <= 768) {
    document.getElementById("leftPanel").classList.add("hidden-mobile");
  }

  if (unreadMap["g_" + gid]) {
    unreadMap["g_" + gid].count = 0;
    localStorage.setItem("et_unread", JSON.stringify(unreadMap));
  }
  renderChatList();

  const msgsEl = document.getElementById("msgs");
  msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#667781">Loading…</div>`;

  unsubChat = db.collection("messages")
    .where("groupId", "==", gid)
    .orderBy("createdAt", "asc")
    .limitToLast(100)
    .onSnapshot(snap => {
      const relevant = [];
      snap.forEach(d => relevant.push({ fbId: d.id, ...d.data() }));
      renderMessages(relevant);
    });
}

function backToUsers() {
  if (unsubChat) { unsubChat(); unsubChat = null; }
  chattingWith = null;
  chattingGroup = null;
  document.getElementById("chatView").classList.add("hidden");
  document.getElementById("chatView").style.display = "none";
  document.getElementById("emptyState").classList.remove("hidden");
  document.getElementById("leftPanel").classList.remove("hidden-mobile");
  renderChatList();
}

function renderMessages(msgs) {
  const el = document.getElementById("msgs");
  if (!el) return;
  let html = "";
  let lastDay = "";

  msgs.forEach(m => {
    if (isDup(m)) return;
    const isOut = m.from === me.uid;
    const day = m.createdAt?.toDate ? m.createdAt.toDate().toDateString() : "";
    if (day && day !== lastDay) {
      html += `<div class="msg-day">${day === new Date().toDateString() ? "Today" : timeAgo(m.createdAt)}</div>`;
      lastDay = day;
    }

    let content = "";
    if (m.type === "image" && m.image) {
      content = `<img class="media" src="${escapeHtml(m.image)}" alt="photo" onclick="window.open(this.src)">`;
    } else if (m.type === "audio" && m.audio) {
      content = `<audio controls src="${escapeHtml(m.audio)}" style="max-width:240px"></audio>`;
    } else {
      content = `<div class="text">${escapeHtml(m.text || "")}</div>`;
    }

    const ticks = isOut ? `<span class="ticks">${m.read ? "✓✓" : "✓"}</span>` : "";
    html += `
      <div class="bubble ${isOut ? "out" : "in"}">
        ${!isOut && chattingGroup ? `<div style="font-size:12px;color:#00a884;font-weight:600;margin-bottom:2px">${escapeHtml(m.fromName || "")}</div>` : ""}
        ${content}
        <div class="meta">${formatTime(m.createdAt)} ${ticks}</div>
      </div>`;
  });

  el.innerHTML = html || `<div style="text-align:center;padding:40px;color:#667781">No messages yet. Say hi! 👋</div>`;
  el.scrollTop = el.scrollHeight;
}

/* ---------- Send message ---------- */
async function sendMessage() {
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text) return;
  if (!chattingWith && !chattingGroup) return;

  input.value = "";
  autoResize(input);

  const localId = "local_" + Date.now();
  const base = {
    from: me.uid,
    fromName: me.name,
    text,
    type: "text",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    localId
  };

  // Optimistic UI
  const optimistic = { ...base, createdAt: new Date(), fbId: localId };
  const el = document.getElementById("msgs");
  // append quickly
  const isOut = true;
  el.insertAdjacentHTML("beforeend", `
    <div class="bubble out" data-local="${localId}">
      <div class="text">${escapeHtml(text)}</div>
      <div class="meta">sending…</div>
    </div>`);
  el.scrollTop = el.scrollHeight;

  try {
    if (chattingWith) {
      await db.collection("messages").add({
        ...base,
        to: chattingWith.uid,
        participants: [me.uid, chattingWith.uid].sort()
      });
      const key = chattingWith.uid;
      unreadMap[key] = { lastText: text, lastAt: Date.now(), count: 0 };
      recentChats[key] = { lastText: text, lastAt: Date.now(), count: 0 };
    } else if (chattingGroup) {
      await db.collection("messages").add({
        ...base,
        groupId: chattingGroup.id,
        participants: chattingGroup.members || []
      });
      const key = "g_" + chattingGroup.id;
      unreadMap[key] = { lastText: text, lastAt: Date.now(), count: 0 };
      recentChats[key] = { lastText: text, lastAt: Date.now(), count: 0 };
    }
    localStorage.setItem("et_unread", JSON.stringify(unreadMap));
    localStorage.setItem("et_recent", JSON.stringify(recentChats));
    renderChatList();
  } catch (e) {
    showToast("Failed to send");
    console.error(e);
  }
}

/* ---------- Media ---------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file, maxW = 1200) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if (w > maxW) { h = (h * maxW) / w; w = maxW; }
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    img.src = URL.createObjectURL(file);
  });
}

async function handleFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  if (!chattingWith && !chattingGroup) { showToast("Open a chat first"); return; }

  showToast("Uploading…");
  try {
    let payload = { from: me.uid, fromName: me.name, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (file.type.startsWith("image/")) {
      const b64 = await compressImage(file);
      payload.type = "image";
      payload.image = b64;
      payload.text = "📷 Photo";
    } else if (file.type.startsWith("audio/")) {
      const b64 = await fileToBase64(file);
      payload.type = "audio";
      payload.audio = b64;
      payload.text = "🎤 Audio";
    } else {
      showToast("Unsupported file type");
      return;
    }

    if (chattingWith) {
      payload.to = chattingWith.uid;
      payload.participants = [me.uid, chattingWith.uid].sort();
    } else {
      payload.groupId = chattingGroup.id;
      payload.participants = chattingGroup.members || [];
    }
    await db.collection("messages").add(payload);
    showToast("Sent");
  } catch (e) {
    showToast("Upload failed");
    console.error(e);
  }
}

/* ---------- Voice recording ---------- */
async function toggleRecord() {
  if (isRecording) {
    stopRecording();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const b64 = await fileToBase64(blob);
      if (!chattingWith && !chattingGroup) return;
      const payload = {
        from: me.uid,
        fromName: me.name,
        type: "audio",
        audio: b64,
        text: "🎤 Voice message",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (chattingWith) {
        payload.to = chattingWith.uid;
        payload.participants = [me.uid, chattingWith.uid].sort();
      } else {
        payload.groupId = chattingGroup.id;
        payload.participants = chattingGroup.members || [];
      }
      await db.collection("messages").add(payload);
    };
    mediaRecorder.start();
    isRecording = true;
    recStart = Date.now();
    document.getElementById("recordingBar").style.display = "flex";
    document.getElementById("msgInput").style.display = "none";
    document.getElementById("sendBtn").style.display = "none";
    document.getElementById("micBtn").innerText = "⏹";
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      document.getElementById("recTime").innerText = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 500);
  } catch (e) {
    showToast("Microphone access denied");
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(recTimer);
    document.getElementById("recordingBar").style.display = "none";
    document.getElementById("msgInput").style.display = "block";
    document.getElementById("micBtn").innerText = "🎤";
    autoResize(document.getElementById("msgInput"));
  }
}

function cancelRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    isRecording = false;
    clearInterval(recTimer);
    document.getElementById("recordingBar").style.display = "none";
    document.getElementById("msgInput").style.display = "block";
    document.getElementById("micBtn").innerText = "🎤";
  }
}

/* ---------- Status ---------- */
async function uploadStatus(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  showToast("Posting status…");
  try {
    const b64 = await compressImage(file, 1080);
    await db.collection("statuses").add({
      from: me.uid,
      fromName: me.name,
      photoURL: me.photoURL || "",
      image: b64,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      viewers: []
    });
    showToast("Status posted");
  } catch (e) {
    showToast("Failed to post status");
    console.error(e);
  }
}

function openStatusViewer(uid) {
  const byUser = getStatusesByUser();
  const arr = byUser.get(uid) || [];
  if (!arr.length) return;
  currentStatusQueue = arr;
  currentStatusIdx = 0;
  document.getElementById("statusViewer").classList.add("active");
  showCurrentStatus();
}

function showCurrentStatus() {
  clearTimeout(statusTimer);
  const s = currentStatusQueue[currentStatusIdx];
  if (!s) { closeStatusViewer(); return; }

  const u = allUsers.find(x => x.uid === s.from);
  document.getElementById("viewerName").innerText = s.fromName || u?.name || "User";
  document.getElementById("viewerTime").innerText = timeAgo(s.createdAt);
  document.getElementById("viewerAvatar").innerHTML = (s.photoURL || u?.photoURL)
    ? `<img src="${escapeHtml(s.photoURL || u.photoURL)}">`
    : (s.fromName || "U")[0].toUpperCase();

  // progress bars
  const prog = document.getElementById("viewerProgress");
  prog.innerHTML = currentStatusQueue.map((_, i) =>
    `<div class="bar"><div class="fill" id="bar${i}" style="width:${i < currentStatusIdx ? 100 : 0}%"></div></div>`
  ).join("");

  const content = document.getElementById("viewerContent");
  if (s.image) {
    content.innerHTML = `<img src="${escapeHtml(s.image)}" alt="status">`;
  } else {
    content.innerHTML = `<div class="status-text">${escapeHtml(s.text || "")}</div>`;
  }

  // mark viewed
  if (!viewedStatuses.has(s.id)) {
    viewedStatuses.add(s.id);
    localStorage.setItem("viewedStatus", JSON.stringify([...viewedStatuses]));
    // update on server
    db.collection("statuses").doc(s.id).update({
      viewers: firebase.firestore.FieldValue.arrayUnion({
        uid: me.uid,
        name: me.name,
        photoURL: me.photoURL || "",
        at: Date.now()
      })
    }).catch(() => {});
  }

  // views count
  const views = (s.viewers || []).length;
  document.getElementById("viewerViews").innerText = `👁 ${views}`;

  // animate progress
  const fill = document.getElementById("bar" + currentStatusIdx);
  const duration = 5000;
  let start = null;
  function animate(ts) {
    if (!start) start = ts;
    const p = Math.min(1, (ts - start) / duration);
    if (fill) fill.style.width = (p * 100) + "%";
    document.getElementById("statusCountdown").innerText = Math.ceil((1 - p) * 5);
    if (p < 1) {
      statusTimer = requestAnimationFrame(animate);
    } else {
      nextStatus();
    }
  }
  statusTimer = requestAnimationFrame(animate);
}

function nextStatus() {
  cancelAnimationFrame(statusTimer);
  currentStatusIdx++;
  if (currentStatusIdx >= currentStatusQueue.length) {
    closeStatusViewer();
  } else {
    showCurrentStatus();
  }
}

function closeStatusViewer() {
  cancelAnimationFrame(statusTimer);
  document.getElementById("statusViewer").classList.remove("active");
  renderStatusBar();
}

function replyStatus() {
  const text = document.getElementById("statusReply").value.trim();
  if (!text || !currentStatusQueue[currentStatusIdx]) return;
  const s = currentStatusQueue[currentStatusIdx];
  // open chat and send
  document.getElementById("statusReply").value = "";
  closeStatusViewer();
  openChat(s.from);
  setTimeout(() => {
    document.getElementById("msgInput").value = text;
    autoResize(document.getElementById("msgInput"));
    sendMessage();
  }, 400);
}

function openViewersFromViewer() {
  const s = currentStatusQueue[currentStatusIdx];
  if (!s) return;
  const viewers = s.viewers || [];
  document.getElementById("viewersTitle").innerText = `👁 ${viewers.length} views`;
  document.getElementById("viewersSubtitle").innerText = "People who viewed this status";
  let html = "";
  if (!viewers.length) {
    html = `<div style="padding:32px;text-align:center;color:#888">No views yet</div>`;
  } else {
    viewers.forEach(v => {
      html += `<div style="display:flex;gap:12px;padding:12px 16px;align-items:center;border-bottom:1px solid #f5f5f5">
        <div class="avatar">${v.photoURL ? `<img src="${escapeHtml(v.photoURL)}">` : (v.name || "U")[0]}</div>
        <div style="flex:1"><b>${escapeHtml(v.name || "User")}</b></div>
        <span style="color:#667781;font-size:13px">👁</span>
      </div>`;
    });
  }
  document.getElementById("viewersListContent").innerHTML = html;
  document.getElementById("viewersDrawer").classList.add("active");
}

function closeViewersDrawer() {
  document.getElementById("viewersDrawer").classList.remove("active");
}

/* ---------- Profile & menu ---------- */
function updateMenuProfile() {
  if (!me) return;
  document.getElementById("menuName").innerText = me.name || "User";
  document.getElementById("menuEmail").innerText = me.email || "";
  document.getElementById("menuAvatar").innerHTML = me.photoURL
    ? `<img src="${escapeHtml(me.photoURL)}">`
    : (me.name || "U")[0].toUpperCase();
}

function openMenu() {
  document.getElementById("sideMenu").classList.add("active");
}
function closeMenu() {
  document.getElementById("sideMenu").classList.remove("active");
}

function openEditProfile() {
  if (!me) return;
  document.getElementById("editName").value = me.name || "";
  document.getElementById("editAbout").value = me.about || "";
  document.getElementById("editAvatar").innerHTML = me.photoURL
    ? `<img src="${escapeHtml(me.photoURL)}">`
    : (me.name || "U")[0].toUpperCase();
  document.getElementById("editProfileModal").classList.add("active");
}
function closeEditProfile() {
  document.getElementById("editProfileModal").classList.remove("active");
}

async function saveProfile() {
  const name = document.getElementById("editName").value.trim();
  const about = document.getElementById("editAbout").value.trim();
  if (!name) { showToast("Name required"); return; }
  try {
    await db.collection("users").doc(me.uid).update({ name, about });
    if (auth.currentUser) await auth.currentUser.updateProfile({ displayName: name });
    showToast("Profile updated");
    closeEditProfile();
  } catch (e) {
    showToast("Update failed");
  }
}

async function changeProfilePic(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  showToast("Updating photo…");
  try {
    const b64 = await compressImage(file, 400);
    await db.collection("users").doc(me.uid).update({ photoURL: b64 });
    document.getElementById("editAvatar").innerHTML = `<img src="${b64}">`;
    showToast("Photo updated");
  } catch (e) {
    showToast("Failed");
  }
}

function viewCurrentProfile() {
  if (chattingWith) viewProfile(chattingWith.uid);
  else if (chattingGroup) viewGroupProfile(chattingGroup.id);
}

function viewProfile(uid) {
  const u = allUsers.find(x => x.uid === uid);
  if (!u) return;
  document.getElementById("profileTitle").innerText = u.name || "Profile";
  document.getElementById("profileContent").innerHTML = `
    <div style="text-align:center;padding:24px">
      <div class="avatar huge" style="margin:0 auto">${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}">` : (u.name || "U")[0]}</div>
      <h2 style="margin:16px 0 4px">${escapeHtml(u.name)}</h2>
      <p class="muted">${escapeHtml(u.about || "")}</p>
      <p class="muted" style="font-size:13px;margin-top:8px">${u.online ? "🟢 Online" : "last seen " + timeAgo(u.lastSeen)}</p>
      <button class="btn btn-green" style="margin-top:20px" onclick="openChat('${u.uid}');closeProfileView()">Message</button>
    </div>`;
  document.getElementById("profileDrawer").classList.add("active");
}

function viewGroupProfile(gid) {
  const g = groups.find(x => x.id === gid);
  if (!g) return;
  const members = (g.members || []).map(uid => {
    const u = allUsers.find(x => x.uid === uid);
    return u ? u.name : uid.slice(0, 6);
  }).join(", ");
  document.getElementById("profileTitle").innerText = g.name || "Group";
  document.getElementById("profileContent").innerHTML = `
    <div style="text-align:center;padding:24px">
      <div class="avatar huge" style="margin:0 auto;background:#00a884">👥</div>
      <h2 style="margin:16px 0 4px">${escapeHtml(g.name)}</h2>
      <p class="muted">${(g.members || []).length} members</p>
      <p style="margin-top:12px;font-size:13px;color:#667781;text-align:left;padding:0 16px">${escapeHtml(members)}</p>
    </div>`;
  document.getElementById("profileDrawer").classList.add("active");
}

function closeProfileView() {
  document.getElementById("profileDrawer").classList.remove("active");
}

/* ---------- Groups ---------- */
function openCreateGroup() {
  const list = document.getElementById("groupMembersList");
  list.innerHTML = allUsers
    .filter(u => u.uid !== me.uid)
    .map(u => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 4px;cursor:pointer">
        <input type="checkbox" value="${u.uid}" style="width:18px;height:18px">
        <div class="avatar small">${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}">` : (u.name || "U")[0]}</div>
        <span>${escapeHtml(u.name)}</span>
      </label>`).join("") || "<p class='muted p-16'>No other users yet</p>";
  document.getElementById("createGroupModal").classList.add("active");
}
function closeCreateGroup() {
  document.getElementById("createGroupModal").classList.remove("active");
}

async function createGroup() {
  const name = document.getElementById("groupName").value.trim();
  if (!name) { showToast("Enter group name"); return; }
  const checks = [...document.querySelectorAll("#groupMembersList input:checked")].map(c => c.value);
  if (!checks.length) { showToast("Select at least one member"); return; }
  const members = [me.uid, ...checks];
  try {
    await db.collection("groups").add({
      name,
      members,
      admins: [me.uid],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: me.uid
    });
    showToast("Group created");
    closeCreateGroup();
    document.getElementById("groupName").value = "";
  } catch (e) {
    showToast("Failed to create group");
  }
}

/* ---------- New chat → just open Contacts tab ---------- */
function openNewChat() {
  switchTab("contacts");
  showToast("Pick a contact to start chatting");
}
function closeNewChat() {
  const m = document.getElementById("newChatModal");
  if (m) m.classList.remove("active");
}
function filterContacts() {
  // kept for modal compatibility; main contacts use renderContactsList()
  renderContactsList();
}

/* ---------- Settings ---------- */
function openSettings() {
  document.getElementById("settingsModal").classList.add("active");
}
function closeSettings() {
  document.getElementById("settingsModal").classList.remove("active");
}
function clearLocalData() {
  localStorage.removeItem("et_unread");
  localStorage.removeItem("et_recent");
  localStorage.removeItem("viewedStatus");
  unreadMap = {};
  recentChats = {};
  viewedStatuses = new Set();
  showToast("Local cache cleared");
  renderCurrentTab();
  closeSettings();
}

function toggleEmoji() {
  showToast("Emoji picker – type emoji directly or use system keyboard 😊");
}

/* ---------- Auth state ---------- */
auth.onAuthStateChanged(async user => {
  if (user) {
    await upsertUser(user);
    me = { uid: user.uid, name: user.displayName, email: user.email, photoURL: user.photoURL };
    showApp();
    startListeners();
    setOnline(true);
    // presence
    window.addEventListener("beforeunload", () => setOnline(false));
    document.addEventListener("visibilitychange", () => setOnline(!document.hidden));
  } else {
    me = null;
    showAuth();
    if (unsubUsers) unsubUsers();
    if (unsubGroups) unsubGroups();
    if (unsubStatus) unsubStatus();
    if (unsubChat) unsubChat();
    if (unsubInbox) unsubInbox();
  }
});

// prevent accidental back on mobile
history.pushState(null, "", location.href);
window.addEventListener("popstate", () => {
  if (chattingWith || chattingGroup) {
    backToUsers();
    history.pushState(null, "", location.href);
  } else {
    history.pushState(null, "", location.href);
  }
});
