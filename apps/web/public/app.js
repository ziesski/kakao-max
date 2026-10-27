// KakaoTalk Web client — Full PC KakaoTalk experience over REST + SSE.
const $ = (id) => document.getElementById(id);

let me = null;
let chats = [];
let friendsMap = new Map(); // userId -> { userId, name, img, statusMsg }
let favoritesSet = new Set(JSON.parse(localStorage.getItem('kakaoweb_favs') || '[]'));
let pinnedSet = new Set(JSON.parse(localStorage.getItem('kakaoweb_pinned') || '[]'));
let mutedSet = new Set(JSON.parse(localStorage.getItem('kakaoweb_muted') || '[]'));
let activeTab = 'chats'; // 'friends' | 'chats' | 'settings'
let searchQuery = '';
let friendSearchQuery = '';
let activeFilter = 'all'; // 'all' | 'unread' | 'group' | 'memo'
let activeChatId = null;
let currentChatMembers = {}; // userId -> { name, img }
let currentMessages = [];
let currentNotice = null;
let inChatSearchResults = [];
let currentSearchIndex = -1;
let quotedReplyTarget = null; // { authorName, text, logId, userId }
let pendingAttachment = null; // { file, dataUrl, name, size }
let soundEnabled = localStorage.getItem('kakaoweb_sound') !== 'false';
let soundType = localStorage.getItem('kakaoweb_sound_type') || 'katalk';
let sendWithEnter = localStorage.getItem('kakaoweb_sendkey') !== 'shift';
let keywordAlerts = JSON.parse(localStorage.getItem('kakaoweb_keywords') || '[]');
let autoLock = localStorage.getItem('kakaoweb_autolock') === 'true';
let desktopNotify = localStorage.getItem('kakaoweb_desktop_notify') === 'true';
let lockCode = localStorage.getItem('kakaoweb_lock_code') || '1234';

// ----------------------------------------------------------------------------
// API Helper
// ----------------------------------------------------------------------------
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.error || res.statusText;
    throw new Error(err.approvalUrl ? `${message}\n승인 링크: ${err.approvalUrl}` : message);
  }
  return res.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function linkify(text) {
  const escaped = esc(text);
  const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
  return escaped.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

// ----------------------------------------------------------------------------
// Audio Chime ("카톡!" notification sound using Web Audio API)
// ----------------------------------------------------------------------------
// Notification chimes, synthesized with the Web Audio API. Each preset is a small sequence of
// [frequencyHz, startOffsetSec, durationSec] notes.
const CHIME_PRESETS = {
  katalk: { wave: 'triangle', notes: [[587.33, 0, 0.15], [880, 0.12, 0.23]] },
  watsong: { wave: 'triangle', notes: [[784, 0, 0.12], [988, 0.1, 0.12], [1319, 0.2, 0.26]] },
  demure: { wave: 'sine', notes: [[1047, 0, 0.1], [784, 0.11, 0.2]] }
};

function playChime(type) {
  const preset = CHIME_PRESETS[type];
  if (!preset) return; // 'none' or unknown → silent
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (const [freq, offset, dur] of preset.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = preset.wave;
      osc.frequency.setValueAtTime(freq, now + offset);
      gain.gain.setValueAtTime(0.22, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + dur);
    }
  } catch {
    /* ignore audio autoplay constraints */
  }
}

function playKatalkChime() {
  if (!soundEnabled) return;
  playChime(soundType);
}

// ----------------------------------------------------------------------------
// Korean Initial Consonants (초성 추출)
// ----------------------------------------------------------------------------
const CHOSUNG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];

function getChosung(str) {
  if (!str) return '#';
  const ch = str.trim().charAt(0);
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const uni = code - 0xac00;
    const idx = Math.floor(uni / 588);
    return CHOSUNG[idx] || '#';
  }
  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  return '#';
}

// KakaoTalk message types
const TYPE_LABEL = {
  2: '📷 사진',
  3: '🎞 동영상',
  5: '🎤 음성메시지',
  6: '🔗 링크',
  12: '😀 이모티콘',
  13: '😀 이모티콘',
  18: '📎 파일',
  20: '😀 이모티콘',
  23: '😀 이모티콘',
  24: '🎤 음성메시지',
  25: '😀 이모티콘',
  51: '📞 보이스톡',
  52: '📞 페이스톡',
  71: '📅 일정'
};

function formatBodyPreview(type, text) {
  if (type === 1 && text) return text;
  if (text && !text.trim().startsWith('{')) return text;
  return TYPE_LABEL[type] || (text ? '[시스템 메시지]' : '[메시지]');
}

function parseAttachment(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t.startsWith('{')) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  return null;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function titleOf(c) {
  if (!c) return '';
  if (/memo/i.test(c.type)) return '나와의 채팅';
  return c.title || `${c.type || '채팅'} · ${String(c.id).slice(-6)}`;
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 2);
}

function avatarHtml(name, img, cls = '') {
  if (img) {
    return `<span class="avatar ${cls}" style="background-image:url('${esc(img)}')"></span>`;
  }
  const hue = [...String(name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return `<span class="avatar ${cls}" style="background:hsl(${hue} 45% 72%)">${esc(initialsOf(name))}</span>`;
}

function formatChatTime(timestampSeconds) {
  if (!timestampSeconds) return '';
  const date = new Date(timestampSeconds * 1000);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const period = hours < 12 ? '오전' : '오후';
    const displayHours = hours % 12 || 12;
    return `${period} ${displayHours}:${minutes}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return '어제';
  }
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${m}월 ${d}일`;
}

function formatMessageTime(timestampSeconds) {
  if (!timestampSeconds) return '';
  const date = new Date(timestampSeconds * 1000);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours < 12 ? '오전' : '오후';
  const displayHours = hours % 12 || 12;
  return `${period} ${displayHours}:${minutes}`;
}

function formatDateDivider(timestampSeconds) {
  if (!timestampSeconds) return '';
  const date = new Date(timestampSeconds * 1000);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${days[date.getDay()]}요일`;
}

// ----------------------------------------------------------------------------
// Navigation Rail Controller
// ----------------------------------------------------------------------------
function initNavigation() {
  const tabs = document.querySelectorAll('.nav-item');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });

  $('soundToggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('kakaoweb_sound', soundEnabled ? 'true' : 'false');
    updateSoundUI();
    if (soundEnabled) playKatalkChime();
  });

  $('lockModeBtn').addEventListener('click', () => {
    openLockScreen();
  });

  $('replyCancelBtn')?.addEventListener('click', () => {
    clearQuoteReply();
  });

  $('noticeToggleBtn')?.addEventListener('click', () => {
    $('noticeBanner')?.classList.add('hidden');
  });

  $('openSelfChatBtn')?.addEventListener('click', () => {
    const memo = chats.find((c) => c.type === 'MemoChat');
    if (memo) {
      switchTab('chats');
      selectChat(memo.id);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === '1') {
      e.preventDefault();
      switchTab('friends');
    } else if (e.altKey && e.key === '2') {
      e.preventDefault();
      switchTab('chats');
    } else if (e.altKey && e.key === '3') {
      e.preventDefault();
      switchTab('settings');
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      openLockScreen();
    } else if (e.key === 'Escape') {
      closeAllPopups();
    }
  });

  updateSoundUI();
}

function updateSoundUI() {
  if (soundEnabled) {
    $('soundOnIcon').classList.remove('hidden');
    $('soundOffIcon').classList.add('hidden');
    $('settingSoundCheckbox').checked = true;
  } else {
    $('soundOnIcon').classList.add('hidden');
    $('soundOffIcon').classList.remove('hidden');
    $('settingSoundCheckbox').checked = false;
  }
}

function switchTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });

  $('friendsPanel').classList.toggle('hidden', tabName !== 'friends');
  $('chatsPanel').classList.toggle('hidden', tabName !== 'chats');
  $('settingsPanel').classList.toggle('hidden', tabName !== 'settings');

  if (tabName === 'friends') {
    renderFriends();
  }
}

function setConn(connected, err) {
  const el = $('conn');
  el.className = 'conn-dot ' + (connected ? 'green' : 'red');
  el.title = connected ? 'LOCO 실시간 연결됨 (정상)' : `연결 해제됨: ${err || '재연결 중...'}`;
  $('settingsStatusPill').textContent = connected ? '정상 연결됨' : '연결 끊김';
  $('settingsStatusPill').className = 'status-pill ' + (connected ? 'green' : '');
}

// ----------------------------------------------------------------------------
// Friends Aggregator & Renderer
// ----------------------------------------------------------------------------
let realFriends = [];

async function loadRealFriends() {
  try {
    const res = await fetch('/api/friends?limit=1000');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.friends) && data.friends.length > 0) {
        realFriends = data.friends.map((f) => ({
          userId: String(f.userId),
          name: f.friendNickName || f.nickName || `친구 (${String(f.userId).slice(-4)})`,
          nickName: f.nickName,
          friendNickName: f.friendNickName,
          img: f.profileImageUrl,
          statusMsg: f.statusMessage || '',
          favorite: f.favorite === true
        }));
        realFriends.filter((f) => f.favorite).forEach((f) => favoritesSet.add(f.userId));
        renderFriends();
      }
    }
  } catch (e) {
    console.warn('[friends] could not load real friends:', e);
  }
}

function extractFriendsFromChats() {
  friendsMap.clear();
  if (realFriends.length > 0) {
    realFriends.forEach((f) => friendsMap.set(f.userId, f));
    return;
  }
  chats.forEach((c) => {
    if (c.members) {
      Object.entries(c.members).forEach(([uId, m]) => {
        if (String(uId) === String(me)) return;
        if (!friendsMap.has(uId)) {
          friendsMap.set(uId, {
            userId: uId,
            name: m.name || `친구 (${uId.slice(-4)})`,
            img: m.img,
            statusMsg: ''
          });
        }
      });
    }
  });
}

function toggleFavorite(userId, ev) {
  ev?.stopPropagation();
  if (favoritesSet.has(userId)) {
    favoritesSet.delete(userId);
  } else {
    favoritesSet.add(userId);
  }
  localStorage.setItem('kakaoweb_favs', JSON.stringify([...favoritesSet]));
  renderFriends();
}

function renderFriends() {
  extractFriendsFromChats();
  const query = friendSearchQuery.trim().toLowerCase();
  const allFriends = [...friendsMap.values()].filter((f) => {
    if (!query) return true;
    return f.name.toLowerCase().includes(query);
  });

  // Split Favorites and Regular Friends
  const favs = allFriends.filter((f) => favoritesSet.has(f.userId));
  const regulars = allFriends.filter((f) => !favoritesSet.has(f.userId));

  // Sort alphabetically / Korean
  favs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  regulars.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  $('favCount').textContent = favs.length;
  $('friendCount').textContent = regulars.length;

  $('favSectionDivider').style.display = favs.length > 0 ? 'flex' : 'none';

  // Render Favs
  const favList = $('favList');
  favList.innerHTML = '';
  favs.forEach((f) => {
    favList.appendChild(createFriendItem(f, true));
  });

  // Render Regulars (Grouped by initial consonant)
  const friendList = $('friendList');
  friendList.innerHTML = '';

  let currentLetter = '';
  regulars.forEach((f) => {
    const ch = getChosung(f.name);
    if (ch !== currentLetter) {
      currentLetter = ch;
      const groupHeader = document.createElement('div');
      groupHeader.className = 'section-label';
      groupHeader.textContent = currentLetter;
      friendList.appendChild(groupHeader);
    }
    friendList.appendChild(createFriendItem(f, false));
  });

  // My profile card info
  $('myName').textContent = (currentChatMembers[me]?.name || '나');
  if (currentChatMembers[me]?.img) {
    $('myAvatar').style.backgroundImage = `url('${esc(currentChatMembers[me].img)}')`;
    $('myAvatar').textContent = '';
  }
}

function createFriendItem(f, isFav) {
  const item = document.createElement('div');
  item.className = 'friend-item';
  item.innerHTML = `
    <div class="avatar-wrap">
      ${avatarHtml(f.name, f.img)}
    </div>
    <div class="card-info">
      <span class="card-name">${esc(f.name)}</span>
      ${f.statusMsg ? `<span class="card-status-msg">${esc(f.statusMsg)}</span>` : ''}
    </div>
    <button class="fav-star-btn ${isFav ? 'active' : ''}" title="${isFav ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
      ${isFav ? '★' : '☆'}
    </button>
  `;

  item.querySelector('.fav-star-btn').addEventListener('click', (e) => toggleFavorite(f.userId, e));
  item.addEventListener('click', () => openFriendProfile(f));
  item.addEventListener('dblclick', () => startDirectChatWith(f.userId, f.name));
  return item;
}

function openFriendProfile(f) {
  $('profileModalName').textContent = f.name;
  $('profileModalStatus').textContent = f.statusMsg || '상태메시지가 없습니다.';
  const avWrap = $('profileModalAvatarWrap');
  avWrap.innerHTML = avatarHtml(f.name, f.img, 'large-avatar');

  const favBtn = $('profileFavToggleBtn');
  const isFav = favoritesSet.has(f.userId);
  $('profileFavStar').textContent = isFav ? '★' : '☆';
  $('profileFavLabel').textContent = isFav ? '즐겨찾기 해제' : '즐겨찾기';

  favBtn.onclick = (e) => {
    toggleFavorite(f.userId, e);
    const nowFav = favoritesSet.has(f.userId);
    $('profileFavStar').textContent = nowFav ? '★' : '☆';
    $('profileFavLabel').textContent = nowFav ? '즐겨찾기 해제' : '즐겨찾기';
  };

  $('profileChatBtn').onclick = () => {
    $('friendProfileModal').classList.add('hidden');
    startDirectChatWith(f.userId, f.name);
  };

  $('friendProfileModal').classList.remove('hidden');
}

async function startDirectChatWith(targetUserId, friendName) {
  // 1. Find if direct chat is already in active loaded chats
  const match = chats.find(
    (c) => !c.isGroup && c.members && Object.keys(c.members).includes(String(targetUserId))
  );
  if (match) {
    switchTab('chats');
    openChat(match.id);
    return;
  }

  // 2. Open or create via LOCO CREATE on the server
  try {
    const res = await fetch('/api/friends/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: targetUserId })
    });
    const data = await res.json();
    if (data.ok && data.chatId) {
      if (!chats.find(c => String(c.id) === String(data.chatId))) {
        chats.unshift({
          id: String(data.chatId),
          type: 'DirectChat',
          title: data.title || friendName,
          isGroup: false,
          memberCount: 2,
          unreadCount: 0,
          lastMessage: '',
          maxLogId: '0'
        });
        renderChatList();
      }
      switchTab('chats');
      openChat(data.chatId);
    } else {
      alert(`${friendName}님과의 대화방을 열지 못했습니다: ${data.error || '상태 이상'}`);
    }
  } catch (e) {
    alert(`${friendName}님과의 대화방 연결 실패: ${e.message}`);
  }
}

// ----------------------------------------------------------------------------
// Lock Screen Controller
// ----------------------------------------------------------------------------
function openLockScreen() {
  $('lockScreenOverlay').classList.remove('hidden');
  $('lockInput').value = '';
  $('lockInput').focus();
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function initLockScreen() {
  $('lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = $('lockInput').value.trim();
    const storedHash = localStorage.getItem('kakaoweb_lock_hash');
    // A custom PIN is stored as a SHA-256 hash (never plaintext). Until one is set, the default
    // 1234 unlocks (first-run); once a custom PIN exists, only its hash matches.
    const ok = storedHash ? (await sha256Hex(val)) === storedHash : val === '1234';
    if (ok) {
      $('lockScreenOverlay').classList.add('hidden');
    } else {
      alert('비밀번호가 일치하지 않습니다.');
      $('lockInput').value = '';
      $('lockInput').focus();
    }
  });

  // Auto-lock when the window/tab loses focus (opt-in via settings).
  document.addEventListener('visibilitychange', () => {
    if (autoLock && document.hidden) openLockScreen();
  });
  window.addEventListener('blur', () => {
    if (autoLock) openLockScreen();
  });
}

// ----------------------------------------------------------------------------
// Chat List Controller & Filter Chips
// ----------------------------------------------------------------------------
function sortChats() {
  chats.sort((a, b) => {
    // Pinned rooms (상단 고정) float to the top, then most-recent-first.
    const pa = pinnedSet.has(a.id) ? 1 : 0;
    const pb = pinnedSet.has(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (Number(b.lastSendAt) || 0) - (Number(a.lastSendAt) || 0);
  });
}

function persistRoomPrefs() {
  try {
    localStorage.setItem('kakaoweb_pinned', JSON.stringify([...pinnedSet]));
    localStorage.setItem('kakaoweb_muted', JSON.stringify([...mutedSet]));
  } catch {
    /* ignore quota */
  }
}

function renderChatList() {
  const list = $('chatlist');
  list.innerHTML = '';

  const q = searchQuery.trim().toLowerCase();
  const filtered = chats.filter((c) => {
    if (activeFilter === 'unread' && (c.unreadCount || 0) <= 0) return false;
    if (activeFilter === 'group' && !c.isGroup) return false;
    if (activeFilter === 'memo' && !/memo/i.test(c.type)) return false;

    if (!q) return true;
    const title = titleOf(c).toLowerCase();
    const lastMsg = (c.lastMessage || '').toLowerCase();
    let memberMatch = false;
    if (c.members) {
      memberMatch = Object.values(c.members).some((m) => m.name && m.name.toLowerCase().includes(q));
    }
    return title.includes(q) || lastMsg.includes(q) || memberMatch;
  });

  $('chatTotalCount').textContent = filtered.length;

  let totalUnread = 0;
  chats.forEach((c) => {
    totalUnread += Number(c.unreadCount || 0);
  });
  const unreadBadge = $('totalUnreadBadge');
  if (totalUnread > 0) {
    unreadBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
    unreadBadge.classList.remove('hidden');
  } else {
    unreadBadge.classList.add('hidden');
  }

  filtered.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeChatId ? ' active' : '');
    item.dataset.id = c.id;

    const title = titleOf(c);
    const lastSnippet = c.lastMessage || formatBodyPreview(c.lastMessageType, '');
    const timeStr = formatChatTime(c.lastSendAt);

    const isPinned = pinnedSet.has(c.id);
    const isMuted = mutedSet.has(c.id);
    if (isPinned) item.classList.add('pinned');

    item.innerHTML = `
      <div class="avatar-wrap">
        ${avatarHtml(title, c.avatar)}
      </div>
      <div class="chat-item-main">
        <div class="chat-top-row">
          <div class="chat-title-group">
            ${isPinned ? '<span class="chat-flag" title="상단 고정">📌</span>' : ''}
            <span class="chat-item-title">${esc(title)}</span>
            ${c.memberCount && c.memberCount > 2 ? `<span class="chat-member-badge">${c.memberCount}</span>` : ''}
            ${isMuted ? '<span class="chat-flag" title="알림 꺼짐">🔕</span>' : ''}
          </div>
          <span class="chat-time">${timeStr}</span>
        </div>
        <div class="chat-bottom-row">
          <span class="chat-item-snippet">${esc(lastSnippet)}</span>
          ${c.unreadCount && !isMuted ? `<span class="chat-item-badge">${c.unreadCount}</span>` : ''}
        </div>
      </div>
    `;

    item.addEventListener('click', () => openChat(c.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatContextMenu(e.clientX, e.clientY, c.id);
    });
    list.appendChild(item);
  });
}

// ----------------------------------------------------------------------------
// Open Chat & Render Messages
// ----------------------------------------------------------------------------
let isFetchingOlder = false;
let hasReachedTop = false;

async function openChat(id) {
  if (activeChatId === id && currentMessages.length > 0) return;
  activeChatId = id;
  hasReachedTop = false;
  isFetchingOlder = false;

  renderChatList();
  updateRoomNotifyIcon();
  $('emptyState').style.display = 'none';
  $('messages').innerHTML = '<div class="date-divider"><span class="date-divider-text">대화 내용을 불러오는 중...</span></div>';
  $('input').disabled = false;
  $('send').disabled = false;
  $('input').placeholder = '메시지를 입력하세요 (Shift + Enter 줄바꿈)';
  $('input').focus();

  const c = chats.find((x) => x.id === id);
  const title = titleOf(c);
  $('chatTitle').textContent = title;
  $('chatTitle').classList.remove('muted');
  $('headAvatarWrap').innerHTML = avatarHtml(title, c?.avatar);
  $('chatMemberCount').textContent = c?.memberCount && c.memberCount > 2 ? `${c.memberCount}` : '';

  closeChatDrawer();
  closeInChatSearch();

  try {
    const res = await api(`/api/history?chatId=${encodeURIComponent(id)}`);
    currentChatMembers = res.members || {};
    currentMessages = res.messages || [];

    if (res.title && c) c.title = res.title;
    if (res.members && c) c.members = res.members;

    renderMessages(currentMessages);
    const box = $('messages');
    box.scrollTop = box.scrollHeight;

    // Update Drawer
    updateDrawerData();

    if (c && c.unreadCount > 0) {
      c.unreadCount = 0;
      renderChatList();
      if (currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (last && (last.messageId || last.logId)) {
          markRead(id, last.messageId || last.logId);
        }
      }
    }
  } catch (err) {
    $('messages').innerHTML = `<div class="date-divider"><span class="date-divider-text">대화 로드 실패: ${esc(err.message)}</span></div>`;
  }
}

function initMessagesScroll() {
  const box = $('messages');
  box.addEventListener('scroll', async () => {
    if (box.scrollTop > 50 || isFetchingOlder || hasReachedTop || !activeChatId) return;
    if (currentMessages.length === 0) return;
    const oldest = currentMessages[0];
    const oldestId = oldest.messageId || oldest.logId;
    if (!oldestId) return;

    isFetchingOlder = true;
    const prevScrollHeight = box.scrollHeight;
    const prevScrollTop = box.scrollTop;

    try {
      const res = await api(`/api/history?chatId=${encodeURIComponent(activeChatId)}&max=${encodeURIComponent(oldestId)}&limit=30`);
      const older = (res.messages || []).filter((m) => {
        const id = m.messageId || m.logId;
        return id && String(id) !== String(oldestId) && !currentMessages.some((x) => String(x.messageId || x.logId) === String(id));
      });

      if (older.length > 0) {
        currentMessages = [...older, ...currentMessages];
        renderMessages(currentMessages);
        const newScrollHeight = box.scrollHeight;
        box.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
      } else {
        hasReachedTop = true;
      }
    } catch (e) {
      console.warn('Failed to load older messages:', e);
    } finally {
      isFetchingOlder = false;
    }
  });
}

function clearUnreadUpTo(targetLogId, sendAt) {
  let targetBig = null;
  if (targetLogId) {
    try {
      targetBig = BigInt(String(targetLogId));
    } catch {}
  }

  currentMessages.forEach((msg) => {
    if (String(msg.authorId) === String(me) && msg.unreadCount > 0) {
      let isBefore = false;
      const msgId = msg.messageId || msg.logId;
      if (targetBig && msgId) {
        try {
          isBefore = BigInt(String(msgId)) <= targetBig;
        } catch {
          isBefore = (msg.sendAt || 0) <= (sendAt || 0);
        }
      } else {
        isBefore = (msg.sendAt || 0) <= (sendAt || 0);
      }
      if (isBefore) {
        msg.unreadCount = 0;
        if (msgId) {
          const row = $('messages').querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
          row?.querySelector('.msg-unread')?.remove();
        }
      }
    }
  });
}

function renderMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  lastRenderedDate = null;
  lastRenderedAuthor = null;
  lastRenderedTimestamp = 0;

  msgs.forEach((m) => {
    appendMessageElement(m, box);
  });
  box.scrollTop = box.scrollHeight;
}

function appendMessageElement(m, container) {
  const msgId = m.messageId || m.logId;
  if (msgId) {
    const existingRow = container.querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
    if (existingRow) return existingRow;
  }

  const sendTime = m.sendAt || Math.floor(Date.now() / 1000);
  const dateStr = formatDateDivider(sendTime);
  const isMe = String(m.authorId) === String(me);
  const c = chats.find((x) => x.id === activeChatId);
  const isDirect = !c?.isGroup || (c?.memberCount || 2) <= 2;
  const displayUnread = (isDirect && !isMe) ? 0 : (m.unreadCount || 0);

  // Date Divider
  if (dateStr && dateStr !== lastRenderedDate) {
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    divider.innerHTML = `<span class="date-divider-text">${dateStr}</span>`;
    container.appendChild(divider);
    lastRenderedDate = dateStr;
    lastRenderedAuthor = null;
  }

  // Author Name
  let authorName = m.authorName;
  if (!authorName && currentChatMembers[m.authorId]) {
    authorName = currentChatMembers[m.authorId].name;
  }
  if (!authorName) {
    authorName = isMe ? '나' : `사용자 (${String(m.authorId).slice(-4)})`;
  }

  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMe ? 'me' : 'other');
  row.dataset.msgId = m.messageId || m.logId || '';

  // Avatar for other
  let avatarCol = '';
  if (!isMe) {
    const img = currentChatMembers[m.authorId]?.img;
    avatarCol = `<div class="msg-avatar">${avatarHtml(authorName, img)}</div>`;
  }

  // Bubble content
  const bubbleHtml = renderBubbleContent(m);

  row.innerHTML = `
    ${avatarCol}
    <div class="msg-body">
      ${!isMe ? `<span class="msg-author">${esc(authorName)}</span>` : ''}
      <div class="msg-bubble-wrap">
        <div class="bubble">${bubbleHtml}</div>
        <div class="msg-meta">
          ${displayUnread > 0 ? `<span class="msg-unread">${displayUnread}</span>` : ''}
          <span class="msg-time">${formatMessageTime(sendTime)}</span>
        </div>
      </div>
    </div>
  `;

  // Right-click context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, m, authorName);
  });

  container.appendChild(row);
  maybeRenderLinkPreview(row, m);
  lastRenderedAuthor = m.authorId;
  lastRenderedTimestamp = sendTime;
  return row;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const ogInflight = new Set();
function maybeRenderLinkPreview(row, m) {
  if (!m || m.type !== 1 || !m.text) return;
  const match = m.text.match(URL_RE);
  if (!match) return;
  const link = match[0];
  const wrap = row.querySelector('.msg-bubble-wrap');
  if (!wrap || wrap.querySelector('.link-preview')) return;
  const key = `${row.dataset.msgId}|${link}`;
  if (ogInflight.has(key)) return;
  ogInflight.add(key);
  api(`/api/og?url=${encodeURIComponent(link)}`)
    .then((og) => {
      if (!og || og.error || (!og.title && !og.description && !og.image)) return;
      const card = document.createElement('a');
      card.className = 'link-preview';
      card.href = og.url || link;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.innerHTML = `
        ${og.image ? `<div class="link-preview-img" style="background-image:url('${esc(og.image)}')"></div>` : ''}
        <div class="link-preview-body">
          ${og.title ? `<div class="link-preview-title">${esc(og.title)}</div>` : ''}
          ${og.description ? `<div class="link-preview-desc">${esc(og.description)}</div>` : ''}
          <div class="link-preview-site">${esc(og.siteName || new URL(og.url || link).hostname)}</div>
        </div>`;
      wrap.appendChild(card);
    })
    .catch(() => {})
    .finally(() => ogInflight.delete(key));
}

function renderBubbleContent(m) {
  const type = m.type || 1;
  const rawText = m.text || '';

  // Photo (type: 2) or MultiPhoto (type: 27)
  if (type === 2 || type === 27) {
    const att = parseAttachment(m.attachment) || parseAttachment(rawText);
    const token = att?.k || att?.token || att?.url;
    if (token) {
      if (token.startsWith('http') || token.startsWith('data:')) {
        return `<img class="bubble-img" src="${esc(token)}" alt="사진" onclick="openLightbox('${esc(token)}')" />`;
      }
      const thumbUrl = `/api/media?chatId=${encodeURIComponent(m.chatId)}&token=${encodeURIComponent(token)}&mini=1`;
      const fullUrl = `/api/media?chatId=${encodeURIComponent(m.chatId)}&token=${encodeURIComponent(token)}`;
      return `<img class="bubble-img" src="${esc(thumbUrl)}" alt="사진" onclick="openLightbox('${esc(fullUrl)}')" loading="lazy" />`;
    }
  }

  // Voice Call
  if (type === 51 || type === 52) {
    return `<div class="call-card">📞 ${type === 51 ? '보이스톡' : '페이스톡'} 통화 완료</div>`;
  }

  // Emoticon
  if (type === 6 || type === 12 || type === 20 || type === 22 || type === 25) {
    // KakaoTalk emoticon images are not displayed here; show a placeholder with the emoticon's name.
    const att = parseAttachment(m.attachment) || parseAttachment(rawText);
    const alt = att?.alt || att?.name || '이모티콘';
    return `<div style="font-size:36px; padding:4px;" title="${esc(alt)}" aria-label="${esc(alt)}">😀</div>`;
  }

  return linkify(rawText);
}

// ----------------------------------------------------------------------------
// Sending Messages & Clipboard Paste
// ----------------------------------------------------------------------------
let isSending = false;
async function sendMessage() {
  if (isSending || !activeChatId) return;
  const input = $('input');
  const text = input.value.trim();

  // If attachment exists
  let sendText = text;
  if (pendingAttachment) {
    sendText = text ? `${text}\n[사진: ${pendingAttachment.name}]` : `[사진: ${pendingAttachment.name}]`;
  }

  // Capture a structured reply target (if the quoted message had a real logId) before clearing.
  const replyPayload =
    quotedReplyTarget && quotedReplyTarget.logId && quotedReplyTarget.userId
      ? { logId: String(quotedReplyTarget.logId), userId: String(quotedReplyTarget.userId), text: quotedReplyTarget.text }
      : null;
  const replyPrefix = quotedReplyTarget ? `↪ [${quotedReplyTarget.authorName}]: ${quotedReplyTarget.text}\n` : '';

  // @mentions present in the text the user picked
  const mentionSpans = pendingMentions.length ? buildMentionSpans(sendText) : [];
  pendingMentions = [];

  if (!sendText) return;
  isSending = true;

  input.value = '';
  clearQuoteReply();
  clearPendingAttachment();

  const c = chats.find((x) => x.id === activeChatId);
  const isDirect = !c?.isGroup || (c?.memberCount || 2) <= 2;
  const initialUnread = isDirect ? 1 : Math.max(1, (c?.memberCount || 2) - 1);

  // Optimistic UI append (show the quote prefix locally; the server send carries it as reply metadata)
  const optimistic = {
    chatId: activeChatId,
    authorId: me,
    text: replyPrefix + sendText,
    type: 1,
    unreadCount: initialUnread,
    sendAt: Math.floor(Date.now() / 1000)
  };
  currentMessages.push(optimistic);
  const row = appendMessageElement(optimistic, $('messages'));
  $('messages').scrollTop = $('messages').scrollHeight;

  try {
    const res = await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: activeChatId,
        text: sendText,
        ...(replyPayload ? { reply: replyPayload } : {}),
        ...(mentionSpans.length ? { mentions: mentionSpans } : {})
      })
    });
    if (res && (res.logId || res.messageId)) {
      const id = String(res.logId || res.messageId);
      optimistic.logId = id;
      optimistic.messageId = id;
      if (res.unreadCount != null) optimistic.unreadCount = res.unreadCount;
      if (row) row.dataset.msgId = id;
    }
  } catch (err) {
    // Not sent: drop the optimistic bubble and give the text back so it can be retried.
    currentMessages.splice(currentMessages.indexOf(optimistic), 1);
    row?.remove();
    if (!input.value) input.value = sendText;
    alert(`전송 실패: ${err.message}`);
  } finally {
    isSending = false;
  }
}

async function markRead(chatId, watermark) {
  try {
    await api('/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, watermark })
    });
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// Clipboard Image Paste (`Cmd+V` / `Ctrl+V`) & File Attachment
// ----------------------------------------------------------------------------
function initClipboardPaste() {
  window.addEventListener('paste', (e) => {
    if (!activeChatId) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          handleAttachedFile(file);
          break;
        }
      }
    }
  });

  $('attachFileBtn').addEventListener('click', () => {
    if (!activeChatId) return;
    $('fileInput').click();
  });

  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleAttachedFile(file);
  });

  $('attachmentRemoveBtn').addEventListener('click', clearPendingAttachment);
}

function handleAttachedFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingAttachment = {
      file,
      dataUrl: e.target?.result,
      name: file.name || 'clipboard_image.png',
      size: formatBytes(file.size)
    };
    $('attachmentName').textContent = pendingAttachment.name;
    $('attachmentSize').textContent = pendingAttachment.size;
    $('attachmentThumb').style.backgroundImage = `url('${pendingAttachment.dataUrl}')`;
    $('attachmentPreviewBar').classList.remove('hidden');
    $('input').focus();
  };
  reader.readAsDataURL(file);
}

function clearPendingAttachment() {
  pendingAttachment = null;
  $('attachmentPreviewBar').classList.add('hidden');
  $('fileInput').value = '';
}

// ----------------------------------------------------------------------------
// Quoted Reply (답장)
// ----------------------------------------------------------------------------
function setQuoteReply(authorName, text, msg) {
  quotedReplyTarget = {
    authorName,
    text: (text || '').slice(0, 60),
    logId: msg ? msg.logId || msg.messageId : undefined,
    userId: msg ? msg.authorId : undefined
  };
  $('replyAuthor').textContent = authorName;
  $('replySnippet').textContent = quotedReplyTarget.text;
  $('replyPreviewBar').classList.remove('hidden');
  $('input').focus();
}

function clearQuoteReply() {
  quotedReplyTarget = null;
  $('replyPreviewBar').classList.add('hidden');
}

// ----------------------------------------------------------------------------
// Emoticon Picker
// ----------------------------------------------------------------------------
const EMOTICONS = {
  kakao: ['💛', '🤎', '🦁', '🍑', '🦆', '🐊', '🐻', '🐰', '🐶', '🐱', '✨', '🎉', '☕', '🔥', '🍰', '🌸'],
  reactions: ['👍', '👎', '👏', '🙏', '😂', '😭', '😍', '🥳', '😎', '🤔', '😱', '😡', '😴', '💪', '👋', '💯'],
  text: [
    '(•‿•)', '(｡♥‿♥｡)', '(¬_¬)', '(T_T)', '(^o^)/', '(o_O)',
    '(づ｡◕‿‿◕｡)づ', '(╯°□°）╯︵ ┻━┻', '¯\\_(ツ)_/¯', '(◕‿◕✿)'
  ]
};

function initEmoticonPicker() {
  $('emoticonPickerToggle').addEventListener('click', () => {
    const panel = $('emoticonPickerPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      renderEmoticonGrid('kakao');
    }
  });

  document.querySelectorAll('.picker-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.picker-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderEmoticonGrid(tab.dataset.tab);
    });
  });
}

function renderEmoticonGrid(category) {
  const grid = $('emoticonGrid');
  grid.innerHTML = '';
  const items = EMOTICONS[category] || [];
  items.forEach((em) => {
    const btn = document.createElement('div');
    btn.className = 'picker-item';
    btn.textContent = em;
    btn.onclick = () => {
      $('input').value += em;
      $('emoticonPickerPanel').classList.add('hidden');
      $('input').focus();
    };
    grid.appendChild(btn);
  });
}

// ----------------------------------------------------------------------------
// In-Chat Search
// ----------------------------------------------------------------------------
function initInChatSearch() {
  $('inChatSearchToggle').addEventListener('click', () => {
    const bar = $('inChatSearchBar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) {
      $('inChatSearchInput').focus();
    } else {
      closeInChatSearch();
    }
  });

  $('inChatCloseBtn').addEventListener('click', closeInChatSearch);

  $('inChatSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    executeInChatSearch(q);
  });

  $('inChatNextBtn').addEventListener('click', () => navigateInChatSearch(1));
  $('inChatPrevBtn').addEventListener('click', () => navigateInChatSearch(-1));
}

function closeInChatSearch() {
  $('inChatSearchBar').classList.add('hidden');
  $('inChatSearchInput').value = '';
  inChatSearchResults = [];
  currentSearchIndex = -1;
  $('inChatMatchCount').textContent = '0/0';
}

function executeInChatSearch(query) {
  inChatSearchResults = [];
  currentSearchIndex = -1;
  if (!query) {
    $('inChatMatchCount').textContent = '0/0';
    return;
  }

  const rows = document.querySelectorAll('.msg-row');
  rows.forEach((row) => {
    const b = row.querySelector('.bubble');
    if (b && b.textContent.toLowerCase().includes(query)) {
      inChatSearchResults.push(row);
    }
  });

  $('inChatMatchCount').textContent = inChatSearchResults.length ? `1/${inChatSearchResults.length}` : '0/0';
  if (inChatSearchResults.length > 0) {
    currentSearchIndex = 0;
    highlightSearchMatch();
  }
}

function navigateInChatSearch(direction) {
  if (inChatSearchResults.length === 0) return;
  currentSearchIndex += direction;
  if (currentSearchIndex < 0) currentSearchIndex = inChatSearchResults.length - 1;
  if (currentSearchIndex >= inChatSearchResults.length) currentSearchIndex = 0;
  $('inChatMatchCount').textContent = `${currentSearchIndex + 1}/${inChatSearchResults.length}`;
  highlightSearchMatch();
}

function highlightSearchMatch() {
  const row = inChatSearchResults[currentSearchIndex];
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.transition = 'background 0.3s ease';
    row.style.background = 'rgba(254, 229, 0, 0.3)';
    setTimeout(() => {
      row.style.background = '';
    }, 1200);
  }
}

// ----------------------------------------------------------------------------
// Right Chat Drawer (톡서랍)
// ----------------------------------------------------------------------------
function initChatDrawer() {
  $('drawerToggle').addEventListener('click', () => {
    const d = $('chatDrawer');
    d.classList.toggle('hidden');
    if (!d.classList.contains('hidden')) {
      updateDrawerData();
    }
  });

  $('drawerCloseBtn').addEventListener('click', closeChatDrawer);

  document.querySelectorAll('.drawer-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.drawer-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.drawerTab;
      $('drawerMembersPane').classList.toggle('hidden', target !== 'members');
      $('drawerMediaPane').classList.toggle('hidden', target !== 'media');
      $('drawerFilesPane').classList.toggle('hidden', target !== 'files');
      $('drawerLinksPane').classList.toggle('hidden', target !== 'links');
    });
  });
}

function closeChatDrawer() {
  $('chatDrawer').classList.add('hidden');
}

function updateDrawerData() {
  // Members
  const mList = $('drawerMemberList');
  mList.innerHTML = '';
  Object.entries(currentChatMembers).forEach(([uId, m]) => {
    const item = document.createElement('div');
    item.className = 'drawer-member-item';
    item.innerHTML = `
      <div class="avatar-wrap" style="width:32px; height:32px;">
        ${avatarHtml(m.name, m.img)}
      </div>
      <span style="font-size:13px; font-weight:500;">${esc(m.name)}</span>
      ${String(uId) === String(me) ? '<span style="font-size:10px; color:var(--muted); margin-left:auto;">나</span>' : ''}
    `;
    if (String(uId) !== String(me)) {
      item.onclick = () => {
        openFriendProfile({ userId: uId, name: m.name, img: m.img });
      };
    }
    mList.appendChild(item);
  });

  // Media (Images)
  const mediaGrid = $('drawerMediaGrid');
  mediaGrid.innerHTML = '';
  currentMessages
    .filter((m) => m.type === 2)
    .forEach((m) => {
      const att = parseAttachment(m.text);
      const url = att?.url || att?.thumbnailUrl || m.text;
      if (url && (url.startsWith('http') || url.startsWith('data:'))) {
        const thumb = document.createElement('div');
        thumb.className = 'drawer-media-thumb';
        thumb.style.backgroundImage = `url('${esc(url)}')`;
        thumb.onclick = () => openLightbox(url);
        mediaGrid.appendChild(thumb);
      }
    });

  // Links
  const linksList = $('drawerLinksList');
  linksList.innerHTML = '';
  const urlRegex = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g;
  currentMessages.forEach((m) => {
    const matches = (m.text || '').match(urlRegex);
    if (matches) {
      matches.forEach((u) => {
        const row = document.createElement('div');
        row.innerHTML = `<a href="${esc(u)}" target="_blank" style="font-size:12px; color:var(--ink);">${esc(u)}</a>`;
        linksList.appendChild(row);
      });
    }
  });
}

// ----------------------------------------------------------------------------
// Context Menu
// ----------------------------------------------------------------------------
let currentContextMsg = null;
function openContextMenu(x, y, m, authorName) {
  currentContextMsg = { m, authorName };
  const menu = $('contextMenu');
  menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 160)}px`;
  menu.classList.remove('hidden');
}

function initContextMenu() {
  document.addEventListener('click', () => {
    $('contextMenu').classList.add('hidden');
  });

  $('ctxCopyText').addEventListener('click', () => {
    if (currentContextMsg?.m?.text) {
      navigator.clipboard.writeText(currentContextMsg.m.text);
    }
  });

  $('ctxReply').addEventListener('click', () => {
    if (currentContextMsg) {
      setQuoteReply(currentContextMsg.authorName, currentContextMsg.m.text || '', currentContextMsg.m);
    }
  });

  $('ctxPinNotice').addEventListener('click', () => {
    if (currentContextMsg?.m?.text) {
      currentNotice = currentContextMsg.m.text;
      $('noticeText').textContent = currentNotice;
      $('noticeBanner').classList.remove('hidden');
    }
  });

  $('ctxForward').addEventListener('click', () => {
    const m = currentContextMsg?.m;
    if (m) openForwardModal(m);
  });

  $('ctxSelfDelete').addEventListener('click', async () => {
    const m = currentContextMsg?.m;
    const logId = m && (m.logId || m.messageId || (m.raw && (m.raw.logId?.toString?.() || m.raw.logId)));
    if (!logId) {
      alert('이 메시지는 삭제할 수 없습니다 (전송 처리 중이거나 logId 없음).');
      return;
    }
    if (!confirm('이 메시지를 내 화면에서만 삭제할까요? (상대방에게는 그대로 남습니다)')) return;
    try {
      const r = await api('/api/self-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId, logIds: [String(logId)] })
      });
      if (r && r.status === 0) removeMessageBubble(String(logId));
      else alert(`삭제 실패: status ${r?.status ?? '?'} ${r?.error ?? ''}`);
    } catch (e) {
      alert(`삭제 요청 오류: ${e.message}`);
    }
  });

  $('ctxDelete').addEventListener('click', async () => {
    const m = currentContextMsg?.m;
    const logId = m && (m.logId || m.messageId || (m.raw && (m.raw.logId?.toString?.() || m.raw.logId)));
    if (!logId) {
      alert('이 메시지는 삭제할 수 없습니다 (전송 처리 중이거나 logId 없음).');
      return;
    }
    if (String(m.authorId) !== String(me)) {
      alert('내가 보낸 메시지만 삭제할 수 있습니다.');
      return;
    }
    if (!confirm('이 메시지를 모든 대화상대에게서 삭제할까요? (약 5분 이내만 가능, 되돌릴 수 없음)')) return;
    try {
      const r = await api('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChatId, logId: String(logId) })
      });
      if (r && r.status === 0) {
        removeMessageBubble(String(logId));
      } else {
        alert(`삭제 실패: status ${r?.status ?? '?'} ${r?.error ?? ''}`);
      }
    } catch (e) {
      alert(`삭제 요청 오류: ${e.message}`);
    }
  });
}

function removeMessageBubble(logId) {
  const row = document.querySelector(`.msg-row[data-msg-id="${CSS.escape(logId)}"]`);
  if (row) {
    const b = row.querySelector('.bubble');
    if (b) {
      b.classList.add('deleted');
      b.textContent = '삭제된 메시지입니다.';
    }
  }
  currentMessages = currentMessages.filter((x) => String(x.logId || x.messageId) !== String(logId));
}

// ----------------------------------------------------------------------------
// Chat-list context menu: pin (client-side), mute (client-side), leave (LOCO LEAVE)
// ----------------------------------------------------------------------------
let ctxChatId = null;
function openChatContextMenu(x, y, chatId) {
  ctxChatId = chatId;
  const menu = $('chatContextMenu');
  $('ctxChatPin').textContent = pinnedSet.has(chatId) ? '상단 고정 해제' : '상단 고정';
  $('ctxChatMute').textContent = mutedSet.has(chatId) ? '알림 켜기' : '알림 끄기';
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 140)}px`;
  menu.classList.remove('hidden');
}

function togglePin(chatId) {
  if (pinnedSet.has(chatId)) pinnedSet.delete(chatId);
  else pinnedSet.add(chatId);
  persistRoomPrefs();
  sortChats();
  renderChatList();
}

function toggleMute(chatId) {
  if (mutedSet.has(chatId)) mutedSet.delete(chatId);
  else mutedSet.add(chatId);
  persistRoomPrefs();
  renderChatList();
  updateRoomNotifyIcon();
}

function updateRoomNotifyIcon() {
  const btn = $('roomNotifyToggle');
  if (!btn || !activeChatId) return;
  btn.classList.toggle('muted-active', mutedSet.has(activeChatId));
  btn.title = mutedSet.has(activeChatId) ? '알림 켜기' : '알림 끄기';
}

async function leaveChat(chatId) {
  const c = chats.find((x) => x.id === chatId);
  const name = c ? titleOf(c) : chatId;
  if (!confirm(`'${name}' 채팅방을 나가시겠습니까? 되돌릴 수 없습니다.`)) return;
  try {
    const r = await api('/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId })
    });
    if (r && r.status === 0) {
      removeChatFromList(chatId);
    } else {
      alert(`나가기 실패: status ${r?.status ?? '?'} ${r?.error ?? ''}`);
    }
  } catch (e) {
    alert(`나가기 요청 오류: ${e.message}`);
  }
}

function removeChatFromList(chatId) {
  chats = chats.filter((x) => x.id !== chatId);
  pinnedSet.delete(chatId);
  mutedSet.delete(chatId);
  persistRoomPrefs();
  if (activeChatId === chatId) {
    activeChatId = null;
    currentMessages = [];
    $('messages').innerHTML = '';
    $('chatTitle').textContent = '대화방을 선택해주세요';
    $('chatTitle').classList.add('muted');
  }
  renderChatList();
}

function initChatContextMenu() {
  $('ctxChatPin').addEventListener('click', () => ctxChatId && togglePin(ctxChatId));
  $('ctxChatMute').addEventListener('click', () => ctxChatId && toggleMute(ctxChatId));
  $('ctxChatLeave').addEventListener('click', () => ctxChatId && leaveChat(ctxChatId));
  document.addEventListener('click', () => $('chatContextMenu').classList.add('hidden'));

  const notify = $('roomNotifyToggle');
  if (notify) {
    notify.addEventListener('click', () => {
      if (activeChatId) toggleMute(activeChatId);
    });
  }
}

// ----------------------------------------------------------------------------
// Forward (전달) — pick a target chat, then FORWARD the message content there
// ----------------------------------------------------------------------------
let forwardSourceMsg = null;
function openForwardModal(m) {
  forwardSourceMsg = m;
  $('forwardSearch').value = '';
  renderForwardChatList('');
  $('forwardModal').classList.remove('hidden');
  $('forwardSearch').focus();
}
function renderForwardChatList(q) {
  const list = $('forwardChatList');
  list.innerHTML = '';
  const ql = q.trim().toLowerCase();
  chats
    .filter((c) => !ql || titleOf(c).toLowerCase().includes(ql))
    .forEach((c) => {
      const row = document.createElement('button');
      row.className = 'forward-chat-row';
      row.innerHTML = `<div class="avatar-wrap">${avatarHtml(titleOf(c), c.avatar)}</div><span>${esc(titleOf(c))}</span>`;
      row.addEventListener('click', () => doForward(c.id));
      list.appendChild(row);
    });
}
async function doForward(targetChatId) {
  const m = forwardSourceMsg;
  if (!m) return;
  const text = m.text || formatBodyPreview(m.type, m.text) || '';
  if (!text) {
    alert('전달할 내용이 없습니다.');
    return;
  }
  try {
    const r = await api('/api/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: targetChatId, text, type: m.type || 1, extra: m.extra || '' })
    });
    $('forwardModal').classList.add('hidden');
    if (!r || r.status !== 0) alert(`전달 실패: status ${r?.status ?? '?'} ${r?.error ?? ''}`);
  } catch (e) {
    alert(`전달 오류: ${e.message}`);
  }
}
function initForwardModal() {
  $('forwardClose').addEventListener('click', () => $('forwardModal').classList.add('hidden'));
  $('forwardModal').addEventListener('click', (e) => {
    if (e.target.id === 'forwardModal') $('forwardModal').classList.add('hidden');
  });
  $('forwardSearch').addEventListener('input', (e) => renderForwardChatList(e.target.value));
}

// ----------------------------------------------------------------------------
// @mention autocomplete — dropdown of room members; builds mention spans on send
// ----------------------------------------------------------------------------
let mentionOpen = false;
let mentionMatches = [];
let mentionIndex = 0;
let mentionTokenStart = -1;
let pendingMentions = []; // [{ userId, name }]

function membersForMention() {
  return Object.entries(currentChatMembers || {})
    .filter(([uid]) => String(uid) !== String(me))
    .map(([uid, v]) => ({ userId: uid, name: v.name || String(uid), img: v.img }));
}

function onComposerInput() {
  const input = $('input');
  const caret = input.selectionStart;
  const upto = input.value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1 || (at > 0 && !/\s/.test(upto[at - 1]))) {
    return closeMention();
  }
  const token = upto.slice(at + 1);
  if (/\s/.test(token)) return closeMention();
  const members = membersForMention();
  if (members.length === 0) return closeMention();
  mentionMatches = members.filter((m) => !token || m.name.toLowerCase().includes(token.toLowerCase())).slice(0, 8);
  if (mentionMatches.length === 0) return closeMention();
  mentionTokenStart = at;
  mentionIndex = 0;
  renderMentionDropdown();
}

function renderMentionDropdown() {
  const dd = $('mentionDropdown');
  dd.innerHTML = mentionMatches
    .map(
      (m, i) =>
        `<button class="mention-item${i === mentionIndex ? ' active' : ''}" data-idx="${i}">${avatarHtml(m.name, m.img)}<span>${esc(m.name)}</span></button>`
    )
    .join('');
  dd.querySelectorAll('.mention-item').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickMention(Number(btn.dataset.idx));
    });
  });
  const composer = $('composer').getBoundingClientRect();
  dd.style.left = `${composer.left + 12}px`;
  dd.style.bottom = `${window.innerHeight - composer.top + 4}px`;
  dd.classList.remove('hidden');
  mentionOpen = true;
}

function pickMention(i) {
  const m = mentionMatches[i];
  if (!m) return closeMention();
  const input = $('input');
  const caret = input.selectionStart;
  const before = input.value.slice(0, mentionTokenStart);
  const after = input.value.slice(caret);
  const insert = `@${m.name} `;
  input.value = before + insert + after;
  const newCaret = (before + insert).length;
  input.setSelectionRange(newCaret, newCaret);
  if (!pendingMentions.some((p) => p.userId === m.userId)) pendingMentions.push({ userId: m.userId, name: m.name });
  closeMention();
  input.focus();
}

function closeMention() {
  mentionOpen = false;
  mentionMatches = [];
  mentionTokenStart = -1;
  $('mentionDropdown').classList.add('hidden');
}

/** Build LOCO mention spans from the final text + the names the user picked. */
function buildMentionSpans(text) {
  const spans = [];
  for (const pm of pendingMentions) {
    const tag = `@${pm.name}`;
    const at = [];
    let idx = text.indexOf(tag);
    while (idx !== -1) {
      at.push(idx);
      idx = text.indexOf(tag, idx + 1);
    }
    if (at.length) spans.push({ userId: String(pm.userId), at, len: tag.length });
  }
  return spans;
}

function initMentions() {
  $('input').addEventListener('input', onComposerInput);
  $('input').addEventListener('blur', () => setTimeout(closeMention, 120));
}

function showDesktopNotification(chat, text) {
  if (!desktopNotify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const title = chat ? titleOf(chat) : 'KakaoTalk';
    new Notification(`🔔 ${title}`, { body: text.slice(0, 120), tag: chat?.id || 'kakao' });
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------------------
// Lightbox
// ----------------------------------------------------------------------------
function openLightbox(url) {
  $('lightboxImg').src = url;
  $('lightboxDownload').href = url;
  $('imageLightbox').classList.remove('hidden');
}

function closeAllPopups() {
  $('imageLightbox').classList.add('hidden');
  $('friendProfileModal').classList.add('hidden');
  $('contextMenu').classList.add('hidden');
  closeChatDrawer();
  closeInChatSearch();
}

// ----------------------------------------------------------------------------
// Approval dialogs: the daemon asks before reading a closed room or sending to a new one.
// The text comes from the daemon and may quote room or agent content: plain text only, never HTML.
// The confirmation code is typed by the person; this page never fills it in.
// ----------------------------------------------------------------------------
let approvalQueue = [];

function showNextApproval() {
  const modal = $('approvalModal');
  const d = approvalQueue[0];
  if (!d) { modal.classList.add('hidden'); return; }
  $('approvalMessage').textContent = d.message;
  $('approvalCodeLabel').textContent = d.codeTitle || '확인 코드';
  $('approvalCodeHint').textContent = d.codeDescription || '';
  $('approvalQueue').textContent = approvalQueue.length > 1 ? `대기 ${approvalQueue.length}건` : '';
  $('approvalCode').value = '';
  $('approvalError').textContent = '';
  $('approvalRemember').checked = false;
  $('approvalRememberRow').classList.toggle('hidden', !d.rememberTitle);
  $('approvalRememberLabel').textContent = d.rememberTitle || '';
  for (const id of ['approvalAccept', 'approvalDecline', 'approvalCancel']) $(id).disabled = false;
  const wasHidden = modal.classList.contains('hidden');
  modal.classList.remove('hidden');
  if (wasHidden) $('approvalCode').focus();
}

function addApproval(d) {
  if (!d || typeof d.id !== 'string' || approvalQueue.some((x) => x.id === d.id)) return;
  approvalQueue.push(d);
  if (approvalQueue.length === 1) showNextApproval(); else $('approvalQueue').textContent = `대기 ${approvalQueue.length}건`;
}

function removeApproval(id) {
  const wasFirst = approvalQueue[0]?.id === id;
  approvalQueue = approvalQueue.filter((x) => x.id !== id);
  if (wasFirst) showNextApproval(); else if (approvalQueue.length) $('approvalQueue').textContent = approvalQueue.length > 1 ? `대기 ${approvalQueue.length}건` : '';
}

async function answerApproval(action) {
  const d = approvalQueue[0];
  if (!d) return;
  const body = { id: d.id, action };
  if (action === 'accept') {
    // Send what the field shows (it displays upper case).
    const code = $('approvalCode').value.trim().toUpperCase();
    if (!code) { $('approvalError').textContent = '대화 상자에 표시된 확인 코드를 입력하세요.'; $('approvalCode').focus(); return; }
    body.code = code;
    body.remember = $('approvalRemember').checked;
  }
  for (const id of ['approvalAccept', 'approvalDecline', 'approvalCancel']) $(id).disabled = true;
  try {
    await api('/api/approvals/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    removeApproval(d.id);
  } catch (e) {
    // Already answered or expired elsewhere: drop it; the original action reports the outcome.
    removeApproval(d.id);
    console.warn('[approval]', e.message);
  }
}

function initApprovals() {
  $('approvalForm').addEventListener('submit', (e) => { e.preventDefault(); void answerApproval('accept'); });
  $('approvalDecline').addEventListener('click', () => void answerApproval('decline'));
  $('approvalCancel').addEventListener('click', () => void answerApproval('cancel'));
  $('approvalModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); void answerApproval('cancel'); } });
  api('/api/approvals').then((r) => (r.approvals || []).forEach(addApproval)).catch(() => {});
}

// ----------------------------------------------------------------------------
// Server-Sent Events (SSE) Real-Time Connection
// ----------------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('status', (ev) => {
    const d = JSON.parse(ev.data);
    setConn(d.connected, d.error);
    if (d.chats && d.chats.length > 0) {
      chats = d.chats;
      sortChats();
      renderChatList();
      renderFriends();
    }
  });

  es.addEventListener('approval-request', (ev) => addApproval(JSON.parse(ev.data)));
  es.addEventListener('approval-closed', (ev) => removeApproval(JSON.parse(ev.data).id));

  es.addEventListener('chat-meta', (ev) => {
    const d = JSON.parse(ev.data);
    const c = chats.find((x) => x.id === d.id);
    if (c) {
      if (d.title) c.title = d.title;
      if (d.avatar) c.avatar = d.avatar;
      if (d.isGroup != null) c.isGroup = d.isGroup;
      if (d.memberCount) c.memberCount = d.memberCount;
      renderChatList();
      renderFriends();
    }
  });

  es.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const isOther = String(m.authorId) !== String(me);
    let c = chats.find((x) => x.id === m.chatId);
    const now = m.sendAt || Math.floor(Date.now() / 1000);

    if (c) {
      c.lastMessage = m.text || formatBodyPreview(m.type, m.text);
      c.lastMessageType = m.type;
      c.lastSendAt = now;
      if (m.chatId !== activeChatId && isOther) {
        c.unreadCount = (c.unreadCount || 0) + 1;
      }
    }

    sortChats();
    renderChatList();

    if (m.chatId === activeChatId) {
      if (isOther) {
        clearUnreadUpTo(m.messageId || m.logId, m.sendAt);
      }
      const msgId = m.messageId || m.logId;
      const existing = currentMessages.find(
        (x) => (msgId && String(x.messageId || x.logId) === String(msgId)) ||
               (String(x.authorId) === String(me) && String(m.authorId) === String(me) && (!x.messageId || !x.logId) && x.text === m.text)
      );

      if (existing) {
        if (msgId) {
          existing.messageId = String(msgId);
          existing.logId = String(msgId);
          const row =
            $('messages').querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`) ||
            $('messages').querySelector('.msg-row.me:last-child');
          if (row) row.dataset.msgId = String(msgId);
        }
      } else {
        currentMessages.push(m);
        appendMessageElement(m, $('messages'));
        $('messages').scrollTop = $('messages').scrollHeight;
      }
      if (m.messageId) markRead(m.chatId, m.messageId);
    }

    // Keyword alerts fire even in muted rooms; otherwise honor the per-room mute.
    const msgText = m.text || '';
    const keywordHit =
      isOther && keywordAlerts.some((k) => k && msgText.toLowerCase().includes(k.toLowerCase()));
    if (isOther && (keywordHit || !mutedSet.has(m.chatId))) {
      playKatalkChime();
    }
    if (keywordHit) showDesktopNotification(c, msgText);
  });

  es.addEventListener('read-state', (ev) => {
    const d = JSON.parse(ev.data);
    if (!d || d.chatId !== activeChatId) return;
    if (d.watermark) {
      clearUnreadUpTo(d.watermark, Math.floor(Date.now() / 1000));
    }
  });

  es.addEventListener('chat-left', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.chatId) removeChatFromList(String(d.chatId));
  });

  es.addEventListener('message-deleted', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.chatId === activeChatId && d.logId) removeMessageBubble(String(d.logId));
  });

  es.onerror = () => setConn(false);
}

// ----------------------------------------------------------------------------
// Theme & Settings
// ----------------------------------------------------------------------------
function initTheme() {
  const saved = localStorage.getItem('kakaoweb_theme') || 'system';
  if (saved === 'dark' || saved === 'light') {
    document.body.dataset.theme = saved;
  }
  $('themeToggle').onclick = () => {
    const current = document.body.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem('kakaoweb_theme', next);
  };

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.setTheme;
      document.body.dataset.theme = mode;
      localStorage.setItem('kakaoweb_theme', mode);
    };
  });
}

// ----------------------------------------------------------------------------
// Settings & PC Customization (zoom / font / wallpaper / transparency / sound / hotkey)
// All client-side and persisted to localStorage.
// ----------------------------------------------------------------------------
const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", Roboto, sans-serif',
  noto: '"Noto Sans KR", -apple-system, "Malgun Gothic", sans-serif',
  gothic: '"Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  serif: '"Apple SD Gothic Neo", "Nanum Myeongjo", Georgia, serif',
  mono: '"SF Mono", "D2Coding", Menlo, Consolas, monospace'
};

function lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* quota / private mode — apply for this session only */
  }
}

function applyZoom(pct) {
  document.body.style.zoom = String(pct / 100);
  const label = $('settingZoomLabel');
  if (label) label.textContent = `${pct}%`;
}
function applyFontSize(px) {
  document.documentElement.style.setProperty('--app-font-size', `${px}px`);
  const label = $('settingFontSizeLabel');
  if (label) label.textContent = `${px}px`;
}
function applyFontFamily(key) {
  document.documentElement.style.setProperty('--app-font', FONT_STACKS[key] || FONT_STACKS.system);
}
function applyOpacity(pct) {
  document.body.style.opacity = String(pct / 100);
  const label = $('settingOpacityLabel');
  if (label) label.textContent = `${pct}%`;
}
function applyWallpaper(dataUrl) {
  const el = $('messages');
  if (!el) return;
  if (dataUrl) {
    el.style.backgroundImage = `url('${dataUrl}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundImage = '';
  }
}
function applyChatBg(color) {
  document.documentElement.style.setProperty('--chat-bg', color);
}

function initSettings() {
  // --- apply persisted values on load ---
  const zoom = Number(localStorage.getItem('kakaoweb_zoom') || 100);
  const fontSize = Number(localStorage.getItem('kakaoweb_fontsize') || 14);
  const fontFamily = localStorage.getItem('kakaoweb_fontfamily') || 'system';
  const opacity = Number(localStorage.getItem('kakaoweb_opacity') || 100);
  const wallpaper = localStorage.getItem('kakaoweb_wallpaper') || '';
  const chatBg = localStorage.getItem('kakaoweb_chatbg') || '';
  applyZoom(zoom);
  applyFontSize(fontSize);
  applyFontFamily(fontFamily);
  applyOpacity(opacity);
  if (wallpaper) applyWallpaper(wallpaper);
  if (chatBg) applyChatBg(chatBg);

  // --- reflect values into controls ---
  const set = (id, prop, val) => {
    const el = $(id);
    if (el) el[prop] = val;
  };
  set('settingZoom', 'value', zoom);
  set('settingFontSize', 'value', fontSize);
  set('settingFontFamily', 'value', fontFamily);
  set('settingOpacity', 'value', opacity);
  set('settingSoundType', 'value', soundType);
  set('settingSoundCheckbox', 'checked', soundEnabled);
  set('settingEnterToSend', 'checked', sendWithEnter);

  // --- wire controls ---
  $('settingZoom')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    applyZoom(v);
    lsSet('kakaoweb_zoom', String(v));
  });
  $('settingFontSize')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    applyFontSize(v);
    lsSet('kakaoweb_fontsize', String(v));
  });
  $('settingFontFamily')?.addEventListener('change', (e) => {
    applyFontFamily(e.target.value);
    lsSet('kakaoweb_fontfamily', e.target.value);
  });
  $('settingOpacity')?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    applyOpacity(v);
    lsSet('kakaoweb_opacity', String(v));
  });

  // sound
  $('settingSoundCheckbox')?.addEventListener('change', (e) => {
    soundEnabled = e.target.checked;
    lsSet('kakaoweb_sound', soundEnabled ? 'true' : 'false');
  });
  $('settingSoundType')?.addEventListener('change', (e) => {
    soundType = e.target.value;
    lsSet('kakaoweb_sound_type', soundType);
  });
  $('settingSoundPreview')?.addEventListener('click', () => playChime(soundType));

  // send key
  $('settingEnterToSend')?.addEventListener('change', (e) => {
    sendWithEnter = e.target.checked;
    lsSet('kakaoweb_sendkey', sendWithEnter ? 'enter' : 'shift');
  });

  // wallpaper swatches (solid chat background)
  document.querySelectorAll('.wp-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.bg;
      applyChatBg(color);
      lsSet('kakaoweb_chatbg', color);
    });
  });

  // wallpaper image upload
  $('settingWallpaperPick')?.addEventListener('click', () => $('settingWallpaperFile')?.click());
  $('settingWallpaperFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      applyWallpaper(dataUrl);
      try {
        localStorage.setItem('kakaoweb_wallpaper', dataUrl);
      } catch {
        alert('이미지가 너무 커서 저장되지 않았습니다. 이번 세션에만 적용됩니다.');
      }
    };
    reader.readAsDataURL(file);
  });
  $('settingWallpaperReset')?.addEventListener('click', () => {
    applyWallpaper('');
    applyChatBg(getComputedStyle(document.documentElement).getPropertyValue('--chat-bg-default') || '#b2c7da');
    lsSet('kakaoweb_wallpaper', '');
    lsSet('kakaoweb_chatbg', '');
    location.reload();
  });

  // keyword alerts
  const kwInput = $('settingKeywords');
  if (kwInput) {
    kwInput.value = keywordAlerts.join(', ');
    kwInput.addEventListener('change', (e) => {
      keywordAlerts = e.target.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      lsSet('kakaoweb_keywords', JSON.stringify(keywordAlerts));
    });
  }

  // desktop notifications (requests permission on enable)
  const dn = $('settingDesktopNotify');
  if (dn) {
    dn.checked = desktopNotify;
    dn.addEventListener('change', async (e) => {
      if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          e.target.checked = false;
          alert('브라우저 알림 권한이 거부되었습니다.');
          return;
        }
      }
      desktopNotify = e.target.checked;
      lsSet('kakaoweb_desktop_notify', desktopNotify ? 'true' : 'false');
    });
  }

  // auto-lock on blur
  const al = $('settingAutoLock');
  if (al) {
    al.checked = autoLock;
    al.addEventListener('change', (e) => {
      autoLock = e.target.checked;
      lsSet('kakaoweb_autolock', autoLock ? 'true' : 'false');
    });
  }

  // lock PIN change (stored as a SHA-256 hash)
  $('settingSavePin')?.addEventListener('click', async () => {
    const pin = ($('settingNewPin').value || '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
      alert('PIN은 4~8자리 숫자여야 합니다.');
      return;
    }
    try {
      localStorage.setItem('kakaoweb_lock_hash', await sha256Hex(pin));
      $('settingNewPin').value = '';
      alert('잠금 PIN이 변경되었습니다.');
    } catch {
      alert('PIN 저장에 실패했습니다.');
    }
  });
}

// ----------------------------------------------------------------------------
// Setup & Bootstrap
// ----------------------------------------------------------------------------
async function init() {
  initTheme();
  initNavigation();
  initLockScreen();
  initClipboardPaste();
  initEmoticonPicker();
  initInChatSearch();
  initChatDrawer();
  initContextMenu();
  initChatContextMenu();
  initForwardModal();
  initMentions();
  initSettings();
  void loadRealFriends();

  // Search input events
  $('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    $('clearSearch').classList.toggle('show', !!searchQuery);
    renderChatList();
  });
  $('clearSearch').addEventListener('click', () => {
    $('searchInput').value = '';
    searchQuery = '';
    $('clearSearch').classList.remove('show');
    renderChatList();
  });

  // Friend search
  $('friendSearchInput').addEventListener('input', (e) => {
    friendSearchQuery = e.target.value;
    $('clearFriendSearch').classList.toggle('show', !!friendSearchQuery);
    renderFriends();
  });
  $('clearFriendSearch').addEventListener('click', () => {
    $('friendSearchInput').value = '';
    friendSearchQuery = '';
    $('clearFriendSearch').classList.remove('show');
    renderFriends();
  });

  // Filter Chips
  document.querySelectorAll('.filter-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chips .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderChatList();
    });
  });

  // Composer Form
  const inputEl = $('input');
  let isComposing = false;
  inputEl.addEventListener('compositionstart', () => (isComposing = true));
  inputEl.addEventListener('compositionend', () => (isComposing = false));

  inputEl.addEventListener('keydown', (e) => {
    // When the @mention dropdown is open, it owns the arrow/enter/tab/esc keys.
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIndex = (mentionIndex + 1) % mentionMatches.length;
        return renderMentionDropdown();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIndex = (mentionIndex - 1 + mentionMatches.length) % mentionMatches.length;
        return renderMentionDropdown();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return pickMention(mentionIndex);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return closeMention();
      }
    }
    if (e.key !== 'Enter') return;
    if (isComposing || e.keyCode === 229) return;
    // sendWithEnter: Enter sends, Shift+Enter = newline. Otherwise: Shift+Enter sends, Enter = newline.
    const shouldSend = sendWithEnter ? !e.shiftKey : e.shiftKey;
    if (shouldSend) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  // Close modals
  $('closeLightbox').onclick = () => $('imageLightbox').classList.add('hidden');
  $('lightboxOverlay').onclick = () => $('imageLightbox').classList.add('hidden');
  $('closeProfileModal').onclick = () => $('friendProfileModal').classList.add('hidden');

  // Load Initial State
  try {
    const state = await api('/api/state');
    me = state.userId;
    chats = state.chats || [];
    $('settingsUserId').textContent = state.userId || '—';
    setConn(state.connected);
    sortChats();
    renderChatList();
    renderFriends();

    // Auto-select the first chat so the view is never empty on launch
    if (!activeChatId && chats.length > 0) {
      openChat(chats[0].id);
    }
  } catch (e) {
    setConn(false, e.message);
  }

  initMessagesScroll();
  initApprovals();
  connectSSE();
}

init();
