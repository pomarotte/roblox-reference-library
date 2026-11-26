import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {serveDashboard} from './dashboard-api.mjs';

const origin = 'https://analytics.rolibrary.win';
const access = {aud: 'dashboard', getIdentity: async () => ({email: 'creator@example.com'})};
const env = {ACCESS_AUDIENCE: 'dashboard'};
const assets = {'/': [await readFile(new URL('./dashboard/index.html', import.meta.url), 'utf8'), 'text/html']};
const started = new Date(Date.now() - 6 * 3_600_000).toISOString();
const credentials = {universe: '123', key: 'example-roblox-key', activatedAt: started};
const open = (path, init, ctx = {access}) => serveDashboard(new Request(origin + path, init), env, ctx, assets);
const performance = (body, site = origin, ctx) => open('/api/performance', {
  method: 'POST', headers: {'Content-Type': 'application/json', Origin: site}, body: JSON.stringify(body)
}, ctx);

let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, {headers, body}) => {
  requests++;
  assert.match(url, /^https:\/\/apis\.roblox\.com\//);
  assert.equal(headers['x-api-key'], credentials.key);
  if (url.includes('/personalization')) {
    return Response.json({personalizedConfigs: [{id: 'active', createdUtc: started, thumbnails: [
      {homepageThumbnailId: 'first', assetId: 100, personalizedThumbnailStatus: 'Active'},
      {homepageThumbnailId: 'second', assetId: 101, personalizedThumbnailStatus: 'Active'},
      {homepageThumbnailId: 'cold', assetId: 102, personalizedThumbnailStatus: 'Inactive'}
    ]}]});
  }
  const query = JSON.parse(body);
  assert.deepEqual(query.filter[0].values, ['100', '101']);
  assert.equal(query.granularity, 'OneHour');
  const countingViews = query.metric === 'ThumbnailImpressions';
  return Response.json({done: true, response: {values: [100, 101].map(id => ({
    breakdowns: [{dimension: 'ThumbnailAsset', value: String(id)}],
    dataPoints: [
      {time: query.startTime, value: countingViews ? 10000 : id},
      {time: new Date(Date.parse(query.startTime) + 3_600_000).toISOString(), value: countingViews ? 5000 : id * 2}
    ]
  }))}});
};

try {
  const forged = await open('/api/session', {headers: {'Cf-Access-Authenticated-User-Email': 'forged@example.com'}}, {});
  assert.equal(forged.status, 403);
  assert.equal((await performance(credentials, origin, {access: {...access, aud: 'other'}})).status, 403);
  assert.equal((await performance(credentials, 'https://example.org')).status, 403);
  assert.equal((await performance({...credentials, universe: '../wrong'})).status, 400);
  assert.equal(requests, 0);
  assert.deepEqual(await (await open('/api/session')).json(), {email: 'creator@example.com'});
  const dashboard = await (await open('/')).text();
  assert.match(dashboard, /Rotation activity/);
  assert.ok(dashboard.includes('href="https://create.roblox.com/dashboard/credentials?activeTab=ApiKeysTab" target="_blank"'));
  const result = await performance(credentials);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const data = await result.json();
  assert.equal(data.minimum, 10_000);
  assert.deepEqual(data.rows.map(row => row.homeId), ['second', 'first']);
  assert.equal(data.rows[0].qualifiedPlayRate, 0.0202);
  assert.equal(data.trendHours, 1);
  assert.deepEqual(data.rows[0].timeline.map(point => point.impressions), [10000, 5000]);
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3_600_000).toISOString().slice(0, 10);
  const daily = await (await performance({...credentials, activatedAt: `${fourDaysAgo}T00:00:00Z`})).json();
  assert.equal(daily.trendHours, 24);
  assert.deepEqual(daily.rows[0].timeline, [{at: Date.parse(fourDaysAgo), impressions: 15000, qualifiedPlays: 303}]);
  assert.ok(!JSON.stringify(data).includes(credentials.key));

  const elements = new Map();
  const element = (id = Symbol()) => {
    if (!elements.has(id)) elements.set(id, {
      children: [], listeners: {}, style: {}, dataset: {}, value: '',
      addEventListener(event, fn) { this.listeners[event] = fn; },
      replaceChildren(...nodes) { this.children = nodes; },
      append(...nodes) { this.children.push(...nodes); },
      setAttribute() {}, removeAttribute() {}, contains() { return false; }, focus() {}
    });
    return elements.get(id);
  };
  let pointsDrawn = 0;
  Object.assign(element('trend'), {clientWidth: 800, clientHeight: 272, getContext: () => ({
    scale() {}, measureText: () => ({width: 50}), beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillText() {}, arc() { pointsDrawn++; }, fill() {}
  })});
  const browserCalls = [];
  const activityReads = [];
  let paired = false, lastRotationAt = null;
  const timers = new Map();
  const browser = {
    document: {getElementById: element, createElement: tagName => Object.assign(element(), {tagName})},
    window: {addEventListener() {}},
    AbortController, setInterval(fn, interval) { timers.set(interval, fn); },
    Option: class { constructor(text, value) { Object.assign(this, {text, value}); } },
    ResizeObserver: class { observe() {} },
    fetch: async (path, options) => {
      if (path === '/api/session') return Response.json({email: 'creator@example.com'});
      if (path.startsWith('/api/activity?')) {
        if (options.method === 'POST') {
          paired = true;
          return Response.json({token: 'a'.repeat(64)}, {status: 201});
        }
        if (options.method === 'DELETE') {
          paired = false;
          return Response.json({paired});
        }
        activityReads.push(path);
        return Response.json({paired, lastRotationAt, events: path.endsWith('=123') ? [{
          at: lastRotationAt || Date.parse(started), status: 'changed', message: 'Challenger became active.', challenger: 'third'
        }] : []});
      }
      const payload = JSON.parse(options.body);
      browserCalls.push(payload);
      return Response.json(payload.universe === '123' ? data : {...data, universe: payload.universe, rows: data.rows.slice(0, 1)});
    }
  };
  const script = await readFile(new URL('./dashboard/dashboard.client.js', import.meta.url), 'utf8');
  runInNewContext(script, browser);
  element('universe').value = '123';
  element('key').value = credentials.key;
  element('connection').listeners.submit({preventDefault() {}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('key').value, '');
  assert.equal(element('account').textContent, 'creator@example.com');
  assert.equal(element('slots').textContent, '2 / 5');
  assert.equal(element('scores').children.length, 2);
  assert.equal(element('rates').children.length, 2);
  assert.equal(element('impressions').children[0].children[2].max, 10_000);
  assert.equal(pointsDrawn, 4);
  assert.match(element('events').children[0].children[0].textContent, /Challenger became active/);
  await element('pair-watcher').listeners.click();
  assert.equal(element('watcher-token').value, 'a'.repeat(64));
  assert.equal(element('unpair-watcher').hidden, false);
  element('add-game').listeners.click();
  assert.equal(element('watcher-token').value, '');
  assert.equal(element('universe').value, '');
  assert.equal(element('key').required, true);
  element('universe').value = '456';
  element('game-name').value = 'Second game';
  element('key').value = 'second-key';
  element('connection').listeners.submit({preventDefault() {}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(element('games').children.map(option => option.value), ['', '123', '456']);
  assert.equal(element('slots').textContent, '1 / 5');
  assert.equal(element('events').children.length, 0);
  element('games').value = '123';
  element('games').listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('slots').textContent, '2 / 5');
  assert.deepEqual(browserCalls.map(({universe, key}) => [universe, key]),
    [['123', credentials.key], ['456', 'second-key'], ['123', credentials.key]]);
  lastRotationAt = Date.now();
  timers.get(15_000)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browserCalls.at(-1).activatedAt, new Date(lastRotationAt).toISOString());
  assert.ok(activityReads.includes('/api/activity?universe=456'));
  await element('unpair-watcher').listeners.click();
  assert.equal(element('unpair-watcher').hidden, true);
  element('disconnect').listeners.click();
  assert.equal(element('games').value, '456');
  assert.equal(element('performance').hidden, false);
  element('disconnect').listeners.click();
  assert.equal(element('performance').hidden, true);

  const openBatch = 'batch-to-review';
  const savedGame = {universe: '456', name: 'Second game', brief: {description: 'A racing game', assets: [], references: []},
    suggestions: [], starting: [], active: [], library: [], batches: [{id: openBatch, phase: 'review', number: 1,
      items: [{id: 'draft-1', label: 'Draft 1', stage: 'draft', imageReady: true}]}]};
  const legacyFetch = browser.fetch;
  const approvals = [];
  Object.assign(browser, {URL, URLSearchParams,
    location: new URL(`${origin}/?game=456&batch=${openBatch}`), history: {replaceState() {}},
    async fetch(path, options) {
      if (path === '/api/autopilot?') return Response.json({enabled: true,
        games: [{universe: '123', name: 'First game'}, {universe: '456', name: 'Second game', review: true}]});
      if (path === '/api/autopilot?game=456') {
        if (!options) return Response.json(savedGame);
        approvals.push(JSON.parse(options.body));
        return Response.json({...savedGame, batches: [{...savedGame.batches[0], phase: 'testing'}]});
      }
      return legacyFetch(path, options);
    }
  });
  runInNewContext(await readFile(new URL('./dashboard/autopilot.client.js', import.meta.url), 'utf8'), browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element('game-tabs').children[1].textContent, /Second game · Review ready/);
  assert.match(element('autopilot-review-heading').textContent, /Second game · Round 1/);
  assert.equal(element('autopilot-approve').disabled, true);
  const checkbox = element('autopilot-drafts').children[0].children.find(node => node.tagName === 'label').children[0];
  checkbox.checked = true;
  checkbox.listeners.change();
  assert.equal(element('autopilot-approve').disabled, false);
  await element('autopilot-approve').listeners.click();
  assert.deepEqual(approvals, [{action: 'approve', batch: openBatch, ids: ['draft-1']}]);
  assert.equal(element('autopilot-approval').hidden, true);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Dashboard Access protection, Roblox permissions, visual analytics, and multiple games passed.');
