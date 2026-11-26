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
let currentTab = "chats";          // bottom nav: chats | calls | status | contacts
let chatFilter = "all";            // all | unread | favorites | groups
let recentChats = {};              // uid or "g_xxx" -> { lastText, lastAt, count }
let favorites = new Set();
let statusBgColor = "#00a884";
let pendingMessages = [];          // optimistic messages waiting for server confirm
let currentChatMessages = [];      // last rendered server messages

try { unreadMap = JSON.parse(localStorage.getItem("et_unread") || "{}"); } catch (_) {}
try { viewedStatuses = new Set(JSON.parse(localStorage.getItem("viewedStatus") || "[]")); } catch (_) {}
try { recentChats = JSON.parse(localStorage.getItem("et_recent") || "{}"); } catch (_) {}
try { favorites = new Set(JSON.parse(localStorage.getItem("et_favorites") || "[]")); } catch (_) {}

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
  if (unsubIncoming) { try { unsubIncoming(); } catch (_) {} unsubIncoming = null; }
  if (currentCallId) endCall();
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

  // Statuses (last 24h) — client-side filter to avoid index errors
  unsubStatus = db.collection("statuses")
    .onSnapshot(snap => {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      statuses = [];
      snap.forEach(d => {
        const data = { id: d.id, ...d.data() };
        const t = data.createdAt?.toMillis?.() || 0;
        if (t >= dayAgo || !data.createdAt) statuses.push(data);
      });
      renderStatusBar();
      if (currentTab === "status") renderStatusPage();
    }, err => console.error(err));

  // Inbox: build old/recent chats list (no orderBy to avoid index errors)
  unsubInbox = db.collection("messages")
    .where("participants", "array-contains", auth.currentUser.uid)
    .onSnapshot(snap => {
      snap.forEach(d => {
        const m = d.data();
        let key = null;
        if (m.groupId) {
          key = "g_" + m.groupId;
        } else {
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
/* ---------- Bottom nav: Chats / Calls / Status ---------- */
function switchBottomNav(tab) {
  currentTab = tab;
  // Order: Chats · Status · Calls
  ["chats", "status", "calls"].forEach(t => {
    const nav = document.getElementById("nav" + t.charAt(0).toUpperCase() + t.slice(1));
    if (nav) nav.classList.toggle("active", t === tab);
  });

  const views = {
    chats: document.getElementById("viewChats"),
    status: document.getElementById("viewStatus"),
    calls: document.getElementById("viewCalls"),
    contacts: document.getElementById("viewContacts")
  };
  Object.keys(views).forEach(k => {
    if (!views[k]) return;
    const show = k === tab;
    views[k].classList.toggle("hidden", !show);
    views[k].style.display = show ? "flex" : "none";
  });

  const filterBar = document.getElementById("filterBar");
  if (filterBar) filterBar.style.display = tab === "chats" ? "flex" : "none";

  const title = document.getElementById("headerTitle");
  if (title) title.innerText = tab === "chats" ? "Easy Talkers" : tab === "status" ? "Status" : tab === "calls" ? "Calls" : "Contacts";

  const search = document.getElementById("searchInput");
  if (search) {
    search.placeholder = tab === "chats" ? "Search chats…" : tab === "status" ? "Search status…" : tab === "calls" ? "Search calls…" : tab === "contacts" ? "Search contacts…" : "Search…";
    search.value = "";
  }

  renderCurrentTab();
}

function switchTab(tab) {
  // compatibility: map old "contacts" calls to bottom nav
  if (tab === "contacts") {
    currentTab = "contacts";
    switchBottomNav("contacts");
    // force show contacts view
    ["viewChats","viewCalls","viewStatus"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.add("hidden"); el.style.display = "none"; }
    });
    const vc = document.getElementById("viewContacts");
    if (vc) { vc.classList.remove("hidden"); vc.style.display = "flex"; }
    const filterBar = document.getElementById("filterBar");
    if (filterBar) filterBar.style.display = "none";
    document.getElementById("headerTitle").innerText = "Contacts";
    renderContactsList();
    return;
  }
  switchBottomNav(tab);
}

function setChatFilter(f) {
  chatFilter = f;
  document.querySelectorAll(".filter-chip").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === f);
  });
  renderChatList();
}

function renderCurrentTab() {
  if (currentTab === "chats") renderChatList();
  else if (currentTab === "status") renderStatusPage();
  else if (currentTab === "calls") renderCallsList();
  else if (currentTab === "contacts") renderContactsList();
}

function onSearch() {
  renderCurrentTab();
}

function toggleFavorite(key) {
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  localStorage.setItem("et_favorites", JSON.stringify([...favorites]));
  renderChatList();
  showToast(favorites.has(key) ? "Added to favorites" : "Removed from favorites");
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

  // Apply top filter: All / Unread / Favorites / Groups
  let filtered = items;
  if (chatFilter === "unread") {
    filtered = items.filter(it => (it.unread || 0) > 0);
  } else if (chatFilter === "favorites") {
    filtered = items.filter(it => {
      const key = it.type === "group" ? "g_" + it.id : it.id;
      return favorites.has(key);
    });
  } else if (chatFilter === "groups") {
    filtered = items.filter(it => it.type === "group");
  }

  // Sort by most recent activity (old chats still appear)
  filtered.sort((a, b) => (b.time || 0) - (a.time || 0));

  // Bottom nav badge for unread
  const totalUnread = items.reduce((s, it) => s + (it.unread || 0), 0);
  const navChats = document.getElementById("navChats");
  if (navChats && totalUnread > 0) {
    navChats.querySelector(".nav-label").innerHTML = `Chats <span style="background:#00a884;color:#fff;border-radius:8px;padding:0 5px;font-size:10px">${totalUnread > 99 ? "99+" : totalUnread}</span>`;
  } else if (navChats) {
    navChats.querySelector(".nav-label").innerText = "Chats";
  }

  if (!filtered.length) {
    const emptyMsg = chatFilter === "unread" ? "No unread chats" :
      chatFilter === "favorites" ? "No favorite chats yet" :
      chatFilter === "groups" ? "No groups yet" : "No chats yet";
    list.innerHTML = `<div style="padding:48px 24px;text-align:center;color:#667781">
      <div style="font-size:40px;margin-bottom:12px">💬</div>
      <p style="font-weight:600;color:#111b21;margin-bottom:6px">${emptyMsg}</p>
      <p style="font-size:13px;margin-bottom:16px">Start a conversation from Contacts</p>
      <button class="btn btn-green" style="width:auto;padding:10px 22px" onclick="switchTab('contacts')">Go to Contacts</button>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(it => {
    const key = it.type === "group" ? "g_" + it.id : it.id;
    const isActive = (it.type === "user" && chattingWith?.uid === it.id) ||
                     (it.type === "group" && chattingGroup?.id === it.id);
    const initial = (it.name || "U")[0].toUpperCase();
    const avatar = it.photoURL
      ? `<img src="${escapeHtml(it.photoURL)}" alt="">`
      : initial;
    const online = it.online ? `<span class="online-dot"></span>` : "";
    const badge = it.unread > 0 ? `<span class="unread-badge">${it.unread > 99 ? "99+" : it.unread}</span>` : "";
    const star = favorites.has(key) ? "⭐" : "";
    const lastPreview = it.lastMsg || (it.time ? " " : "Tap to open");
    return `
      <div class="${it.type === "group" ? "group-item" : "user"} ${isActive ? "active" : ""}"
           onclick="${it.type === "user" ? `openChat('${it.id}')` : `openGroupChat('${it.id}')`}">
        <div class="avatar">${avatar}${online}</div>
        <div class="user-info">
          <div class="user-name-row">
            <span class="user-name">${star}${escapeHtml(it.name)}${it.type === "group" ? " 👥" : ""}</span>
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
  pendingMessages = [];
  currentChatMessages = [];

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

  // ensure mic is visible when input empty
  const msgInput = document.getElementById("msgInput");
  if (msgInput) { msgInput.value = ""; autoResize(msgInput); }
  // close emoji if open
  const ep = document.getElementById("emojiPanel");
  if (ep) ep.classList.add("hidden");

  // listen to messages — use chatId to avoid composite index issues
  const msgsEl = document.getElementById("msgs");
  msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#667781">Loading messages…</div>`;

  const chatId = [me.uid, uid].sort().join("_");
  unsubChat = db.collection("messages")
    .where("chatId", "==", chatId)
    .onSnapshot(snap => {
      const relevant = [];
      snap.forEach(d => relevant.push({ fbId: d.id, ...d.data() }));
      // sort client-side so we don't need orderBy index
      relevant.sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || a.createdAt || 0;
        const tb = b.createdAt?.toMillis?.() || b.createdAt || 0;
        return ta - tb;
      });
      // keep only last 150
      const trimmed = relevant.slice(-150);
      renderMessages(trimmed);
    }, err => {
      console.error("chat load", err);
      // fallback: try participants query without orderBy
      unsubChat = db.collection("messages")
        .where("participants", "array-contains", me.uid)
        .onSnapshot(snap2 => {
          const relevant = [];
          snap2.forEach(d => {
            const m = { fbId: d.id, ...d.data() };
            if ((m.from === me.uid && m.to === uid) || (m.from === uid && m.to === me.uid)) {
              relevant.push(m);
            }
          });
          relevant.sort((a, b) => {
            const ta = a.createdAt?.toMillis?.() || 0;
            const tb = b.createdAt?.toMillis?.() || 0;
            return ta - tb;
          });
          renderMessages(relevant.slice(-150));
        }, err2 => {
          console.error(err2);
          msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#ea0038">Could not load messages. Check Firestore rules/indexes.</div>`;
        });
    });
}

function openGroupChat(gid) {
  const g = groups.find(x => x.id === gid);
  if (!g) return;
  chattingGroup = g;
  chattingWith = null;
  if (unsubChat) unsubChat();
  _seen.clear();
  pendingMessages = [];
  currentChatMessages = [];

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
    .onSnapshot(snap => {
      const relevant = [];
      snap.forEach(d => relevant.push({ fbId: d.id, ...d.data() }));
      relevant.sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || 0;
        const tb = b.createdAt?.toMillis?.() || 0;
        return ta - tb;
      });
      renderMessages(relevant.slice(-150));
    }, err => {
      console.error(err);
      msgsEl.innerHTML = `<div style="text-align:center;padding:20px;color:#ea0038">Could not load group messages</div>`;
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

function renderMessages(serverMsgs) {
  const el = document.getElementById("msgs");
  if (!el) return;

  // Keep last server list
  if (Array.isArray(serverMsgs)) {
    currentChatMessages = serverMsgs;
  }

  // Merge server + pending optimistic messages
  // Remove pending items that already appear on the server (matched by localId or text+from near time)
  const serverLocalIds = new Set(currentChatMessages.map(m => m.localId).filter(Boolean));
  const stillPending = pendingMessages.filter(p => !serverLocalIds.has(p.localId));
  // Also drop pending if a server msg has same text from me within last 30s
  const filteredPending = stillPending.filter(p => {
    return !currentChatMessages.some(s =>
      s.from === p.from &&
      s.text === p.text &&
      Math.abs((s.createdAt?.toMillis?.() || Date.now()) - (p.createdAt?.getTime?.() || p.createdAt || 0)) < 30000
    );
  });
  pendingMessages = filteredPending;

  const combined = [...currentChatMessages, ...pendingMessages];

  // Deduplicate within this batch
  const seenKeys = new Set();
  const unique = [];
  combined.forEach(m => {
    const k = msgKey(m);
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    unique.push(m);
  });

  // Sort by time
  unique.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || a.createdAt?.getTime?.() || a.createdAt || 0;
    const tb = b.createdAt?.toMillis?.() || b.createdAt?.getTime?.() || b.createdAt || 0;
    return ta - tb;
  });

  let html = "";
  let lastDay = "";

  unique.forEach(m => {
    const isOut = m.from === me.uid;
    let day = "";
    try {
      day = m.createdAt?.toDate ? m.createdAt.toDate().toDateString()
        : (m.createdAt instanceof Date ? m.createdAt.toDateString() : "");
    } catch (_) {}
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

    const ticks = isOut ? `<span class="ticks">${m.read ? "✓✓" : (m.pending ? "🕐" : "✓")}</span>` : "";
    html += `
      <div class="bubble ${isOut ? "out" : "in"}" data-id="${escapeHtml(String(m.fbId || m.localId || ""))}">
        ${!isOut && chattingGroup ? `<div style="font-size:12px;color:#00a884;font-weight:600;margin-bottom:2px">${escapeHtml(m.fromName || "")}</div>` : ""}
        ${content}
        <div class="meta">${formatTime(m.createdAt) || "now"} ${ticks}</div>
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

  // Optimistic UI — show immediately, stays until server confirms
  const optimistic = {
    ...base,
    createdAt: new Date(),
    fbId: localId,
    localId,
    pending: true
  };
  pendingMessages.push(optimistic);
  renderMessages(currentChatMessages); // re-render with pending included

  try {
    if (chattingWith) {
      const chatId = [me.uid, chattingWith.uid].sort().join("_");
      await db.collection("messages").add({
        ...base,
        to: chattingWith.uid,
        chatId,
        participants: [me.uid, chattingWith.uid].sort()
      });
      const key = chattingWith.uid;
      unreadMap[key] = { lastText: text, lastAt: Date.now(), count: 0 };
      recentChats[key] = { lastText: text, lastAt: Date.now(), count: 0 };
    } else if (chattingGroup) {
      await db.collection("messages").add({
        ...base,
        groupId: chattingGroup.id,
        chatId: "g_" + chattingGroup.id,
        participants: chattingGroup.members || []
      });
      const key = "g_" + chattingGroup.id;
      unreadMap[key] = { lastText: text, lastAt: Date.now(), count: 0 };
      recentChats[key] = { lastText: text, lastAt: Date.now(), count: 0 };
    }
    localStorage.setItem("et_unread", JSON.stringify(unreadMap));
    localStorage.setItem("et_recent", JSON.stringify(recentChats));
    renderChatList();
    // Snapshot will arrive shortly and replace pending with real message
  } catch (e) {
    // Remove failed optimistic message
    pendingMessages = pendingMessages.filter(p => p.localId !== localId);
    renderMessages(currentChatMessages);
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
      payload.chatId = [me.uid, chattingWith.uid].sort().join("_");
      payload.participants = [me.uid, chattingWith.uid].sort();
    } else {
      payload.groupId = chattingGroup.id;
      payload.chatId = "g_" + chattingGroup.id;
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
function getSupportedMime() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/aac"
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function toggleRecord() {
  // Must be in a chat
  if (!chattingWith && !chattingGroup) {
    showToast("Open a chat first to send voice notes");
    return;
  }
  if (isRecording) {
    stopRecording();
    return;
  }

  // Secure context check (HTTPS or localhost)
  if (!window.isSecureContext && location.hostname !== "localhost") {
    showToast("Voice notes need HTTPS. Open the site via https://");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("This browser does not support voice recording");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    showToast("MediaRecorder not supported on this browser");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const mime = getSupportedMime();
    const options = mime ? { mimeType: mime } : undefined;
    mediaRecorder = options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
    audioChunks = [];
    const usedMime = mediaRecorder.mimeType || mime || "audio/webm";

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onerror = e => {
      console.error("MediaRecorder error", e);
      showToast("Recording error");
      cancelRecording();
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (!audioChunks.length) {
        showToast("No audio captured — try again");
        return;
      }
      const blob = new Blob(audioChunks, { type: usedMime });
      if (blob.size < 100) {
        showToast("Recording too short");
        return;
      }
      showToast("Sending voice note…");
      try {
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
          payload.chatId = [me.uid, chattingWith.uid].sort().join("_");
          payload.participants = [me.uid, chattingWith.uid].sort();
        } else {
          payload.groupId = chattingGroup.id;
          payload.chatId = "g_" + chattingGroup.id;
          payload.participants = chattingGroup.members || [];
        }
        // optimistic
        const localId = "local_audio_" + Date.now();
        pendingMessages.push({
          ...payload,
          localId,
          fbId: localId,
          createdAt: new Date(),
          pending: true
        });
        renderMessages(currentChatMessages);
        await db.collection("messages").add(payload);
        showToast("Voice note sent");
      } catch (err) {
        console.error(err);
        showToast("Failed to send voice note");
      }
    };

    mediaRecorder.start(250); // timeslice helps some mobile browsers
    isRecording = true;
    recStart = Date.now();
    document.getElementById("recordingBar").style.display = "flex";
    document.getElementById("msgInput").style.display = "none";
    document.getElementById("sendBtn").style.display = "none";
    const mic = document.getElementById("micBtn");
    mic.innerText = "⏹";
    mic.classList.add("recording");
    // hide emoji while recording
    const ep = document.getElementById("emojiPanel");
    if (ep) ep.classList.add("hidden");
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      document.getElementById("recTime").innerText =
        Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 250);
  } catch (e) {
    console.error(e);
    const name = e.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      showToast("Microphone permission denied — allow mic in browser settings");
    } else if (name === "NotFoundError") {
      showToast("No microphone found");
    } else {
      showToast("Could not start recording: " + (e.message || name || "error"));
    }
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    try { mediaRecorder.stop(); } catch (_) {}
    isRecording = false;
    clearInterval(recTimer);
    document.getElementById("recordingBar").style.display = "none";
    document.getElementById("msgInput").style.display = "block";
    const mic = document.getElementById("micBtn");
    mic.innerText = "🎤";
    mic.classList.remove("recording");
    autoResize(document.getElementById("msgInput"));
  }
}

function cancelRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.onstop = null;
    try { mediaRecorder.stop(); } catch (_) {}
    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    isRecording = false;
    clearInterval(recTimer);
    document.getElementById("recordingBar").style.display = "none";
    document.getElementById("msgInput").style.display = "block";
    const mic = document.getElementById("micBtn");
    mic.innerText = "🎤";
    mic.classList.remove("recording");
    autoResize(document.getElementById("msgInput"));
    showToast("Recording cancelled");
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
    if (currentTab === "status") renderStatusPage();
  } catch (e) {
    showToast("Failed to post status");
    console.error(e);
  }
}

/* ---------- Text Status ---------- */
function openTextStatus() {
  statusBgColor = "#00a884";
  document.getElementById("textStatusInput").value = "";
  document.getElementById("textStatusPreview").style.background = statusBgColor;
  document.getElementById("textStatusPreview").innerText = "Type your status…";
  document.getElementById("textStatusModal").classList.add("active");
}
function closeTextStatus() {
  document.getElementById("textStatusModal").classList.remove("active");
}
function setStatusBg(color) {
  statusBgColor = color;
  document.getElementById("textStatusPreview").style.background = color;
}
function previewTextStatus() {
  const t = document.getElementById("textStatusInput").value.trim();
  document.getElementById("textStatusPreview").innerText = t || "Type your status…";
}
async function postTextStatus() {
  const text = document.getElementById("textStatusInput").value.trim();
  if (!text) { showToast("Write something first"); return; }
  try {
    await db.collection("statuses").add({
      from: me.uid,
      fromName: me.name,
      photoURL: me.photoURL || "",
      text,
      bgColor: statusBgColor,
      type: "text",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      viewers: []
    });
    showToast("Status posted");
    closeTextStatus();
    if (currentTab === "status") renderStatusPage();
  } catch (e) {
    showToast("Failed to post");
    console.error(e);
  }
}

/* ---------- Full Status page (bottom tab) ---------- */
function renderStatusPage() {
  const el = document.getElementById("statusFullSection");
  if (!el || !me) return;
  const byUser = getStatusesByUser();
  const myStatuses = byUser.get(me.uid) || [];
  const others = [...byUser.entries()].filter(([uid]) => uid !== me.uid);

  let html = `<div class="status-section-title">My status</div>`;
  if (myStatuses.length) {
    const last = myStatuses[myStatuses.length - 1];
    const viewed = myStatuses.every(s => viewedStatuses.has(s.id));
    const preview = last.image
      ? `<img src="${escapeHtml(last.image)}">`
      : last.text
        ? `<span style="font-size:14px;padding:4px">${escapeHtml(last.text.slice(0, 20))}</span>`
        : (me.name || "Y")[0];
    html += `
      <div class="status-row" onclick="openStatusViewer('${me.uid}')">
        <div class="statusDot has-status ${viewed ? "viewed" : ""}">${preview}</div>
        <div class="status-row-info">
          <b>My status</b>
          <span>${myStatuses.length} update${myStatuses.length > 1 ? "s" : ""} · ${timeAgo(last.createdAt)}</span>
        </div>
      </div>`;
  } else {
    html += `
      <div class="status-row" onclick="openTextStatus()">
        <div class="statusDot" style="background:#fff;color:#00a884;border:2.5px dashed #00a884;font-size:26px">+</div>
        <div class="status-row-info">
          <b>My status</b>
          <span>Tap to add status update</span>
        </div>
      </div>`;
  }

  html += `
    <div style="display:flex;gap:10px;padding:8px 16px 16px">
      <button class="btn btn-green" style="flex:1;padding:10px" onclick="openTextStatus()">✏️ Text</button>
      <button class="btn btn-dark" style="flex:1;padding:10px" onclick="document.getElementById('statusPicInput').click()">📷 Photo</button>
    </div>`;

  html += `<div class="status-section-title">Recent updates</div>`;
  if (!others.length) {
    html += `<div style="padding:24px;text-align:center;color:#888;font-size:14px">No status from contacts yet</div>`;
  } else {
    others.forEach(([uid, arr]) => {
      const last = arr[arr.length - 1];
      const u = allUsers.find(x => x.uid === uid);
      const name = last.fromName || u?.name || "User";
      const allViewed = arr.every(s => viewedStatuses.has(s.id));
      const preview = last.image
        ? `<img src="${escapeHtml(last.image)}">`
        : last.text
          ? `<span style="font-size:12px;padding:2px">${escapeHtml(last.text.slice(0, 12))}</span>`
          : name[0].toUpperCase();
      html += `
        <div class="status-row" onclick="openStatusViewer('${uid}')">
          <div class="statusDot has-status ${allViewed ? "viewed" : ""}">${preview}</div>
          <div class="status-row-info">
            <b>${escapeHtml(name)}</b>
            <span>${timeAgo(last.createdAt)}</span>
          </div>
        </div>`;
    });
  }
  el.innerHTML = html;
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
    content.style.background = "#111";
    content.innerHTML = `<img src="${escapeHtml(s.image)}" alt="status">`;
  } else {
    const bg = s.bgColor || "#00a884";
    content.style.background = bg;
    content.innerHTML = `<div class="status-text" style="color:#fff;font-size:24px;font-weight:600;padding:40px;text-align:center;line-height:1.4">${escapeHtml(s.text || "")}</div>`;
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

/* ---------- Emoji picker ---------- */
const EMOJI_CATS = {
  smileys: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","😮‍💨","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬"],
  gestures: ["👍","👎","👊","✊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","👇","☝️","✋","🤚","🖐","🖖","👋","💪","🦾","🖕","✍️","🤳","💅","🦵","🦶"],
  hearts: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","♥️","😍","🥰","😘","😻","💑","👩‍❤️‍👨","👨‍❤️‍👨","👩‍❤️‍👩","💋","💌"],
  objects: ["🎉","🎊","🎈","🎁","🏆","🥇","🥈","🥉","⚽","🏀","🏈","⚾","🎾","🏐","🎱","🏓","🏸","🥅","🎯","🎮","🕹️","🎲","🧩","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🔥","⭐","🌟","✨","💫","⚡","💥","💢","💦","💨","🌈","☀️","🌙","⭐","🌍","🍕","🍔","🍟","🌮","🍣","🍩","🍪","🎂","☕","🍺","🍻","🥂","🍷"]
};

function toggleEmoji() {
  const panel = document.getElementById("emojiPanel");
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) {
    panel.classList.remove("hidden");
    showEmojiCat("smileys");
  } else {
    panel.classList.add("hidden");
  }
}

function showEmojiCat(cat) {
  document.querySelectorAll(".emoji-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.cat === cat);
  });
  const grid = document.getElementById("emojiGrid");
  if (!grid) return;
  const list = EMOJI_CATS[cat] || EMOJI_CATS.smileys;
  grid.innerHTML = list.map(e =>
    `<button type="button" onclick="insertEmoji('${e}')">${e}</button>`
  ).join("");
}

function insertEmoji(emoji) {
  const input = document.getElementById("msgInput");
  if (!input) return;
  const start = input.selectionStart || input.value.length;
  const end = input.selectionEnd || input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = before + emoji + after;
  const pos = start + emoji.length;
  input.focus();
  input.setSelectionRange(pos, pos);
  autoResize(input);
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

/* ============================================================
   WEBRTC CALLING (voice + video) via Firestore signaling
   ============================================================ */
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let pc = null;                 // RTCPeerConnection
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let currentCallPeer = null;    // other user uid
let isVideoCall = false;
let isCaller = false;
let callMuted = false;
let callCamOff = false;
let callTimerInterval = null;
let callSeconds = 0;
let unsubCall = null;
let unsubIncoming = null;
let callHistory = [];

try { callHistory = JSON.parse(localStorage.getItem("et_calls") || "[]"); } catch (_) {}

function saveCallHistory() {
  // keep last 50
  callHistory = callHistory.slice(0, 50);
  localStorage.setItem("et_calls", JSON.stringify(callHistory));
}

function addCallHistory(entry) {
  callHistory.unshift(entry);
  saveCallHistory();
  if (currentTab === "calls") renderCallsList();
}

function renderCallsList() {
  const list = document.getElementById("callsList");
  if (!list) return;
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase();

  // Also show contacts for quick call
  let html = "";

  // Recent calls
  const filtered = callHistory.filter(c => {
    if (!q) return true;
    const u = allUsers.find(x => x.uid === c.peerUid);
    return (c.peerName || u?.name || "").toLowerCase().includes(q);
  });

  if (filtered.length) {
    html += `<div class="status-section-title">Recent</div>`;
    filtered.forEach(c => {
      const u = allUsers.find(x => x.uid === c.peerUid);
      const name = c.peerName || u?.name || "User";
      const pic = u?.photoURL || c.photoURL || "";
      const dirClass = c.missed ? "missed" : (c.outgoing ? "out" : "in");
      const dirIcon = c.missed ? "📵" : (c.outgoing ? "↗" : "↙");
      const typeIcon = c.video ? "📹" : "📞";
      const when = timeAgo(c.at);
      html += `
        <div class="call-item">
          <div class="avatar" onclick="openChat('${c.peerUid}')">${pic ? `<img src="${escapeHtml(pic)}">` : name[0].toUpperCase()}</div>
          <div class="call-meta" onclick="openChat('${c.peerUid}')">
            <b>${escapeHtml(name)}</b>
            <span><span class="call-dir ${dirClass}">${dirIcon}</span> ${typeIcon} ${when}${c.duration ? " · " + formatDuration(c.duration) : ""}</span>
          </div>
          <button class="call-again" title="Call again" onclick="startCallTo('${c.peerUid}', ${!!c.video})">${c.video ? "📹" : "📞"}</button>
        </div>`;
    });
  }

  // Quick dial contacts
  html += `<div class="status-section-title">Contacts</div>`;
  const contacts = allUsers.filter(u => u.uid !== me?.uid)
    .filter(u => !q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  if (!contacts.length && !filtered.length) {
    html = `<div style="padding:48px 24px;text-align:center;color:#667781">
      <div style="font-size:40px;margin-bottom:12px">📞</div>
      <p style="font-weight:600;color:#111b21;margin-bottom:6px">No calls yet</p>
      <p style="font-size:13px">Start a voice or video call from a chat or contact</p>
    </div>`;
  } else {
    contacts.forEach(u => {
      html += `
        <div class="call-item">
          <div class="avatar">${u.photoURL ? `<img src="${escapeHtml(u.photoURL)}">` : (u.name || "U")[0].toUpperCase()}${u.online ? '<span class="online-dot"></span>' : ""}</div>
          <div class="call-meta">
            <b>${escapeHtml(u.name || "User")}</b>
            <span>${u.online ? "Online" : "last seen " + timeAgo(u.lastSeen)}</span>
          </div>
          <button class="call-again" title="Voice call" onclick="startCallTo('${u.uid}', false)">📞</button>
          <button class="call-again" title="Video call" onclick="startCallTo('${u.uid}', true)">📹</button>
        </div>`;
    });
  }

  list.innerHTML = html;
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

/* ----- Start outgoing call ----- */
async function startCall(video) {
  if (!chattingWith) {
    showToast("Open a chat with someone first");
    return;
  }
  if (chattingGroup) {
    showToast("Group calls not supported yet — call someone from Contacts");
    return;
  }
  await startCallTo(chattingWith.uid, video);
}

async function startCallTo(peerUid, video) {
  if (currentCallId) {
    showToast("Already in a call");
    return;
  }
  const peer = allUsers.find(u => u.uid === peerUid);
  if (!peer) { showToast("User not found"); return; }

  isVideoCall = !!video;
  isCaller = true;
  currentCallPeer = peerUid;
  callMuted = false;
  callCamOff = false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall
    });
  } catch (e) {
    showToast("Microphone/camera permission denied");
    console.error(e);
    return;
  }

  // Create call doc
  const callRef = db.collection("calls").doc();
  currentCallId = callRef.id;
  await callRef.set({
    id: currentCallId,
    from: me.uid,
    fromName: me.name,
    fromPhoto: me.photoURL || "",
    to: peerUid,
    toName: peer.name || "User",
    video: isVideoCall,
    status: "ringing",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  showCallUI(peer, "Calling…", false);
  setupPeerConnection();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  attachLocalVideo();

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await callRef.update({ offer: { type: offer.type, sdp: offer.sdp } });

  // Listen for answer + remote ICE
  unsubCall = callRef.onSnapshot(async snap => {
    const data = snap.data();
    if (!data) return;
    if (data.status === "ended" || data.status === "rejected") {
      cleanupCall(data.status === "rejected" ? "Call declined" : "Call ended");
      return;
    }
    if (data.answer && pc && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      document.getElementById("callStatusText").innerText = "Connected";
      startCallTimer();
    }
  });

  // ICE candidates from callee
  callRef.collection("calleeCandidates").onSnapshot(snap => {
    snap.docChanges().forEach(async change => {
      if (change.type === "added" && pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch (_) {}
      }
    });
  });

  // Timeout if no answer in 45s
  setTimeout(() => {
    if (currentCallId === callRef.id && document.getElementById("callStatusText")?.innerText === "Calling…") {
      endCall(true);
      showToast("No answer");
    }
  }, 45000);

  addCallHistory({
    peerUid,
    peerName: peer.name,
    photoURL: peer.photoURL || "",
    outgoing: true,
    video: isVideoCall,
    missed: false,
    at: Date.now(),
    duration: 0
  });
}

/* ----- Incoming call listener ----- */
function listenForIncomingCalls() {
  if (!me || unsubIncoming) return;
  unsubIncoming = db.collection("calls")
    .where("to", "==", me.uid)
    .where("status", "==", "ringing")
    .onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== "added") return;
        const data = change.doc.data();
        if (currentCallId) return; // already in a call
        // show incoming
        currentCallId = change.doc.id;
        currentCallPeer = data.from;
        isVideoCall = !!data.video;
        isCaller = false;
        const peer = allUsers.find(u => u.uid === data.from) || {
          uid: data.from,
          name: data.fromName || "User",
          photoURL: data.fromPhoto || ""
        };
        showCallUI(peer, "Incoming " + (isVideoCall ? "video" : "voice") + " call…", true);
        // ring sound could go here
      });
    }, err => console.error("incoming calls", err));
}

/* ----- Accept incoming ----- */
async function acceptCall() {
  if (!currentCallId || isCaller) return;
  const callRef = db.collection("calls").doc(currentCallId);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall
    });
  } catch (e) {
    showToast("Permission denied");
    rejectCall();
    return;
  }

  document.getElementById("incomingActions").style.display = "none";
  document.getElementById("callActions").style.display = "flex";
  document.getElementById("callStatusText").innerText = "Connecting…";

  setupPeerConnection();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  attachLocalVideo();

  const snap = await callRef.get();
  const data = snap.data();
  if (!data?.offer) {
    cleanupCall("Call expired");
    return;
  }

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await callRef.update({
    answer: { type: answer.type, sdp: answer.sdp },
    status: "active"
  });

  // ICE from caller
  callRef.collection("callerCandidates").onSnapshot(s => {
    s.docChanges().forEach(async change => {
      if (change.type === "added" && pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(change.doc.data())); } catch (_) {}
      }
    });
  });

  unsubCall = callRef.onSnapshot(s => {
    const d = s.data();
    if (d && (d.status === "ended" || d.status === "rejected")) {
      cleanupCall("Call ended");
    }
  });

  document.getElementById("callStatusText").innerText = "Connected";
  startCallTimer();

  const peer = allUsers.find(u => u.uid === currentCallPeer);
  addCallHistory({
    peerUid: currentCallPeer,
    peerName: peer?.name || data.fromName,
    photoURL: peer?.photoURL || data.fromPhoto || "",
    outgoing: false,
    video: isVideoCall,
    missed: false,
    at: Date.now(),
    duration: 0
  });
}

async function rejectCall() {
  if (!currentCallId) return;
  try {
    await db.collection("calls").doc(currentCallId).update({ status: "rejected" });
  } catch (_) {}
  const peer = allUsers.find(u => u.uid === currentCallPeer);
  addCallHistory({
    peerUid: currentCallPeer,
    peerName: peer?.name || "User",
    photoURL: peer?.photoURL || "",
    outgoing: false,
    video: isVideoCall,
    missed: true,
    at: Date.now(),
    duration: 0
  });
  cleanupCall("Call declined");
}

async function endCall(missed) {
  if (!currentCallId) {
    cleanupCall();
    return;
  }
  try {
    await db.collection("calls").doc(currentCallId).update({ status: "ended" });
  } catch (_) {}
  // update last history duration
  if (callHistory[0] && callHistory[0].peerUid === currentCallPeer) {
    callHistory[0].duration = callSeconds;
    if (missed) callHistory[0].missed = true;
    saveCallHistory();
  }
  cleanupCall("Call ended");
}

function cleanupCall(msg) {
  if (unsubCall) { try { unsubCall(); } catch (_) {} unsubCall = null; }
  if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  remoteStream = null;
  const rv = document.getElementById("remoteVideo");
  const lv = document.getElementById("localVideo");
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  stopCallTimer();
  currentCallId = null;
  currentCallPeer = null;
  isCaller = false;
  document.getElementById("callOverlay").classList.add("hidden");
  if (msg) showToast(msg);
}

function setupPeerConnection() {
  pc = new RTCPeerConnection(ICE_SERVERS);
  remoteStream = new MediaStream();
  document.getElementById("remoteVideo").srcObject = remoteStream;

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate || !currentCallId) return;
    const col = isCaller ? "callerCandidates" : "calleeCandidates";
    db.collection("calls").doc(currentCallId).collection(col).add(event.candidate.toJSON()).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      document.getElementById("callStatusText").innerText = "Connected";
      startCallTimer();
    } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      // allow brief disconnect; end if failed
      if (pc.connectionState === "failed") endCall();
    }
  };
}

function attachLocalVideo() {
  const lv = document.getElementById("localVideo");
  if (!lv) return;
  lv.srcObject = localStream;
  if (isVideoCall) {
    lv.classList.remove("audio-only");
  } else {
    lv.classList.add("audio-only");
  }
}

function showCallUI(peer, statusText, incoming) {
  const overlay = document.getElementById("callOverlay");
  overlay.classList.remove("hidden");
  document.getElementById("callName").innerText = peer.name || "User";
  document.getElementById("callStatusText").innerText = statusText;
  document.getElementById("callAvatar").innerHTML = peer.photoURL
    ? `<img src="${escapeHtml(peer.photoURL)}">`
    : (peer.name || "U")[0].toUpperCase();
  document.getElementById("callTimer").style.display = "none";
  document.getElementById("callActions").style.display = incoming ? "none" : "flex";
  document.getElementById("incomingActions").style.display = incoming ? "flex" : "none";
  document.getElementById("btnCamToggle").style.display = isVideoCall ? "flex" : "none";
  // hide remote video bg for audio
  document.getElementById("remoteVideo").style.opacity = isVideoCall ? "1" : "0";
}

function toggleMute() {
  if (!localStream) return;
  callMuted = !callMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !callMuted; });
  const btn = document.getElementById("btnMute");
  btn.classList.toggle("active", callMuted);
  btn.innerText = callMuted ? "🔈" : "🔇";
}

function toggleCamera() {
  if (!localStream || !isVideoCall) return;
  callCamOff = !callCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !callCamOff; });
  const btn = document.getElementById("btnCamToggle");
  btn.classList.toggle("active", callCamOff);
}

function startCallTimer() {
  if (callTimerInterval) return;
  callSeconds = 0;
  const el = document.getElementById("callTimer");
  el.style.display = "block";
  el.innerText = "00:00";
  callTimerInterval = setInterval(() => {
    callSeconds++;
    el.innerText = formatDuration(callSeconds);
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callSeconds = 0;
}

// Hook incoming listener when user signs in
const _origAuthHandler = auth.onAuthStateChanged;
// We already have onAuthStateChanged — patch listen into startListeners
const _origStartListeners = startListeners;
startListeners = function () {
  _origStartListeners();
  listenForIncomingCalls();
};
