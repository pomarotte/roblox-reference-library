'use strict';
const get = id => document.getElementById(id);
const form = get('connection'), keyInput = get('key'), refresh = get('refresh');
const disconnect = get('disconnect'), status = get('connection-status'), panel = get('performance');
const gameSelect = get('games'), universeInput = get('universe'), nameInput = get('game-name');
const activationInput = get('activated'), trend = get('trend'), metricSelect = get('trend-metric');
const numbers = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {style: 'percent', maximumFractionDigits: 2});
const localTime = value => new Date(value).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
const utcDay = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});
const chartColors = ['#79cafa', '#f5ab79', '#b5a5ff', '#79daba', '#f292b6'];
const games = new Map();
let connection, activeRequest, activityRequest;

async function responseData(response) {
  if (response.redirected || !response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('Your sign-in may have expired. Reload the dashboard to sign in again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

fetch('/api/session').then(responseData).then(({email}) => { get('account').textContent = email; })
  .catch(error => { status.textContent = error.message; });

function chartRows(element, rows, label, maximum, value, format, leader) {
  element.replaceChildren(...rows.map(row => {
    const item = document.createElement('li'), id = document.createElement('span');
    const number = document.createElement('strong'), bar = document.createElement('progress');
    item.className = 'chart-row';
    id.textContent = `${row.homeId}${leader === row ? ' · Leader' : ''}`;
    const amount = value(row);
    number.textContent = amount == null ? '—' : format(amount);
    bar.max = maximum;
    bar.value = Math.min(amount ?? 0, maximum);
    bar.hidden = amount == null;
    bar.setAttribute('aria-label', `${label} for ${row.homeId}`);
    item.append(id, number, bar);
    return item;
  }));
}

function drawTrend() {
  const data = connection?.data;
  if (!data || get('trend-card').hidden || panel.hidden) return;
  const width = trend.clientWidth, height = trend.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  trend.width = Math.round(width * ratio);
  trend.height = Math.round(height * ratio);
  const context = trend.getContext('2d');
  if (!context) return;
  context.scale(ratio, ratio);
  const showingViews = metricSelect.value === 'views';
  const format = showingViews ? value => numbers.format(value) : value => percent.format(value);
  const value = point => showingViews ? point.impressions : point.qualifiedPlays / point.impressions;
  const {rows, trendHours} = data;
  const points = rows.flatMap(row => row.timeline);
  const first = Math.min(...points.map(point => point.at)), last = Math.max(...points.map(point => point.at));
  const gap = trendHours * 3_600_000;
  const maxValue = Math.max(...points.map(value));
  const maximum = showingViews ? Math.max(4, Math.ceil(maxValue / 4) * 4)
    : Math.max(.01, Math.ceil(maxValue * 100) / 100);
  const top = 12, bottom = height - 27, right = width - 12;
  context.font = '12px system-ui';
  const left = Math.max(46, context.measureText(format(maximum)).width + 14);
  const x = at => first === last ? (left + right) / 2 : left + (right - left) * (at - first) / (last - first);
  const y = amount => bottom - (bottom - top) * amount / maximum;
  context.textBaseline = 'middle';
  context.textAlign = 'right';
  for (let step = 0; step <= 4; step++) {
    const amount = maximum * step / 4, position = y(amount);
    context.strokeStyle = '#343440';
    context.beginPath();
    context.moveTo(left, position);
    context.lineTo(right, position);
    context.stroke();
    context.fillStyle = '#b0afbb';
    context.fillText(format(amount), left - 8, position);
  }
  for (const [index, row] of rows.entries()) {
    context.strokeStyle = context.fillStyle = chartColors[index];
    context.lineWidth = 2;
    context.beginPath();
    let previous;
    for (const point of row.timeline) {
      if (previous && point.at - previous.at <= gap) context.lineTo(x(point.at), y(value(point)));
      else context.moveTo(x(point.at), y(value(point)));
      previous = point;
    }
    context.stroke();
    for (const point of row.timeline) {
      context.beginPath();
      context.arc(x(point.at), y(value(point)), 2.5, 0, 2 * Math.PI);
      context.fill();
    }
  }
  const formatTime = trendHours === 24 ? at => utcDay.format(at)
    : at => new Date(at).toLocaleTimeString(undefined, {hour: 'numeric'});
  context.fillStyle = '#b0afbb';
  context.textAlign = 'left';
  context.fillText(formatTime(first), left, height - 10);
  if (last !== first) {
    context.textAlign = 'right';
    context.fillText(formatTime(last), right, height - 10);
  }
}

function render({rows, checkedAt, windowStart, windowEnd, minimum, trendHours}) {
  const low = rows.length ? Math.min(...rows.map(row => row.impressions)) : 0;
  const ready = low >= minimum;
  const leader = ready && rows[0]?.qualifiedPlayRate > rows.at(-1)?.qualifiedPlayRate ? rows[0] : null;
  get('slots').textContent = `${rows.length} / 5`;
  get('traffic').textContent = `${numbers.format(low)} / ${numbers.format(minimum)}`;
  get('readiness').textContent = rows.length < 2 ? 'Activate at least two thumbnails'
    : rows.length < 5 ? 'Open slot available'
      : !ready ? 'Waiting for impressions' : leader ? 'Eligible for a challenger' : 'Waiting to break a tie';
  get('checked').textContent = `Updated ${localTime(checkedAt)}`;
  get('window').textContent = new Date(windowStart) < new Date(windowEnd)
    ? `Shared reporting hours from ${localTime(windowStart)} to ${localTime(windowEnd)}`
    : 'Waiting for the first full reporting hour.';
  get('scores').replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    for (const value of [
      `${row.homeId}${leader === row ? ' · Leader' : ''}`,
      numbers.format(row.impressions), numbers.format(row.qualifiedPlays),
      row.qualifiedPlayRate == null ? '—' : percent.format(row.qualifiedPlayRate)
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    return tr;
  }));
  const hasData = rows.some(row => row.impressions > 0);
  get('charts').hidden = !hasData;
  get('exact-data').hidden = !rows.length;
  get('empty-performance').hidden = hasData;
  get('empty-performance').textContent = rows.length
    ? 'Waiting for completed reporting hours shared by all active thumbnails.'
    : 'Roblox returned no active Home thumbnails for this game.';
  const bestRate = Math.max(0, ...rows.map(row => row.qualifiedPlayRate ?? 0));
  const rateMax = Math.max(.01, Math.ceil(bestRate * 100) / 100);
  get('rate-scale').textContent = `Scale 0–${percent.format(rateMax)}`;
  chartRows(get('rates'), rows, 'Qualified play rate', rateMax, row => row.qualifiedPlayRate, value => percent.format(value), leader);
  chartRows(get('impressions'), rows, 'Progress to the impression minimum', minimum, row => row.impressions,
    value => `${numbers.format(value)} / ${numbers.format(minimum)}`, leader);
  get('trend-card').hidden = !rows.some(row => row.timeline?.length);
  get('trend-timezone').textContent = trendHours === 24 ? 'By UTC day · Shared reporting hours only' : 'By local hour · Shared reporting hours only';
  get('trend-legend').replaceChildren(...rows.map((row, index) => {
    const item = document.createElement('li'), dot = document.createElement('span');
    dot.textContent = '●';
    dot.style.color = chartColors[index];
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, row.homeId);
    return item;
  }));
  panel.hidden = false;
  drawTrend();
}

function renderGames() {
  gameSelect.replaceChildren(new Option('Add a game', ''), ...[...games.values()].map(game =>
    new Option(game.name ? `${game.name} · ${game.universe}` : `Universe ${game.universe}`, game.universe)));
  gameSelect.value = games.has(connection?.universe) ? connection.universe : '';
  get('game-switcher').hidden = !games.size;
}

async function loadPerformance() {
  if (!connection || activeRequest) return;
  const {key, universe, activatedAt} = connection;
  const request = activeRequest = new AbortController();
  refresh.disabled = true;
  status.textContent = 'Checking Roblox analytics…';
  try {
    const response = await fetch('/api/performance', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key, universe, activatedAt}), signal: request.signal
    });
    const data = await responseData(response);
    if (activeRequest !== request) return;
    connection.data = data;
    games.set(universe, connection);
    renderGames();
    disconnect.hidden = false;
    universeInput.readOnly = true;
    keyInput.required = false;
    render(data);
    status.textContent = '';
    keyInput.placeholder = 'Connected for this tab';
    refresh.textContent = 'Refresh analytics';
    updateActivity();
  } catch (error) {
    if (activeRequest === request) status.textContent = error.message;
  } finally {
    if (activeRequest === request) {
      activeRequest = undefined;
      refresh.disabled = false;
    }
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (activeRequest) return;
  const universe = universeInput.value.trim();
  const existing = games.get(universe);
  const key = keyInput.value.trim() || existing?.key;
  const time = activationInput.value;
  const activatedAt = time === existing?.localActivation ? existing.activatedAt
    : time ? new Date(time).toISOString() : undefined;
  if (!key) return;
  if (connection?.universe !== universe) {
    panel.hidden = true;
    get('scores').replaceChildren();
  }
  connection = {key, universe, activatedAt, localActivation: time, name: nameInput.value.trim(),
    data: existing?.data, activity: existing?.activity};
  keyInput.required = !existing;
  keyInput.value = '';
  loadPerformance();
});

function showGame(game) {
  activeRequest?.abort();
  activityRequest?.abort();
  activeRequest = undefined;
  activityRequest = undefined;
  connection = game;
  universeInput.value = game?.universe || '';
  universeInput.readOnly = Boolean(game);
  nameInput.value = game?.name || '';
  activationInput.value = game?.localActivation || '';
  keyInput.value = '';
  keyInput.placeholder = game ? 'Connected for this tab' : '';
  keyInput.required = !game;
  refresh.textContent = game ? 'Refresh analytics' : 'Connect and load';
  refresh.disabled = false;
  disconnect.hidden = !game;
  panel.hidden = !game?.data;
  status.textContent = '';
  renderGames();
  if (game?.data) render(game.data);
  get('activity-empty').hidden = Boolean(game);
  get('activity-connected').hidden = !game;
  get('activity-setup').open = false;
  get('watcher-token').value = '';
  get('watcher-token-field').hidden = true;
  get('copy-token').textContent = 'Copy PowerShell setup';
  renderActivity(game?.activity);
}
get('add-game').addEventListener('click', () => { showGame(); universeInput.focus(); });
gameSelect.addEventListener('change', () => {
  showGame(games.get(gameSelect.value));
  updateActivity();
  loadPerformance();
});
disconnect.addEventListener('click', () => {
  games.delete(connection?.universe);
  showGame(games.values().next().value);
});
window.addEventListener('pagehide', () => { games.clear(); showGame(); });
metricSelect.addEventListener('change', drawTrend);
new ResizeObserver(drawTrend).observe(trend);
setInterval(() => { if (!document.hidden) loadPerformance(); }, 5 * 60 * 1000);

function renderActivity(activity) {
  const {paired, events = []} = activity || {};
  const latest = events[0];
  get('pair-watcher').textContent = paired ? 'Replace watcher token' : 'Generate watcher token';
  get('unpair-watcher').hidden = !paired;
  get('activity-status').textContent = latest?.nextCheck
    ? `Next check ${localTime(latest.nextCheck)} · Challenger ${latest.challenger}`
    : latest ? `Last check-in ${localTime(latest.at)} · Challenger ${latest.challenger}`
      : paired ? 'Waiting for the first watcher check-in.' : 'Connect the local watcher to see live rotation updates.';
  get('events').replaceChildren(...events.map(event => {
    const item = document.createElement('li'), time = document.createElement('time');
    const message = document.createElement('p');
    item.dataset.status = event.status;
    time.dateTime = new Date(event.at).toISOString();
    time.textContent = localTime(event.at);
    message.textContent = event.message;
    item.append(message, time);
    return item;
  }));
}

function activityUrl(game) {
  return `/api/activity?universe=${encodeURIComponent(game.universe)}`;
}

async function updateActivity() {
  const game = connection;
  if (!game?.data || activityRequest) return;
  get('activity-empty').hidden = true;
  get('activity-connected').hidden = false;
  const request = activityRequest = new AbortController();
  try {
    const activity = await responseData(await fetch(activityUrl(game), {signal: request.signal}));
    if (activityRequest !== request || connection !== game) return;
    game.activity = activity;
    renderActivity(activity);
    const changedAt = activity.lastRotationAt;
    if (changedAt > Date.parse(game.activatedAt || game.data.activatedAt)) {
      const rotation = new Date(changedAt);
      game.activatedAt = rotation.toISOString();
      game.localActivation = new Date(changedAt - rotation.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      activationInput.value = game.localActivation;
      activeRequest?.abort();
      activeRequest = undefined;
      loadPerformance();
    }
  } catch (error) {
    if (activityRequest === request) get('activity-status').textContent = error.message;
  } finally {
    if (activityRequest === request) activityRequest = undefined;
  }
}

async function changeWatcher(method) {
  const game = connection;
  if (!game?.data) return;
  const pair = get('pair-watcher'), unpair = get('unpair-watcher');
  if (pair.disabled) return;
  pair.disabled = unpair.disabled = true;
  activityRequest?.abort();
  const request = activityRequest = new AbortController();
  try {
    const result = await responseData(await fetch(activityUrl(game), {
      method, headers: {'Content-Type': 'application/json'}, signal: request.signal
    }));
    if (connection !== game || activityRequest !== request) return;
    get('watcher-token').value = result.token || '';
    get('watcher-token-field').hidden = !result.token;
    get('copy-token').textContent = 'Copy PowerShell setup';
    activityRequest = undefined;
    await updateActivity();
  } catch (error) {
    if (activityRequest === request) get('activity-status').textContent = error.message;
  } finally {
    if (activityRequest === request) activityRequest = undefined;
    pair.disabled = unpair.disabled = false;
  }
}

get('pair-watcher').addEventListener('click', () => changeWatcher('POST'));
get('unpair-watcher').addEventListener('click', () => changeWatcher('DELETE'));
get('copy-token').addEventListener('click', async () => {
  const field = get('watcher-token');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(`$env:ROLIBRARY_WATCH_TOKEN = '${field.value}'`);
    get('copy-token').textContent = 'Copied PowerShell setup';
  } catch {
    field.focus();
    field.select();
  }
});
setInterval(() => { if (!document.hidden) updateActivity(); }, 15_000);
