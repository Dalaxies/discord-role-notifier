const MAX_CLIENT_LOGS = 400;

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };

const ERROR_MESSAGES = {
  not_configured:
    'Login is not configured yet. Add DISCORD_CLIENT_SECRET to .env, then restart the bot.',
  access_denied: 'Discord login was cancelled.',
  not_admin: 'That Discord account cannot manage this server.',
  state: 'The login attempt expired. Please try again.',
  login_failed: 'Discord login failed. Check the bot logs for details.',
};

const state = {
  csrf: null,
  roleId: null,
  savedMessage: '',
  logs: [],
  seq: new Set(),
  paused: false,
  stream: null,
};

const el = (id) => document.getElementById(id);

const els = {
  login: el('login'),
  loginLink: el('login-link'),
  loginNote: el('login-note'),
  dashboard: el('dashboard'),
  account: el('account'),
  avatar: el('avatar'),
  username: el('username'),
  guildPill: el('guild-pill'),
  logout: el('logout'),
  roleSelect: el('role-select'),
  roleTag: el('role-tag'),
  roleHint: el('role-hint'),
  saveRole: el('save-role'),
  logChannelSelect: el('log-channel-select'),
  logChannelTag: el('log-channel-tag'),
  logChannelHint: el('log-channel-hint'),
  saveLogChannel: el('save-log-channel'),
  message: el('message'),
  messageFile: el('message-file'),
  counter: el('counter'),
  saveMessage: el('save-message'),
  logs: el('logs'),
  logEmpty: el('log-empty'),
  level: el('level'),
  pause: el('pause'),
  toast: el('toast'),
};

let toastTimer = null;

function show(element) {
  element.hidden = false;
}

function hide(element) {
  element.hidden = true;
}

function toast(message, kind = 'success') {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  show(els.toast);

  toastTimer = setTimeout(() => hide(els.toast), 4000);
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};

  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = state.csrf ?? '';

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401) {
    signedOut('Your session expired. Sign in again.');
    throw new Error('Sign in again.');
  }

  const data = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status}).`);

  return data;
}

function signedOut(message) {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }

  hide(els.dashboard);
  hide(els.account);
  show(els.login);

  if (message) {
    els.loginNote.textContent = message;
    show(els.loginNote);
  }
}

function showLogin(session, errorCode) {
  signedOut('');

  els.loginLink.hidden = !session?.configured;
  hide(els.loginNote);

  if (errorCode) {
    els.loginNote.textContent = ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Try again.';
    show(els.loginNote);
  } else if (!session?.configured) {
    els.loginNote.textContent = ERROR_MESSAGES.not_configured;
    show(els.loginNote);
  }
}

async function openDashboard(session) {
  hide(els.login);
  show(els.dashboard);
  show(els.account);

  els.username.textContent = session.user.displayName;
  els.avatar.src = session.user.avatarUrl;
  els.avatar.alt = session.user.displayName;
  els.guildPill.textContent = session.guild ? session.guild.name : 'No server';

  try {
    await loadState();
    await loadLogs();
    connectStream();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadState() {
  const data = await request('/api/state');
  state.roleId = data.role.id;

  els.roleSelect.replaceChildren();

  const known = new Set();

  for (const role of data.roles) {
    const option = document.createElement('option');
    option.value = role.id;
    option.textContent = role.name + (role.managed ? ' (managed)' : '');
    els.roleSelect.append(option);
    known.add(role.id);
  }

  if (!known.has(data.role.id)) {
    const option = document.createElement('option');
    option.value = data.role.id;
    option.textContent = data.role.name ?? `Unknown role ${data.role.id}`;
    els.roleSelect.append(option);
  }

  els.roleSelect.value = data.role.id;
  els.roleTag.textContent = data.role.name ?? `Unknown role ${data.role.id}`;
  els.roleHint.textContent = data.updatedAt
    ? `Last changed ${new Date(data.updatedAt).toLocaleString()}${data.updatedBy ? ` by ${data.updatedBy}` : ''}`
    : '';
  els.roleHint.classList.remove('warn');

  if (data.roles.length === 0) {
    els.roleHint.textContent = 'Role list unavailable — is the bot connected?';
    els.roleHint.classList.add('warn');
  }

  els.logChannelSelect.replaceChildren();

  const knownChannels = new Set();

  for (const channel of data.channels) {
    const option = document.createElement('option');
    option.value = channel.id;
    option.textContent = `#${channel.name}`;
    els.logChannelSelect.append(option);
    knownChannels.add(channel.id);
  }

  if (data.logChannel?.id && !knownChannels.has(data.logChannel.id)) {
    const option = document.createElement('option');
    option.value = data.logChannel.id;
    option.textContent = data.logChannel.name
      ? `#${data.logChannel.name}`
      : `Unknown channel ${data.logChannel.id}`;
    els.logChannelSelect.append(option);
  }

  if (data.logChannel?.id) {
    els.logChannelSelect.value = data.logChannel.id;
    els.logChannelTag.textContent = data.logChannel.name
      ? `#${data.logChannel.name}`
      : `Unknown channel ${data.logChannel.id}`;
    els.logChannelHint.textContent = '';
    els.logChannelHint.classList.remove('warn');
  } else {
    els.logChannelTag.textContent = 'Not set';
    els.logChannelHint.textContent = 'Set a channel to start recording DMs.';
    els.logChannelHint.classList.add('warn');
  }

  if (data.channels.length === 0) {
    els.logChannelHint.textContent = 'Channel list unavailable — is the bot connected?';
    els.logChannelHint.classList.add('warn');
  }

  els.message.value = data.message;
  state.savedMessage = data.message;
  els.messageFile.textContent = data.messageFile ?? 'no template file';

  if (!data.messageFile) {
    els.message.disabled = true;
    els.saveMessage.disabled = true;
    els.counter.textContent = 'Set MESSAGE_TEMPLATE_FILE in .env to edit here.';
    els.counter.classList.add('warn');
  } else {
    els.message.disabled = false;
    els.saveMessage.disabled = false;
    els.counter.classList.remove('warn');
    updateCounter();
  }
}

function updateCounter() {
  const length = els.message.value.length;
  const unsaved = els.message.value !== state.savedMessage;

  els.counter.textContent = `${length} / 2000${unsaved ? ' · unsaved' : ''}`;
  els.counter.classList.toggle('warn', length > 2000 || unsaved);
}

async function saveRole() {
  const roleId = els.roleSelect.value;
  if (!roleId) return;

  els.saveRole.disabled = true;
  els.saveRole.textContent = 'Saving…';

  try {
    const data = await request('/api/role', { method: 'PUT', body: { roleId } });
    state.roleId = data.role.id;
    els.roleTag.textContent = data.role.name;
    els.roleHint.textContent = 'Saved — applies to the next role assignment.';
    els.roleHint.classList.remove('warn');
    toast(`Welcome role set to ${data.role.name}.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    els.saveRole.disabled = false;
    els.saveRole.textContent = 'Save role';
  }
}

async function saveLogChannel() {
  const logChannelId = els.logChannelSelect.value;
  if (!logChannelId) return;

  els.saveLogChannel.disabled = true;
  els.saveLogChannel.textContent = 'Saving…';

  try {
    const data = await request('/api/log-channel', { method: 'PUT', body: { logChannelId } });
    els.logChannelTag.textContent = `#${data.logChannel.name}`;
    els.logChannelHint.textContent = 'Saved — applies to the next DM.';
    els.logChannelHint.classList.remove('warn');
    toast(`Admin log channel set to #${data.logChannel.name}.`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    els.saveLogChannel.disabled = false;
    els.saveLogChannel.textContent = 'Save channel';
  }
}

async function saveMessage() {
  const message = els.message.value;

  els.saveMessage.disabled = true;
  els.saveMessage.textContent = 'Saving…';

  try {
    const data = await request('/api/message', { method: 'PUT', body: { message } });
    state.savedMessage = els.message.value.trim();
    els.message.value = state.savedMessage;
    updateCounter();
    toast(`Welcome message saved (${data.length} characters).`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    els.saveMessage.disabled = false;
    els.saveMessage.textContent = 'Save message';
  }
}

function levelAllowed(level) {
  const filter = els.level.value;
  if (filter === 'all') return true;

  const threshold = LEVEL_ORDER[filter];
  return (LEVEL_ORDER[level] ?? 3) <= threshold;
}

function addRow(entry) {
  const row = document.createElement('li');
  row.className = `log-row level-${entry.level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(entry.time).toLocaleTimeString([], { hour12: false });

  const badge = document.createElement('span');
  badge.className = 'log-badge';
  badge.textContent = entry.level;

  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = entry.message;

  row.append(time, badge, message);
  els.logs.append(row);
}

function renderLogs() {
  els.logs.replaceChildren();

  for (const entry of state.logs) {
    if (levelAllowed(entry.level)) addRow(entry);
  }

  updateEmptyState();
}

function updateEmptyState() {
  const hasRows = els.logs.childElementCount > 0;
  els.logEmpty.hidden = hasRows;
  els.logs.hidden = !hasRows;
}

function appendLog(entry) {
  if (state.seq.has(entry.seq)) return;

  state.seq.add(entry.seq);
  state.logs.push(entry);

  if (state.logs.length > MAX_CLIENT_LOGS) {
    const removed = state.logs.shift();
    state.seq.delete(removed.seq);
  }

  if (!state.paused && levelAllowed(entry.level)) addRow(entry);
  updateEmptyState();
}

async function loadLogs() {
  const data = await request('/api/logs?since=0&limit=200');

  state.logs = [];
  state.seq.clear();

  for (const entry of data.entries) appendLog(entry);

  renderLogs();
}

function connectStream() {
  if (state.stream) state.stream.close();

  const source = new EventSource('/api/logs/stream');

  source.onmessage = (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames; EventSource keeps the connection alive.
    }
  };

  state.stream = source;
}

async function signOut() {
  els.logout.disabled = true;

  try {
    await request('/auth/logout', { method: 'POST' });
    location.reload();
  } catch (error) {
    toast(error.message, 'error');
    els.logout.disabled = false;
  }
}

function wireEvents() {
  els.saveRole.addEventListener('click', saveRole);
  els.saveLogChannel.addEventListener('click', saveLogChannel);
  els.saveMessage.addEventListener('click', saveMessage);
  els.logout.addEventListener('click', signOut);
  els.message.addEventListener('input', updateCounter);
  els.level.addEventListener('change', renderLogs);

  els.pause.addEventListener('change', () => {
    state.paused = els.pause.checked;
    if (!state.paused) renderLogs();
  });
}

async function boot() {
  wireEvents();

  const errorCode = new URLSearchParams(location.search).get('error');
  if (errorCode) history.replaceState({}, '', '/');

  try {
    const session = await fetch('/api/session').then((response) => response.json());
    state.csrf = session.csrf ?? null;

    if (session.authenticated) {
      await openDashboard(session);
    } else {
      showLogin(session, errorCode);
    }
  } catch {
    showLogin({ configured: true }, errorCode);
    toast('Could not reach the bot. Is it running?', 'error');
  }
}

boot();
