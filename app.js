// ==========================================================================
// SABHA PLATFORM FRONTEND INTERACTIVE CONTROLLER (app.js)
// ==========================================================================

const BACKEND_URL = 'http://localhost:4000';

// Global application state
let currentUser = null;
let token = null;
let usersMap = new Map();   // userId -> User
let groupsMap = new Map();  // groupId -> Group
let roomsMap = new Map();   // roomId -> Room

let activeTab = 'chats';
let activeChatUserId = null;
let activeGroupId = null;
let activeRoomId = null;

let socket = null;

// Call bookkeeping
let activeCall = null; // { peerId, peerName, role: 'caller'|'callee', callId, timerInterval, seconds: 0 }
let callMuted = false;
let callSpeaker = true;

// Mock mode state
let isMockMode = false;
let mockDmMessages = {};
let mockGroupMessages = {};
let mockRoomInterval = null;
let mockHandRaiseTimeout = null;

// Page initialization
window.addEventListener('DOMContentLoaded', () => {
  initMockMessages();
  
  // BYPASS LOGIN SCREEN: Automatically log in as K. Kavitha (Leader) in Mock Mode!
  isMockMode = true;
  currentUser = {
    id: 'u1',
    name: 'K. Kavitha',
    phone: '+919000000001',
    role: 'leader',
    avatarColor: '#F4C016',
    title: 'Party President',
    online: true
  };
  token = 'mock_token_' + Date.now();
  
  localStorage.setItem('sabha_user', JSON.stringify(currentUser));
  localStorage.setItem('sabha_token', token);
  
  onLoginSuccess();
});

function closeActiveDetail() {
  // Empty active chat or group so the panel gets .empty class and hides on mobile
  activeChatUserId = null;
  activeGroupId = null;
  
  document.getElementById('chat-detail-panel').classList.add('empty');
  document.getElementById('chat-active-container').classList.add('hidden');
  
  document.getElementById('group-detail-panel').classList.add('empty');
  document.getElementById('group-active-container').classList.add('hidden');
  
  renderChatsList();
  renderGroupsList();
}

// ==========================================================================
// AUTHENTICATION & LOGIN FLOW
// ==========================================================================

async function quickLogin(name, phone, role) {
  await performLogin({ name, phone, role });
}

async function handleManualLogin(e) {
  e.preventDefault();
  const name = document.getElementById('login-name').value;
  const phone = document.getElementById('login-phone').value;
  const role = document.getElementById('login-role').value;
  await performLogin({ name, phone, role });
}

async function performLogin(bodyData) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });
    
    if (!response.ok) {
      throw new Error('Login failed');
    }
    
    const data = await response.json();
    currentUser = data.user;
    token = data.token;
    
    localStorage.setItem('sabha_user', JSON.stringify(currentUser));
    localStorage.setItem('sabha_token', token);
    
    isMockMode = false;
    onLoginSuccess();
  } catch (error) {
    console.warn('Failed to connect to the backend server. Switching to Standalone Demo (Mock Mode).', error);
    
    isMockMode = true;
    const seededUsers = getSeededUsers();
    const matchedUser = seededUsers.find(u => u.phone === bodyData.phone || u.name.toLowerCase() === bodyData.name.toLowerCase());
    
    if (matchedUser) {
      currentUser = matchedUser;
    } else {
      currentUser = {
        id: 'u_' + Date.now(),
        name: bodyData.name,
        phone: bodyData.phone,
        role: bodyData.role || 'member',
        avatarColor: bodyData.role === 'leader' ? '#F4C016' : (bodyData.role === 'karyakarta' ? '#005020' : '#203080'),
        title: bodyData.role === 'leader' ? 'Party President' : (bodyData.role === 'karyakarta' ? 'Coordinator' : 'Party Member'),
        online: true
      };
    }
    
    token = 'mock_token_' + Date.now();
    localStorage.setItem('sabha_user', JSON.stringify(currentUser));
    localStorage.setItem('sabha_token', token);
    
    onLoginSuccess();
  }
}

async function onLoginSuccess() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  
  // Show Leader privileges banner if role is leader
  const banner = document.getElementById('leader-privilege-banner');
  if (currentUser.role === 'leader') {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  
  // Update header current user pill
  const pill = document.getElementById('current-user-pill');
  pill.innerHTML = `
    <div class="user-status-avatar" style="background-color: ${currentUser.avatarColor}; color: ${currentUser.role === 'leader' ? '#1A1500' : '#FFFFFF'}">
      ${getInitials(currentUser.name)}
    </div>
    <div class="user-status-info">
      <span class="user-status-name">${currentUser.name}</span>
      <span class="user-status-role">${currentUser.role}</span>
    </div>
  `;

  // Fetch seed data (users, groups, rooms)
  await fetchSeedData();

  // Initialize Socket.IO connection
  initSocketConnection();

  // Switch to default tab
  switchTab(activeTab);

  if (isMockMode) {
    startMockGroupChatActivity();
  }
}

function logout() {
  if (socket) {
    socket.disconnect();
  }
  
  localStorage.removeItem('sabha_user');
  localStorage.removeItem('sabha_token');
  
  currentUser = null;
  token = null;
  
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

// ==========================================================================
// DATA FETCHING & SYNCHRONIZATION
// ==========================================================================

async function fetchSeedData() {
  if (isMockMode) {
    loadLocalMockData();
    return;
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/seed`);
    const data = await res.json();
    
    usersMap.clear();
    groupsMap.clear();
    roomsMap.clear();
    
    data.users.forEach(u => usersMap.set(u.id, u));
    data.groups.forEach(g => groupsMap.set(g.id, g));
    data.rooms.forEach(r => roomsMap.set(r.id, r));
    
    renderChatsList();
    renderGroupsList();
    renderRoomsList();
    
    // Fill in Profile view info
    document.getElementById('my-profile-name').innerText = currentUser.name;
    document.getElementById('my-profile-avatar').innerText = getInitials(currentUser.name);
    document.getElementById('my-profile-avatar').style.backgroundColor = currentUser.avatarColor;
    document.getElementById('my-profile-role').innerText = currentUser.role;
    document.getElementById('my-profile-phone').innerText = currentUser.phone;
    document.getElementById('my-profile-title').innerText = currentUser.title || 'Party Member';
  } catch (error) {
    console.error('Error fetching seed data, falling back to mock mode:', error);
    isMockMode = true;
    loadLocalMockData();
  }
}

// ==========================================================================
// SOCKET.IO CONNECTION & LISTENERS
// ==========================================================================

function initSocketConnection() {
  if (isMockMode) {
    initMockSocketConnection();
  } else {
    socket = io(BACKEND_URL, {
      auth: { token: token }
    });
  }

  socket.on('connect', () => {
    console.log('Connected to Socket.IO backend, socketId:', socket.id);
    socket.emit('presence:hello');
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from Socket.IO server');
  });

  // Receive presence updates from other users
  socket.on('presence:update', ({ userId, online }) => {
    const user = usersMap.get(userId);
    if (user) {
      user.online = online;
      // Re-render lists where this user may appear
      updateUserOnlineStatusUI(userId, online);
    }
  });

  // Direct Message Listeners
  socket.on('dm:message', ({ message }) => {
    handleIncomingDirectMessage(message);
  });

  socket.on('dm:sent', ({ tempId, message }) => {
    handleSentDirectMessageConfirmation(tempId, message);
  });

  // Group Announcement / Chat Listeners
  socket.on('group:message', ({ message }) => {
    handleIncomingGroupMessage(message);
  });

  socket.on('group:sent', ({ tempId, message }) => {
    handleSentGroupMessageConfirmation(tempId, message);
  });

  // Call Signaling Relays
  socket.on('call:incoming', ({ from, callId }) => {
    handleIncomingCallOffer(from, callId);
  });

  socket.on('call:accepted', ({ callId }) => {
    handleCallAcceptedByPeer(callId);
  });

  socket.on('call:rejected', ({ callId }) => {
    handleCallRejectedByPeer(callId);
  });

  socket.on('call:ended', ({ callId }) => {
    handleCallEndedByPeer(callId);
  });

  // Conference (Sabha) Room Listeners
  socket.on('room:update', ({ roomId, listeners }) => {
    const room = roomsMap.get(roomId);
    if (room) {
      room.listeners = listeners;
      if (activeRoomId === roomId) {
        document.getElementById('room-listener-count').innerText = listeners.toLocaleString();
      }
      renderRoomsList();
    }
  });

  socket.on('room:reaction', ({ userId, emoji }) => {
    if (activeRoomId) {
      spawnFloatingEmoji(emoji);
    }
  });

  socket.on('room:state', ({ room }) => {
    if (activeRoomId === room.id) {
      roomsMap.set(room.id, room);
      document.getElementById('room-listener-count').innerText = room.listeners.toLocaleString();
      renderRoomSpeakers(room.speakers);
    }
  });

  socket.on('room:speakers', ({ roomId, speakers }) => {
    const room = roomsMap.get(roomId);
    if (room) {
      room.speakers = speakers;
      if (activeRoomId === roomId) {
        renderRoomSpeakers(speakers);
        updateUserSpeakerControls(speakers);
      }
    }
  });

  socket.on('room:youAreSpeaker', ({ roomId }) => {
    if (activeRoomId === roomId) {
      alert("Host promoted you to speaker. Your mic is now active.");
      // Unhide and set up mic control
      const muteBtn = document.getElementById('speaker-mute-btn');
      muteBtn.classList.remove('hidden');
      muteBtn.className = 'control-btn active-speaking-control';
      muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Mute Mic';
      
      const raiseBtn = document.getElementById('listener-raise-btn');
      raiseBtn.classList.add('hidden');
    }
  });

  socket.on('room:handRaised', ({ userId, name }) => {
    if (activeRoomId) {
      const room = roomsMap.get(activeRoomId);
      // Only display handraise list to the room host
      if (room && room.hostId === currentUser.id) {
        showHandRaiseNotification(userId, name);
      }
    }
  });
}

// ==========================================================================
// TABS SWITCHING LOGIC
// ==========================================================================

function switchTab(tabName) {
  activeTab = tabName;
  
  // Update nav UI active class
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => item.classList.remove('active'));
  
  const selectedIndex = ['chats', 'groups', 'conference', 'calls', 'profile'].indexOf(tabName);
  if (selectedIndex !== -1) {
    navItems[selectedIndex].classList.add('active');
  }

  // Show selected tab view
  const tabViews = document.querySelectorAll('.tab-view');
  tabViews.forEach(view => view.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // Trigger refresh on specific tab views
  if (tabName === 'chats') {
    renderChatsList();
  } else if (tabName === 'groups') {
    renderGroupsList();
  } else if (tabName === 'conference') {
    renderRoomsList();
  }
}

// ==========================================================================
// CHATS VIEW CONTROLLER
// ==========================================================================

function renderChatsList() {
  const container = document.getElementById('chats-users-list');
  container.innerHTML = '';
  
  // Sort users so online users appear first, excluding current user
  const chatUsers = [...usersMap.values()]
    .filter(u => u.id !== currentUser.id)
    .sort((a, b) => b.online - a.online);
    
  chatUsers.forEach(u => {
    const item = document.createElement('div');
    item.className = `member-item ${activeChatUserId === u.id ? 'active' : ''}`;
    item.onclick = () => selectActiveChat(u.id);
    
    const initials = getInitials(u.name);
    const onlineClass = u.online ? 'online' : '';
    const badgeHtml = u.role === 'leader' ? '<span class="leader-badge">Leader</span>' : '';
    
    item.innerHTML = `
      <div class="avatar-wrapper">
        <div class="avatar" style="background-color: ${u.avatarColor}; color: ${u.role === 'leader' ? '#1A1500' : '#FFFFFF'}">${initials}</div>
        <div class="presence-badge ${onlineClass}"></div>
      </div>
      <div class="member-info">
        <div class="member-header">
          <span class="member-name">${u.name} ${badgeHtml}</span>
        </div>
        <div class="member-subtitle">${u.title || 'Party Member'}</div>
      </div>
    `;
    container.appendChild(item);
  });
}

function filterChats() {
  const query = document.getElementById('chat-search').value.toLowerCase();
  const items = document.querySelectorAll('#chats-users-list .member-item');
  
  items.forEach(item => {
    const name = item.querySelector('.member-name').innerText.toLowerCase();
    const title = item.querySelector('.member-subtitle').innerText.toLowerCase();
    if (name.includes(query) || title.includes(query)) {
      item.classList.remove('hidden');
    } else {
      item.classList.add('hidden');
    }
  });
}

async function selectActiveChat(userId) {
  activeChatUserId = userId;
  
  // Highlight active sidebar item
  renderChatsList();
  
  const user = usersMap.get(userId);
  if (!user) return;
  
  // Hide empty state panel, show active chat box
  document.getElementById('chat-detail-panel').classList.remove('empty');
  document.getElementById('chat-active-container').classList.remove('hidden');
  
  // Fill Header details
  const headerAvatar = document.getElementById('active-chat-avatar');
  headerAvatar.innerText = getInitials(user.name);
  headerAvatar.style.backgroundColor = user.avatarColor;
  headerAvatar.style.color = user.role === 'leader' ? '#1A1500' : '#FFFFFF';
  
  document.getElementById('active-chat-name').innerText = user.name;
  document.getElementById('active-chat-status').innerText = user.online ? 'Online' : 'Offline';
  
  // Fetch message history
  document.getElementById('chat-messages-box').innerHTML = '<div class="system-message">Loading message history...</div>';
  
  if (isMockMode) {
    if (!mockDmMessages[userId]) {
      mockDmMessages[userId] = [];
    }
    renderChatMessages(mockDmMessages[userId]);
    return;
  }
  
  try {
    const response = await fetch(`${BACKEND_URL}/api/dm/${userId}?me=${currentUser.id}`);
    const messages = await response.json();
    renderChatMessages(messages);
    
    // Request Socket.IO DM history check (also triggers room listener setup in backend)
    socket.emit('dm:history', { peerId: userId });
  } catch (error) {
    console.error('Error fetching chat history:', error);
  }
}

function renderChatMessages(messages) {
  const box = document.getElementById('chat-messages-box');
  box.innerHTML = '';
  
  if (messages.length === 0) {
    box.innerHTML = '<div class="system-message">No messages yet. Say hello!</div>';
    return;
  }
  
  messages.forEach(msg => {
    const bubble = document.createElement('div');
    const isOutgoing = msg.from === currentUser.id;
    bubble.className = `message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
    if (msg.tempId) bubble.setAttribute('data-temp-id', msg.tempId);
    
    const timeStr = formatTime(msg.ts);
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(msg.text)}</span>
      <span class="message-meta">${timeStr}</span>
    `;
    box.appendChild(bubble);
  });
  
  scrollToBottom(box);
}

function handleChatKeyPress(e) {
  if (e.key === 'Enter') {
    sendDirectMessage();
  }
}

function sendDirectMessage() {
  const input = document.getElementById('chat-message-input');
  const text = input.value.trim();
  if (!text || !activeChatUserId) return;
  
  input.value = '';
  
  const tempId = 'temp_' + Date.now();
  
  // Render message optimistically in the chat box
  const box = document.getElementById('chat-messages-box');
  
  // Remove empty state message if it is there
  const emptyPlaceholder = box.querySelector('.system-message');
  if (emptyPlaceholder && emptyPlaceholder.innerText.includes('No messages yet')) {
    emptyPlaceholder.remove();
  }
  
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble outgoing';
  bubble.setAttribute('data-temp-id', tempId);
  
  if (isMockMode) {
    bubble.style.opacity = '1';
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(text)}</span>
      <span class="message-meta">${formatTime(Date.now())}</span>
    `;
  } else {
    bubble.style.opacity = '0.6'; // Dimmed for optimistic sending state
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(text)}</span>
      <span class="message-meta">${formatTime(Date.now())} <i class="fa-solid fa-clock"></i></span>
    `;
  }
  
  box.appendChild(bubble);
  scrollToBottom(box);
  
  if (isMockMode) {
    const msgObj = { from: currentUser.id, fromName: currentUser.name, text, ts: Date.now() };
    if (!mockDmMessages[activeChatUserId]) mockDmMessages[activeChatUserId] = [];
    mockDmMessages[activeChatUserId].push(msgObj);
    bubble.removeAttribute('data-temp-id');

    // Simulate response after 1.5 seconds
    const replyUserId = activeChatUserId;
    setTimeout(() => {
      if (activeChatUserId === replyUserId) {
        const replyText = getMockReply(replyUserId, text);
        const replyObj = { from: replyUserId, fromName: usersMap.get(replyUserId).name, text: replyText, ts: Date.now() };
        mockDmMessages[replyUserId].push(replyObj);
        
        if (activeTab === 'chats' && activeChatUserId === replyUserId) {
          const replyBubble = document.createElement('div');
          replyBubble.className = 'message-bubble incoming';
          replyBubble.innerHTML = `
            <span class="message-text">${escapeHTML(replyText)}</span>
            <span class="message-meta">${formatTime(replyObj.ts)}</span>
          `;
          box.appendChild(replyBubble);
          scrollToBottom(box);
        }
      }
    }, 1500);
  } else {
    // Emit dm:send Socket event
    socket.emit('dm:send', { to: activeChatUserId, text, tempId });
  }
}

function handleIncomingDirectMessage(message) {
  // If we are currently talking to the sender, append the message
  if (activeTab === 'chats' && activeChatUserId === message.from) {
    const box = document.getElementById('chat-messages-box');
    
    const emptyPlaceholder = box.querySelector('.system-message');
    if (emptyPlaceholder) emptyPlaceholder.remove();
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble incoming';
    
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(message.text)}</span>
      <span class="message-meta">${formatTime(message.ts)}</span>
    `;
    box.appendChild(bubble);
    scrollToBottom(box);
  } else {
    // Show a small notification toast/badge (simulated)
    console.log(`Received message from ${message.fromName}: ${message.text}`);
  }
}

function handleSentDirectMessageConfirmation(tempId, message) {
  const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
  if (bubble) {
    bubble.style.opacity = '1';
    bubble.querySelector('.message-meta').innerHTML = formatTime(message.ts);
    bubble.removeAttribute('data-temp-id');
  }
}

function updateUserOnlineStatusUI(userId, online) {
  // Find all status badges in chat list
  renderChatsList();
  
  // Update header status if active chat user went online/offline
  if (activeChatUserId === userId) {
    document.getElementById('active-chat-status').innerText = online ? 'Online' : 'Offline';
  }
}

// ==========================================================================
// GROUPS VIEW CONTROLLER
// ==========================================================================

function renderGroupsList() {
  const container = document.getElementById('groups-list');
  container.innerHTML = '<div class="list-title">Groups & Channels</div>';
  
  groupsMap.forEach(g => {
    const item = document.createElement('div');
    item.className = `member-item ${activeGroupId === g.id ? 'active' : ''}`;
    item.onclick = () => selectActiveGroup(g.id);
    
    const initials = getInitials(g.name);
    const broadcastTag = g.isBroadcast ? '<span class="leader-badge" style="background-color: var(--color-blue)">Official Broadcast</span>' : '';
    
    item.innerHTML = `
      <div class="avatar-wrapper">
        <div class="avatar" style="background-color: ${g.avatarColor}; color: #FFFFFF">${initials}</div>
      </div>
      <div class="member-info">
        <div class="member-header">
          <span class="member-name">${g.name}</span>
        </div>
        <div class="member-subtitle">${g.memberCount.toLocaleString()} members • ${broadcastTag || 'Working Group'}</div>
      </div>
    `;
    container.appendChild(item);
  });
}

async function selectActiveGroup(groupId) {
  activeGroupId = groupId;
  renderGroupsList();
  
  const group = groupsMap.get(groupId);
  if (!group) return;
  
  document.getElementById('group-detail-panel').classList.remove('empty');
  document.getElementById('group-active-container').classList.remove('hidden');
  
  const headerAvatar = document.getElementById('active-group-avatar');
  headerAvatar.innerText = getInitials(group.name);
  headerAvatar.style.backgroundColor = group.avatarColor;
  
  document.getElementById('active-group-name').innerText = group.name;
  document.getElementById('active-group-desc').innerText = group.description;
  
  // Show / Hide input box based on role and broadcast status
  const inputPanel = document.getElementById('group-chat-footer');
  const lockedBanner = document.getElementById('broadcast-locked-banner');
  
  if (group.isBroadcast && currentUser.role !== 'leader') {
    inputPanel.classList.add('hidden');
    lockedBanner.classList.remove('hidden');
  } else {
    inputPanel.classList.remove('hidden');
    lockedBanner.classList.add('hidden');
  }
  
  if (isMockMode) {
    if (!mockGroupMessages[groupId]) {
      mockGroupMessages[groupId] = [];
    }
    renderGroupMessages(mockGroupMessages[groupId]);
    return;
  }
  
  // Join the group room in Socket.IO
  socket.emit('group:join', { groupId });
  
  // Fetch group details and messages history via REST
  document.getElementById('group-messages-box').innerHTML = '<div class="system-message">Loading announcements...</div>';
  
  try {
    const res = await fetch(`${BACKEND_URL}/api/group/${groupId}`);
    const data = await res.json();
    renderGroupMessages(data.messages);
  } catch (error) {
    console.error('Error fetching group messages:', error);
  }
}

function renderGroupMessages(messages) {
  const box = document.getElementById('group-messages-box');
  box.innerHTML = '';
  
  if (messages.length === 0) {
    box.innerHTML = '<div class="system-message">No messages in this group yet.</div>';
    return;
  }
  
  messages.forEach(msg => {
    const bubble = document.createElement('div');
    const isOutgoing = msg.from === currentUser.id;
    bubble.className = `message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`;
    if (msg.tempId) bubble.setAttribute('data-temp-id', msg.tempId);
    
    const timeStr = formatTime(msg.ts);
    const senderHtml = isOutgoing ? '' : `<span class="message-sender">${msg.fromName}</span>`;
    
    bubble.innerHTML = `
      ${senderHtml}
      <span class="message-text">${escapeHTML(msg.text)}</span>
      <span class="message-meta">${timeStr}</span>
    `;
    box.appendChild(bubble);
  });
  
  scrollToBottom(box);
}

function handleGroupKeyPress(e) {
  if (e.key === 'Enter') {
    sendGroupMessage();
  }
}

function sendGroupMessage() {
  const input = document.getElementById('group-message-input');
  const text = input.value.trim();
  if (!text || !activeGroupId) return;
  
  input.value = '';
  const tempId = 'temp_' + Date.now();
  
  const box = document.getElementById('group-messages-box');
  const emptyPlaceholder = box.querySelector('.system-message');
  if (emptyPlaceholder) emptyPlaceholder.remove();
  
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble outgoing';
  bubble.setAttribute('data-temp-id', tempId);
  
  if (isMockMode) {
    bubble.style.opacity = '1';
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(text)}</span>
      <span class="message-meta">${formatTime(Date.now())}</span>
    `;
  } else {
    bubble.style.opacity = '0.6';
    bubble.innerHTML = `
      <span class="message-text">${escapeHTML(text)}</span>
      <span class="message-meta">${formatTime(Date.now())} <i class="fa-solid fa-clock"></i></span>
    `;
  }
  
  box.appendChild(bubble);
  scrollToBottom(box);
  
  if (isMockMode) {
    const msgObj = { from: currentUser.id, fromName: currentUser.name, text, ts: Date.now() };
    if (!mockGroupMessages[activeGroupId]) mockGroupMessages[activeGroupId] = [];
    mockGroupMessages[activeGroupId].push(msgObj);
    bubble.removeAttribute('data-temp-id');
  } else {
    socket.emit('group:send', { groupId: activeGroupId, text, tempId });
  }
}

function handleIncomingGroupMessage(message) {
  if (activeTab === 'groups' && activeGroupId === message.chatId) {
    // Exclude appending if we already appended it as the sender
    if (message.from === currentUser.id) return;
    
    const box = document.getElementById('group-messages-box');
    const emptyPlaceholder = box.querySelector('.system-message');
    if (emptyPlaceholder) emptyPlaceholder.remove();
    
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble incoming';
    
    bubble.innerHTML = `
      <span class="message-sender">${message.fromName}</span>
      <span class="message-text">${escapeHTML(message.text)}</span>
      <span class="message-meta">${formatTime(message.ts)}</span>
    `;
    box.appendChild(bubble);
    scrollToBottom(box);
  }
}

function handleSentGroupMessageConfirmation(tempId, message) {
  const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
  if (bubble) {
    bubble.style.opacity = '1';
    bubble.querySelector('.message-meta').innerHTML = formatTime(message.ts);
    bubble.removeAttribute('data-temp-id');
  }
}

// ==========================================================================
// CONFERENCE (SABHA 10K) VIEW CONTROLLER
// ==========================================================================

function renderRoomsList() {
  const container = document.getElementById('rooms-list');
  container.innerHTML = '';
  
  roomsMap.forEach(r => {
    const item = document.createElement('div');
    item.className = `room-item ${activeRoomId === r.id ? 'active' : ''}`;
    
    const liveBadge = r.live ? '<span class="room-live-badge">🔴 LIVE</span>' : '<span class="scheduled-badge" style="color: var(--color-blue); font-size: 10px; font-weight: 700;">SCHEDULED</span>';
    const listenersCount = r.live ? `${r.listeners.toLocaleString()} listeners` : 'Not started';
    const clickAction = r.live ? `onclick="joinConferenceRoom('${r.id}')"` : '';
    const buttonHtml = r.live ? `<button class="join-room-btn">Join Sabha</button>` : `<button class="join-room-btn" style="background-color: var(--color-border); color: var(--color-text-light)" disabled>View Details</button>`;
    
    item.innerHTML = `
      <div ${clickAction} style="cursor: ${r.live ? 'pointer' : 'default'}">
        <div class="room-item-header">
          <span class="room-item-title">${r.title}</span>
          ${liveBadge}
        </div>
        <div class="room-item-topic">${r.topic}</div>
        <div class="room-item-footer">
          <span>Host: <span class="room-item-host">${r.hostName}</span></span>
          <span>${listenersCount}</span>
        </div>
        <div style="margin-top: 10px; text-align: right;">
          ${buttonHtml}
        </div>
      </div>
    `;
    container.appendChild(item);
  });
}

function joinConferenceRoom(roomId) {
  activeRoomId = roomId;
  renderRoomsList();
  
  const room = roomsMap.get(roomId);
  if (!room) return;
  
  document.getElementById('conference-detail-panel').classList.remove('empty');
  document.getElementById('sabha-active-room').classList.remove('hidden');
  
  // Fill details
  document.getElementById('room-active-title').innerText = room.title;
  document.getElementById('room-active-topic').innerText = room.topic;
  document.getElementById('room-listener-count').innerText = room.listeners.toLocaleString();
  
  // Clear drawer notifications
  document.getElementById('host-hands-drawer').classList.add('hidden');
  document.getElementById('raised-hands-list').innerHTML = '';
  
  // Setup microphone controls depending on roles
  const muteBtn = document.getElementById('speaker-mute-btn');
  const raiseBtn = document.getElementById('listener-raise-btn');
  
  const isSpeaker = room.speakers.some(s => s.id === currentUser.id);
  if (isSpeaker) {
    muteBtn.classList.remove('hidden');
    muteBtn.className = 'control-btn active-speaking-control';
    muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Mute Mic';
    raiseBtn.classList.add('hidden');
  } else {
    muteBtn.classList.add('hidden');
    raiseBtn.classList.remove('hidden');
  }
  
  // Join room in Socket
  socket.emit('room:join', { roomId });
}

function leaveConferenceRoom() {
  if (activeRoomId) {
    socket.emit('room:leave', { roomId: activeRoomId });
  }
  
  activeRoomId = null;
  document.getElementById('sabha-active-room').classList.add('hidden');
  document.getElementById('conference-detail-panel').classList.add('empty');
  renderRoomsList();
}

function renderRoomSpeakers(speakers) {
  const container = document.getElementById('room-speakers-grid');
  container.innerHTML = '';
  
  speakers.forEach(sp => {
    const card = document.createElement('div');
    const isSpeakingClass = sp.speaking ? 'speaking' : '';
    card.className = `speaker-card ${isSpeakingClass}`;
    
    const initials = getInitials(sp.name);
    const muteIcon = sp.muted ? '<div class="mute-indicator-badge"><i class="fa-solid fa-microphone-slash"></i></div>' : '';
    
    card.innerHTML = `
      <div class="speaker-avatar-wrap">
        <div class="speaker-avatar" style="background-color: ${sp.avatarColor}; color: ${sp.role === 'leader' ? '#1A1500' : '#FFFFFF'}">${initials}</div>
        ${muteIcon}
      </div>
      <span class="speaker-name">${sp.name}</span>
      <span class="speaker-role">${sp.role === 'leader' ? 'Host (Leader)' : 'Speaker'}</span>
    `;
    container.appendChild(card);
  });
}

function updateUserSpeakerControls(speakers) {
  const isSpeaker = speakers.some(s => s.id === currentUser.id);
  const muteBtn = document.getElementById('speaker-mute-btn');
  const raiseBtn = document.getElementById('listener-raise-btn');
  
  if (isSpeaker) {
    muteBtn.classList.remove('hidden');
    const mySpeakerState = speakers.find(s => s.id === currentUser.id);
    if (mySpeakerState.muted) {
      muteBtn.className = 'control-btn';
      muteBtn.style.backgroundColor = 'var(--color-input-bg)';
      muteBtn.style.color = 'var(--color-text-dark)';
      muteBtn.innerHTML = '<i class="fa-solid fa-microphone-slash"></i> Unmute Mic';
    } else {
      muteBtn.className = 'control-btn active-speaking-control';
      muteBtn.style.backgroundColor = '';
      muteBtn.style.color = '';
      muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Mute Mic';
    }
    raiseBtn.classList.add('hidden');
  } else {
    muteBtn.classList.add('hidden');
    raiseBtn.classList.remove('hidden');
  }
}

function sendReaction(emoji) {
  if (!activeRoomId) return;
  socket.emit('room:reaction', { roomId: activeRoomId, emoji });
  spawnFloatingEmoji(emoji);
}

function raiseHandToSpeak() {
  if (!activeRoomId) return;
  socket.emit('room:raiseHand', { roomId: activeRoomId });
  alert("Your hand raised to speak. Waiting for the Host's approval.");
}

function toggleSpeakerMute() {
  if (!activeRoomId) return;
  const room = roomsMap.get(activeRoomId);
  const mySpeakerState = room.speakers.find(s => s.id === currentUser.id);
  if (mySpeakerState) {
    const nextMuted = !mySpeakerState.muted;
    socket.emit('room:muteToggle', { roomId: activeRoomId, muted: nextMuted });
  }
}

function showHandRaiseNotification(userId, name) {
  const drawer = document.getElementById('host-hands-drawer');
  drawer.classList.remove('hidden');
  
  const list = document.getElementById('raised-hands-list');
  
  // Avoid duplicate requests
  if (document.getElementById(`hand-raise-${userId}`)) return;
  
  const item = document.createElement('div');
  item.className = 'hand-raise-item';
  item.id = `hand-raise-${userId}`;
  item.innerHTML = `
    <span><b>${name}</b> wants to speak</span>
    <button class="promote-btn" onclick="promoteToSpeaker('${userId}')">Approve</button>
  `;
  list.appendChild(item);
}

function promoteToSpeaker(userId) {
  if (!activeRoomId) return;
  socket.emit('room:inviteToSpeak', { roomId: activeRoomId, userId });
  
  // Remove handraise entry
  const item = document.getElementById(`hand-raise-${userId}`);
  if (item) item.remove();
  
  const list = document.getElementById('raised-hands-list');
  if (list.children.length === 0) {
    document.getElementById('host-hands-drawer').classList.add('hidden');
  }
}

// Emote floating visual animation
function spawnFloatingEmoji(emoji) {
  const container = document.getElementById('floating-emojis-container');
  if (!container) return;
  
  const div = document.createElement('div');
  div.className = 'floating-emoji';
  div.innerText = emoji;
  
  // Set random drifts using CSS custom properties for realistic physics
  div.style.setProperty('--drift-1', `${Math.floor(Math.random() * 80) - 40}px`);
  div.style.setProperty('--drift-2', `${Math.floor(Math.random() * 120) - 60}px`);
  div.style.setProperty('--drift-3', `${Math.floor(Math.random() * 160) - 80}px`);
  div.style.left = `${Math.floor(Math.random() * 70) + 15}%`;
  
  container.appendChild(div);
  
  // Remove element after transition finishes
  setTimeout(() => {
    div.remove();
  }, 3000);
}

// ==========================================================================
// 1:1 CALL SIGNALING VIEW CONTROLLER
// ==========================================================================

function initiateAudioCall() {
  if (!activeChatUserId) return;
  
  const peer = usersMap.get(activeChatUserId);
  if (!peer) return;
  
  activeCall = {
    peerId: peer.id,
    peerName: peer.name,
    role: 'caller',
    callId: null,
    seconds: 0
  };
  
  // Show Outgoing Ringing Screen
  document.getElementById('outgoing-call-name').innerText = peer.name;
  const avatar = document.getElementById('outgoing-call-avatar');
  avatar.innerText = getInitials(peer.name);
  avatar.style.backgroundColor = peer.avatarColor;
  avatar.style.color = peer.role === 'leader' ? '#1A1500' : '#FFFFFF';
  
  document.getElementById('outgoing-call-screen').classList.remove('hidden');
  
  // Send socket request
  socket.emit('call:invite', { to: peer.id });
}

function handleIncomingCallOffer(fromUser, callId) {
  // If already in a call, auto-reject
  if (activeCall) {
    socket.emit('call:reject', { callId, to: fromUser.id });
    return;
  }
  
  activeCall = {
    peerId: fromUser.id,
    peerName: fromUser.name,
    role: 'callee',
    callId: callId,
    seconds: 0
  };
  
  // Show incoming call sheet
  document.getElementById('incoming-call-name').innerText = fromUser.name;
  const avatar = document.getElementById('incoming-call-avatar');
  avatar.innerText = getInitials(fromUser.name);
  avatar.style.backgroundColor = fromUser.avatarColor;
  avatar.style.color = fromUser.role === 'leader' ? '#1A1500' : '#FFFFFF';
  
  document.getElementById('incoming-call-screen').classList.remove('hidden');
}

function acceptIncomingCall() {
  if (!activeCall || activeCall.role !== 'callee') return;
  
  // Hide incoming call sheet
  document.getElementById('incoming-call-screen').classList.add('hidden');
  
  // Send accept signal
  socket.emit('call:accept', { callId: activeCall.callId, to: activeCall.peerId });
  
  // Transition to active call screen
  startActiveCallScreen(activeCall.peerName);
}

function rejectIncomingCall() {
  if (!activeCall) return;
  
  // Send reject signal
  socket.emit('call:reject', { callId: activeCall.callId, to: activeCall.peerId });
  
  // Reset active call bookkeeping
  document.getElementById('incoming-call-screen').classList.add('hidden');
  activeCall = null;
}

function handleCallAcceptedByPeer(callId) {
  if (!activeCall || activeCall.role !== 'caller') return;
  
  activeCall.callId = callId;
  
  // Hide Outgoing Ringing Screen
  document.getElementById('outgoing-call-screen').classList.add('hidden');
  
  // Transition to active call screen
  startActiveCallScreen(activeCall.peerName);
}

function handleCallRejectedByPeer(callId) {
  if (!activeCall) return;
  
  alert(`${activeCall.peerName} is busy or declined your call.`);
  
  document.getElementById('outgoing-call-screen').classList.add('hidden');
  activeCall = null;
}

function handleCallEndedByPeer(callId) {
  if (!activeCall) return;
  
  alert("Call ended by contact.");
  cleanCallOverlayState();
}

function endCurrentCall() {
  if (!activeCall) return;
  
  socket.emit('call:end', { callId: activeCall.callId || 'temp', to: activeCall.peerId });
  cleanCallOverlayState();
}

function startActiveCallScreen(peerName) {
  const activeScreen = document.getElementById('active-call-screen');
  activeScreen.classList.remove('hidden');
  
  document.getElementById('active-call-name').innerText = peerName;
  const avatar = document.getElementById('active-call-avatar');
  const peerUser = usersMap.get(activeCall.peerId);
  avatar.innerText = getInitials(peerName);
  avatar.style.backgroundColor = peerUser ? peerUser.avatarColor : 'var(--color-yellow)';
  avatar.style.color = peerUser && peerUser.role === 'leader' ? '#1A1500' : '#FFFFFF';
  
  document.getElementById('active-call-timer').innerText = 'Connected (00:00)';
  
  // Reset toggles UI state
  callMuted = false;
  document.getElementById('call-mute-toggle').className = 'mid-control-btn';
  callSpeaker = true;
  document.getElementById('call-speaker-toggle').className = 'mid-control-btn active';
  
  // Initialize timer ticks
  activeCall.seconds = 0;
  activeCall.timerInterval = setInterval(() => {
    activeCall.seconds++;
    const mins = String(Math.floor(activeCall.seconds / 60)).padStart(2, '0');
    const secs = String(activeCall.seconds % 60).padStart(2, '0');
    document.getElementById('active-call-timer').innerText = `Connected (${mins}:${secs})`;
  }, 1000);
}

function toggleCallMute() {
  callMuted = !callMuted;
  const btn = document.getElementById('call-mute-toggle');
  if (callMuted) {
    btn.className = 'mid-control-btn active';
  } else {
    btn.className = 'mid-control-btn';
  }
}

function toggleCallSpeaker() {
  callSpeaker = !callSpeaker;
  const btn = document.getElementById('call-speaker-toggle');
  if (callSpeaker) {
    btn.className = 'mid-control-btn active';
  } else {
    btn.className = 'mid-control-btn';
  }
}

function cleanCallOverlayState() {
  if (activeCall) {
    if (activeCall.timerInterval) {
      clearInterval(activeCall.timerInterval);
    }
  }
  
  document.getElementById('outgoing-call-screen').classList.add('hidden');
  document.getElementById('incoming-call-screen').classList.add('hidden');
  document.getElementById('active-call-screen').classList.add('hidden');
  
  activeCall = null;
}

// ==========================================================================
// GENERAL PLATFORM UTILITIES
// ==========================================================================

function getInitials(name) {
  if (!name) return '??';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // mapping 0 -> 12
  return `${hours}:${minutes} ${ampm}`;
}

function scrollToBottom(el) {
  setTimeout(() => {
    el.scrollTop = el.scrollHeight;
  }, 50);
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// ==========================================================================
// STANDALONE DEMO (MOCK SYSTEM) IMPLEMENTATION
// ==========================================================================

let userMessageCounts = {};
let mockGroupInterval = null;

async function testBackendConnectionAndLogin() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/seed`);
    if (res.ok) {
      isMockMode = false;
      onLoginSuccess();
    } else {
      throw new Error();
    }
  } catch (err) {
    console.warn("Backend server not running. Enabling Standalone Mock Mode.");
    isMockMode = true;
    onLoginSuccess();
  }
}

function getSeededUsers() {
  return [
    { id: 'u1', name: 'K. Kavitha',        phone: '+919000000001', role: 'leader',     avatarColor: '#F4C016', title: 'Party President', online: true },
    { id: 'u2', name: 'K. T. Rama Rao',    phone: '+919000000002', role: 'karyakarta', avatarColor: '#005020', title: 'Party Working President', online: true },
    { id: 'u3', name: 'Padma Devi Rao',    phone: '+919000000003', role: 'karyakarta', avatarColor: '#203080', title: 'Women\'s Wing Convenor', online: true },
    { id: 'u4', name: 'Srinivas Goud',     phone: '+919000000004', role: 'karyakarta', avatarColor: '#F4C016', title: 'District Coordinator — Nizamabad', online: true },
    { id: 'u5', name: 'Manoj Kumar',       phone: '+919000000005', role: 'karyakarta', avatarColor: '#005020', title: 'Youth Wing Coordinator', online: true },
    { id: 'u6', name: 'Anjali Sharma',     phone: '+919000000006', role: 'member',     avatarColor: '#203080', title: 'Booth Volunteer', online: true },
    { id: 'u7', name: 'Ravi Teja',         phone: '+919000000007', role: 'member',     avatarColor: '#F4C016', title: 'Party Member', online: true },
    { id: 'u8', name: 'Lakshmi Prasanna',  phone: '+919000000008', role: 'member',     avatarColor: '#005020', title: 'Party Member', online: true },
    { id: 'u9', name: 'Venkatesh Naidu',   phone: '+919000000009', role: 'member',     avatarColor: '#203080', title: 'Party Member', online: false },
    { id: 'u10', name: 'Sridevi Yadav',     phone: '+919000000010', role: 'member',     avatarColor: '#F4C016', title: 'Mahila Volunteer', online: true },
    { id: 'u11', name: 'Praveen Chary',     phone: '+919000000011', role: 'member',     avatarColor: '#005020', title: 'Youth Volunteer', online: true },
    { id: 'u12', name: 'Deepthi Reddy',     phone: '+919000000012', role: 'member',     avatarColor: '#203080', title: 'Party Member', online: true },
    { id: 'u13', name: 'Kishore Rao',       phone: '+919000000013', role: 'member',     avatarColor: '#F4C016', title: 'Booth Volunteer', online: true },
    { id: 'u14', name: 'Swathi Naidu',      phone: '+919000000014', role: 'member',     avatarColor: '#005020', title: 'Party Member', online: false },
  ];
}

function getSeededGroups() {
  return [
    { id: 'g1', name: 'State Committee', description: 'Core state-level committee coordination.', avatarColor: '#F4C016', isBroadcast: false, members: ['u1', 'u2', 'u3', 'u4', 'u5'], memberCount: 25 },
    { id: 'g2', name: 'District Coordinators', description: 'All district coordinators — planning & reports.', avatarColor: '#005020', isBroadcast: false, members: ['u1', 'u2', 'u4', 'u5', 'u13'], memberCount: 33 },
    { id: 'g3', name: 'Youth Wing', description: 'Youth cadre mobilization and campaigns.', avatarColor: '#203080', isBroadcast: false, members: ['u1', 'u5', 'u7', 'u11', 'u12', 'u14'], memberCount: 1240 },
    { id: 'g4', name: 'Women\'s Wing (Mahila)', description: 'Mahila cadre — welfare drives and outreach.', avatarColor: '#F4C016', isBroadcast: false, members: ['u1', 'u3', 'u8', 'u10', 'u14'], memberCount: 980 },
    { id: 'g5', name: 'Booth Volunteers', description: 'Ground-level booth management team.', avatarColor: '#005020', isBroadcast: false, members: ['u2', 'u6', 'u7', 'u9', 'u13'], memberCount: 4600 },
    { id: 'g6', name: 'Official Announcements 📢', description: 'Official party broadcasts. Only the leadership can post here.', avatarColor: '#203080', isBroadcast: true, members: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14'], memberCount: 48200 }
  ];
}

function getSeededRooms() {
  return [
    { id: 'r1', title: 'Public Meeting — Warangal 🔴', topic: 'Live public address to the party cadre and citizens.', hostId: 'u1', hostName: 'K. Kavitha', live: true, listeners: 3120, speakers: [
      { id: 'u1', name: 'K. Kavitha', role: 'leader', muted: false, speaking: true, avatarColor: '#F4C016' },
      { id: 'u2', name: 'K. T. Rama Rao', role: 'karyakarta', muted: false, speaking: false, avatarColor: '#005020' }
    ], _target: 11420 },
    { id: 'r2', title: 'Party Cadre Briefing', topic: 'Strategy briefing for coordinators ahead of the campaign.', hostId: 'u2', hostName: 'K. T. Rama Rao', live: true, listeners: 1840, speakers: [
      { id: 'u2', name: 'K. T. Rama Rao', role: 'karyakarta', muted: false, speaking: true, avatarColor: '#005020' },
      { id: 'u4', name: 'Srinivas Goud', role: 'karyakarta', muted: true, speaking: false, avatarColor: '#F4C016' },
      { id: 'u5', name: 'Manoj Kumar', role: 'karyakarta', muted: false, speaking: false, avatarColor: '#005020' }
    ], _target: 10250 },
    { id: 'r3', title: 'Policy Discussion: Farmers', topic: 'Roundtable on farmer welfare and irrigation policy.', hostId: 'u4', hostName: 'Srinivas Goud', live: false, listeners: 0, speakers: [
      { id: 'u4', name: 'Srinivas Goud', role: 'karyakarta', muted: false, speaking: false, avatarColor: '#F4C016' }
    ], _target: 0 },
    { id: 'r4', title: 'Youth Townhall', topic: 'Open townhall with the youth wing.', hostId: 'u5', hostName: 'Manoj Kumar', live: false, listeners: 0, speakers: [
      { id: 'u5', name: 'Manoj Kumar', role: 'karyakarta', muted: false, speaking: false, avatarColor: '#005020' }
    ], _target: 0 }
  ];
}

function loadLocalMockData() {
  usersMap.clear();
  groupsMap.clear();
  roomsMap.clear();

  const seededUsers = getSeededUsers();
  const seededGroups = getSeededGroups();
  const seededRooms = getSeededRooms();

  seededUsers.forEach(u => usersMap.set(u.id, u));
  seededGroups.forEach(g => groupsMap.set(g.id, g));
  seededRooms.forEach(r => roomsMap.set(r.id, r));

  renderChatsList();
  renderGroupsList();
  renderRoomsList();

  // Fill in Profile view info
  document.getElementById('my-profile-name').innerText = currentUser.name;
  document.getElementById('my-profile-avatar').innerText = getInitials(currentUser.name);
  document.getElementById('my-profile-avatar').style.backgroundColor = currentUser.avatarColor;
  document.getElementById('my-profile-role').innerText = currentUser.role;
  document.getElementById('my-profile-phone').innerText = currentUser.phone;
  document.getElementById('my-profile-title').innerText = currentUser.title || 'Party Member';
}

function initMockMessages() {
  mockDmMessages = {
    'u2': [
      { from: 'u2', fromName: 'K. T. Rama Rao', text: 'Jai Telangana! The Warangal public meeting plans are finalized.', ts: Date.now() - 3600000 * 2 },
      { from: 'u1', fromName: 'K. Kavitha', text: 'Excellent. Let\'s make sure the audio stage is ready.', ts: Date.now() - 3600000 }
    ],
    'u3': [
      { from: 'u3', fromName: 'Padma Devi Rao', text: 'Mahila wing is conducting a welfare drive tomorrow.', ts: Date.now() - 3600000 * 5 },
      { from: 'u1', fromName: 'K. Kavitha', text: 'Good work, keep it up.', ts: Date.now() - 3600000 * 4 }
    ],
    'u7': [
      { from: 'u7', fromName: 'Ravi Teja', text: 'Namaste Kavitha Garu, I am ready to handle booth management in Nizamabad.', ts: Date.now() - 3600000 }
    ]
  };

  mockGroupMessages = {
    'g6': [
      { from: 'u1', fromName: 'K. Kavitha', text: 'Welcome to the official Sabha broadcast channel! Keep checking here for official party updates.', ts: Date.now() - 3600000 * 12 },
      { from: 'u1', fromName: 'K. Kavitha', text: 'All booth volunteers are requested to mobilize for the Warangal public meeting this weekend. Let\'s make it a grand success! 🚩', ts: Date.now() - 3600000 * 3 }
    ],
    'g1': [
      { from: 'u2', fromName: 'K. T. Rama Rao', text: 'We need to review the manifest draft by this Friday.', ts: Date.now() - 3600000 * 4 },
      { from: 'u4', fromName: 'Srinivas Goud', text: 'I agree. Let\'s schedule a virtual Sabha tomorrow at 5 PM.', ts: Date.now() - 3600000 * 3 }
    ]
  };
}

function getMockReply(userId, text) {
  if (!userMessageCounts[userId]) {
    userMessageCounts[userId] = 0;
  }
  
  const count = userMessageCounts[userId];
  userMessageCounts[userId]++;

  // Custom realistic sequences for main members (No AI feel)
  if (userId === 'u2') { // KTR
    if (count === 0) return `Jai Telangana, Kavitha Garu. All arrangements for the Warangal public meeting are in place.`;
    if (count === 1) return `Yes, coordinating with the media and local leaders. We are expecting a massive turnout.`;
    return `I will update the official channel once the rally starts. 🚩`;
  }
  if (userId === 'u3') { // Padma Devi Rao
    if (count === 0) return `Namaste Garu! Our Mahila volunteers are actively mobilizing in all districts.`;
    if (count === 1) return `We are holding a booth-level coordinator meet tomorrow at 11 AM.`;
    return `Will share the meeting minutes here. Jai Telangana!`;
  }
  if (userId === 'u7') { // Ravi Teja
    if (count === 0) return `Namaste Kavitha Garu! I have mobilized 50 volunteers for the Nizamabad rally.`;
    if (count === 1) return `Yes, we are distributing flags and posters in every village.`;
    return `We will make the Sabha a huge success!`;
  }

  // General users sequence
  if (count === 0) return `Namaste Kavitha Garu! Ready for the campaign work. Please let us know the directions.`;
  if (count === 1) return `Sure, we will coordinate with our block coordinators.`;
  return `Jai Telangana! 🚩`;
}

function startMockGroupChatActivity() {
  if (mockGroupInterval) clearInterval(mockGroupInterval);
  
  const groupSimulations = {
    'g1': [
      { from: 'u4', fromName: 'Srinivas Goud', text: 'Let\'s finalize the route map for KTR Garu\'s roadshow.' },
      { from: 'u3', fromName: 'Padma Devi Rao', text: 'Mahila wing will join from Nizamabad circle.' },
      { from: 'u5', fromName: 'Manoj Kumar', text: 'Youth wing volunteers are handling the stage setup.' },
      { from: 'u2', fromName: 'K. T. Rama Rao', text: 'Excellent. Please coordinate with the local police for security permissions.' }
    ],
    'g2': [
      { from: 'u4', fromName: 'Srinivas Goud', text: 'Nizamabad reporting: 90% booths successfully seeded.' },
      { from: 'u3', fromName: 'Padma Devi Rao', text: 'Warangal reports are uploaded to the portal.' },
      { from: 'u5', fromName: 'Manoj Kumar', text: 'Youth mobilization reports are ready for review.' }
    ],
    'g3': [
      { from: 'u5', fromName: 'Manoj Kumar', text: 'All youth wing members, please gather at party office tomorrow by 9 AM.' },
      { from: 'u11', fromName: 'Praveen Chary', text: 'Sure Anna, coming with 20 volunteers from my ward.' },
      { from: 'u12', fromName: 'Deepthi Reddy', text: 'Banners and flags are ready for distribution.' }
    ]
  };

  mockGroupInterval = setInterval(() => {
    if (!activeGroupId || !groupSimulations[activeGroupId]) return;
    
    const pool = groupSimulations[activeGroupId];
    const item = pool[Math.floor(Math.random() * pool.length)];
    
    const msgObj = {
      from: item.from,
      fromName: item.fromName,
      text: item.text,
      ts: Date.now(),
      chatId: activeGroupId
    };
    
    if (!mockGroupMessages[activeGroupId]) mockGroupMessages[activeGroupId] = [];
    
    const len = mockGroupMessages[activeGroupId].length;
    if (len > 0 && mockGroupMessages[activeGroupId][len - 1].text === msgObj.text) return;
    
    mockGroupMessages[activeGroupId].push(msgObj);
    
    if (activeTab === 'groups' && activeGroupId === msgObj.chatId) {
      const box = document.getElementById('group-messages-box');
      const emptyPlaceholder = box.querySelector('.system-message');
      if (emptyPlaceholder) emptyPlaceholder.remove();
      
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble incoming';
      bubble.innerHTML = `
        <span class="message-sender">${msgObj.fromName}</span>
        <span class="message-text">${escapeHTML(msgObj.text)}</span>
        <span class="message-meta">${formatTime(msgObj.ts)}</span>
      `;
      box.appendChild(bubble);
      scrollToBottom(box);
    }
  }, 10000); // Trigger message every 10 seconds to feel live
}

function initMockSocketConnection() {
  mockSocketListeners = {};
  socket = {
    id: 'mock_socket_' + Math.random().toString(36).substr(2, 9),
    emit: (event, data) => {
      console.log(`[mock-socket] emit: ${event}`, data);
      handleMockSocketEmit(event, data);
    },
    on: (event, callback) => {
      console.log(`[mock-socket] register listener: ${event}`);
      if (!mockSocketListeners[event]) {
        mockSocketListeners[event] = [];
      }
      mockSocketListeners[event].push(callback);
    },
    disconnect: () => {
      console.log('[mock-socket] disconnected');
      if (mockRoomInterval) clearInterval(mockRoomInterval);
      if (mockHandRaiseTimeout) clearTimeout(mockHandRaiseTimeout);
      if (mockGroupInterval) clearInterval(mockGroupInterval);
    }
  };
  setTimeout(() => {
    triggerMockSocketEvent('connect');
  }, 100);
}

let mockSocketListeners = {};
function triggerMockSocketEvent(event, data) {
  if (mockSocketListeners[event]) {
    mockSocketListeners[event].forEach(cb => cb(data));
  }
}

function handleMockSocketEmit(event, data) {
  if (event === 'room:join') {
    const roomId = data.roomId;
    const room = roomsMap.get(roomId);
    if (!room) return;

    if (mockRoomInterval) clearInterval(mockRoomInterval);
    if (mockHandRaiseTimeout) clearTimeout(mockHandRaiseTimeout);

    mockRoomInterval = setInterval(() => {
      if (activeRoomId !== roomId) {
        clearInterval(mockRoomInterval);
        return;
      }
      
      // Grow listeners towards target
      if (room.listeners < room._target) {
        const step = Math.floor(Math.random() * 45) + 15;
        room.listeners = Math.min(room.listeners + step, room._target);
        document.getElementById('room-listener-count').innerText = room.listeners.toLocaleString();
      }

      // Random user reaction emojis
      if (Math.random() < 0.6) {
        const emojis = ['👏', '❤️', '🚩', '🙌', '🔥'];
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        spawnFloatingEmoji(randomEmoji);
      }

      // Random speaking status animation
      if (Math.random() < 0.25 && room.speakers.length > 0) {
        const updatedSpeakers = room.speakers.map(s => {
          return {
            ...s,
            speaking: s.muted ? false : Math.random() < 0.4
          };
        });
        renderRoomSpeakers(updatedSpeakers);
      }
    }, 1000);

    // If I am the host (KK), simulate a handraise request from another user after 5s
    if (room.hostId === currentUser.id) {
      mockHandRaiseTimeout = setTimeout(() => {
        if (activeRoomId === roomId) {
          const eligible = getSeededUsers().find(u => u.id !== currentUser.id && !room.speakers.some(s => s.id === u.id));
          if (eligible) {
            showHandRaiseNotification(eligible.id, eligible.name);
          }
        }
      }, 5000);
    }
  }
  else if (event === 'room:leave') {
    if (mockRoomInterval) clearInterval(mockRoomInterval);
    if (mockHandRaiseTimeout) clearTimeout(mockHandRaiseTimeout);
  }
  else if (event === 'room:raiseHand') {
    const roomId = data.roomId;
    const room = roomsMap.get(roomId);
    if (!room) return;

    // Simulate host approval after 4 seconds
    setTimeout(() => {
      if (activeRoomId === roomId) {
        const isAlreadySpeaker = room.speakers.some(s => s.id === currentUser.id);
        if (!isAlreadySpeaker) {
          const mySpeakerState = {
            id: currentUser.id,
            name: currentUser.name,
            role: currentUser.role,
            muted: false,
            speaking: false,
            avatarColor: currentUser.avatarColor
          };
          room.speakers.push(mySpeakerState);
          renderRoomSpeakers(room.speakers);
          updateUserSpeakerControls(room.speakers);
          
          alert("Host promoted you to speaker. Your mic is now active.");
          const muteBtn = document.getElementById('speaker-mute-btn');
          muteBtn.classList.remove('hidden');
          muteBtn.className = 'control-btn active-speaking-control';
          muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Mute Mic';
          
          const raiseBtn = document.getElementById('listener-raise-btn');
          raiseBtn.classList.add('hidden');
        }
      }
    }, 4000);
  }
  else if (event === 'room:inviteToSpeak') {
    const roomId = data.roomId;
    const userId = data.userId;
    const room = roomsMap.get(roomId);
    if (room && userId) {
      const user = usersMap.get(userId);
      if (user && !room.speakers.some(s => s.id === userId)) {
        room.speakers.push({
          id: user.id,
          name: user.name,
          role: user.role,
          muted: false,
          speaking: false,
          avatarColor: user.avatarColor
        });
        renderRoomSpeakers(room.speakers);
      }
    }
  }
  else if (event === 'room:muteToggle') {
    const roomId = data.roomId;
    const muted = data.muted;
    const room = roomsMap.get(roomId);
    if (room) {
      const speakerState = room.speakers.find(s => s.id === currentUser.id);
      if (speakerState) {
        speakerState.muted = muted;
        speakerState.speaking = false;
        renderRoomSpeakers(room.speakers);
        updateUserSpeakerControls(room.speakers);
      }
    }
  }
  else if (event === 'call:invite') {
    const peerId = data.to;
    setTimeout(() => {
      if (activeCall && activeCall.peerId === peerId && activeCall.role === 'caller') {
        handleCallAcceptedByPeer('mock_call_id');
      }
    }, 2000);
  }
}
