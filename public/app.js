// The settings page. Everything it shows is put on the page with textContent, never as HTML, because
// some of it (a device's name) is written by whoever owns the device.

import { pick, translate } from './i18n.js';

const lang = pick(navigator.language);
const t = (key, values) => translate(lang, key, values);
const $ = (id) => document.getElementById(id);

document.documentElement.lang = lang;
document.title = t('title');
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
for (const el of document.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);

/** What the parent has ticked, by address. Kept between refreshes so a refresh never undoes a tick. */
const chosen = new Map();
let clients = [];
let status = null;
let dirty = false;
let pollTimer = null;
let polls = 0;

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fmm-unifi', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await response.json(); } catch { /* an error page, or nothing */ }
  return { ok: response.ok, status: response.status, data };
}

function show(el, visible) { el.hidden = !visible; }

// -- Signing in ------------------------------------------------------------------------------------

async function start() {
  const { data } = await api('GET', '/api/session');
  if (data?.authenticated) await enter(); else leave();
}

function leave(message) {
  clearTimeout(pollTimer);
  show($('app'), false);
  show($('signout'), false);
  show($('login'), true);
  const error = $('login-error');
  error.textContent = message ?? '';
  show(error, Boolean(message));
}

async function enter() {
  show($('login'), false);
  show($('app'), true);
  show($('signout'), true);
  await Promise.all([refreshStatus(true), refreshClients()]);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api('POST', '/api/login', { token: $('token').value });
  $('token').value = '';

  if (result.ok) return enter();
  leave(result.status === 429 ? t('tooManyTries') : t('wrongToken'));
});

$('signout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  leave();
});

// -- Status ----------------------------------------------------------------------------------------

async function refreshStatus(adopt = false) {
  clearTimeout(pollTimer);
  const result = await api('GET', '/api/status');

  if (result.status === 401) return leave(t('sessionEnded'));
  if (result.ok) {
    status = result.data;
    render(adopt);
    // The device list is asked for less often than the status: it costs UniFi a request.
    polls += 1;
    if (!adopt && polls % 4 === 0) refreshClients();
  }

  // Quiet while it is hidden: no reason to ask a service about a page nobody is looking at.
  pollTimer = setTimeout(refreshStatus, document.hidden ? 30_000 : 4_000);
}

function renderStatus() {
  const { fmm, unifi } = status;

  $('dot-fmm').className = `dot ${fmm.reachable ? 'good' : 'bad'}`;
  $('line-fmm').textContent = fmm.reachable
    ? (fmm.computer ? t('fmmOk', { name: fmm.computer.name }) : t('fmmOkNoName'))
    : t('fmmDown');

  const unifiState = unifi.problem ? 'bad' : unifi.ok ? 'good' : 'wait';
  $('dot-unifi').className = `dot ${unifiState}`;
  $('line-unifi').textContent = unifi.problem ? t('unifiDown') : unifi.ok ? t('unifiOk') : t('unifiWaiting');

  // What the services said is shown as words, never as markup.
  const problem = fmm.problem ?? unifi.problem;
  $('fmm-problem').textContent = problem ?? '';
  show($('fmm-problem'), Boolean(problem));

  const blocked = status.devices.filter((d) => d.blocked && d.blockedByUs).length;
  const summary = blocked === 0 ? t('nothingBlocked') : blocked === 1 ? t('blockingOne') : t('blockingMany', { n: blocked });
  $('now').textContent = `${summary} ${t(`reason.${status.code}`)}`;

  $('not-running-help').textContent = t('modeNotRunningHelp', { minutes: Math.round(status.failOpenSeconds / 60) });
}

function renderEvents() {
  const list = $('events');
  list.replaceChildren();

  for (const event of status.events) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = event.at;
    time.textContent = new Date(event.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    const text = document.createElement('span');
    text.textContent = t(`event.${event.kind}`, { name: event.name });
    item.append(time, text);
    list.append(item);
  }

  show($('no-events'), status.events.length === 0);
}

// -- Devices ---------------------------------------------------------------------------------------

async function refreshClients() {
  const result = await api('GET', '/api/clients');
  if (result.status === 401) return leave(t('sessionEnded'));

  const error = $('clients-error');
  if (result.ok) {
    clients = result.data.clients;
    show(error, false);
  } else {
    error.textContent = t('clientsFailed', { message: result.data?.error ?? '' });
    show(error, true);
  }
  renderDevices();
}

function renderDevices() {
  // Devices that were chosen but that UniFi did not list still show, so they can be unticked.
  const known = new Set(clients.map((c) => c.mac));
  const rows = [
    ...clients,
    ...[...chosen].filter(([mac]) => !known.has(mac)).map(([mac, label]) => ({ mac, name: label || mac, ip: null, online: false, blocked: false })),
  ];

  const query = $('search').value.trim().toLowerCase();
  const claimed = new Set(status?.devices.filter((d) => d.blockedByUs).map((d) => d.mac));
  const list = $('devices');
  list.replaceChildren();

  let shown = 0;
  for (const client of rows) {
    if (query && !`${client.name} ${client.mac} ${client.ip ?? ''}`.toLowerCase().includes(query)) continue;
    shown += 1;

    const item = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', client.name);
    box.checked = chosen.has(client.mac);
    box.addEventListener('change', () => {
      if (box.checked) chosen.set(client.mac, client.name); else chosen.delete(client.mac);
      dirty = true;
      show($('saved'), false);
    });

    const text = document.createElement('span');
    text.className = 'name';
    const name = document.createElement('strong');
    name.textContent = client.name;
    const detail = document.createElement('small');
    detail.textContent = [client.ip, client.mac].filter(Boolean).join(' · ');
    text.append(name, detail);

    const tags = document.createElement('span');
    tags.className = 'tags';
    tags.append(tag(client.online ? t('online') : t('offline'), client.online ? 'good' : ''));
    if (client.blocked && claimed.has(client.mac)) tags.append(tag(t('blockedNow'), 'bad'));
    else if (client.blocked) tags.append(tag(t('blockedInUnifi'), 'warn'));

    label.append(box, text, tags);
    item.append(label);
    list.append(item);
  }

  show($('no-devices'), shown === 0);
}

function tag(text, kind) {
  const span = document.createElement('span');
  span.className = `tag ${kind}`;
  span.textContent = text;
  return span;
}

$('search').addEventListener('input', renderDevices);

// -- Saving ----------------------------------------------------------------------------------------

function render(adopt) {
  renderStatus();
  renderEvents();

  // What the page shows follows what is saved, until the parent starts changing it.
  if (adopt || !dirty) {
    chosen.clear();
    for (const d of status.devices) chosen.set(d.mac, d.label);
    for (const radio of document.querySelectorAll('input[name=mode]')) radio.checked = radio.value === status.mode;
    renderDevices();
  }
}

document.querySelectorAll('input[name=mode]').forEach((radio) => radio.addEventListener('change', () => {
  dirty = true;
  show($('saved'), false);
}));

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  show($('saved'), false);
  show($('save-error'), false);

  const mode = document.querySelector('input[name=mode]:checked')?.value ?? 'locked';
  const devices = [...chosen].map(([mac, label]) => ({ mac, label }));
  const result = await api('PUT', '/api/settings', { mode, devices });

  if (result.status === 401) return leave(t('sessionEnded'));
  if (!result.ok) {
    $('save-error').textContent = t('saveFailed', { message: result.data?.error ?? '' });
    return show($('save-error'), true);
  }

  dirty = false;
  status = result.data;
  $('saved').textContent = t('saved');
  show($('saved'), true);
  render(true);
  refreshClients();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('app').hidden) refreshStatus(); });

start();
