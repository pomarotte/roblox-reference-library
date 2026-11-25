'use strict';
const get = id => document.getElementById(id);
const form = get('connection'), keyInput = get('key'), refresh = get('refresh');
const disconnect = get('disconnect'), status = get('connection-status'), panel = get('performance');
const numbers = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {style: 'percent', maximumFractionDigits: 2});
const localTime = value => new Date(value).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
let connection, activeRequest;

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

function render({rows, checkedAt, windowStart, windowEnd, minimum}) {
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
    const cell = document.createElement('td'), progress = document.createElement('progress');
    progress.max = minimum;
    progress.value = Math.min(row.impressions, minimum);
    progress.setAttribute('aria-label', `Impressions toward the threshold for ${row.homeId}`);
    cell.append(progress);
    tr.append(cell);
    return tr;
  }));
  panel.hidden = false;
}

async function loadPerformance() {
  if (!connection || activeRequest) return;
  const request = activeRequest = new AbortController();
  refresh.disabled = true;
  status.textContent = 'Checking Roblox analytics…';
  try {
    const response = await fetch('/api/performance', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(connection), signal: request.signal
    });
    const data = await responseData(response);
    if (activeRequest !== request) return;
    render(data);
    status.textContent = '';
    keyInput.placeholder = 'Connected for this tab';
    refresh.textContent = 'Refresh analytics';
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
  const key = keyInput.value.trim() || connection?.key;
  const universe = get('universe').value.trim();
  const time = get('activated').value;
  const activatedAt = time ? new Date(time).toISOString() : undefined;
  if (!key) return;
  if (connection?.universe !== universe) {
    panel.hidden = true;
    get('scores').replaceChildren();
  }
  connection = {key, universe, activatedAt};
  keyInput.required = false;
  keyInput.value = '';
  disconnect.hidden = false;
  loadPerformance();
});

function clearConnection() {
  activeRequest?.abort();
  activeRequest = connection = undefined;
  keyInput.value = keyInput.placeholder = '';
  keyInput.required = true;
  refresh.textContent = 'Connect and load';
  refresh.disabled = false;
  disconnect.hidden = panel.hidden = true;
  get('scores').replaceChildren();
  status.textContent = '';
}
disconnect.addEventListener('click', clearConnection);
window.addEventListener('pagehide', clearConnection);
setInterval(() => { if (!document.hidden) loadPerformance(); }, 5 * 60 * 1000);

get('report').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  const note = get('report-status'), events = get('events');
  events.replaceChildren();
  if (!file) return;
  try {
    if (file.size > 100_000) throw new Error();
    const report = JSON.parse(await file.text());
    if (report.version !== 1 || !/^[1-9]\d{0,19}$/.test(report.universe) || !Array.isArray(report.events)) throw new Error();
    note.textContent = `Universe ${report.universe} · Challenger ${report.challenger}${report.nextCheck ? ` · Next scheduled check ${localTime(report.nextCheck)}` : ''}`;
    events.replaceChildren(...report.events.slice(-30).reverse().map(({at, message}) => {
      const item = document.createElement('li');
      item.textContent = `${localTime(at)} · ${message}`;
      return item;
    }));
  } catch { note.textContent = 'Choose a valid rotation watcher report.'; }
});
