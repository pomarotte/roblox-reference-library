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
      children: [], listeners: {}, style: {}, value: '',
      addEventListener(event, fn) { this.listeners[event] = fn; },
      replaceChildren(...nodes) { this.children = nodes; },
      append(...nodes) { this.children.push(...nodes); },
      setAttribute() {}, focus() {}
    });
    return elements.get(id);
  };
  let pointsDrawn = 0;
  Object.assign(element('trend'), {clientWidth: 800, clientHeight: 272, getContext: () => ({
    scale() {}, measureText: () => ({width: 50}), beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillText() {}, arc() { pointsDrawn++; }, fill() {}
  })});
  const browserCalls = [];
  const browser = {
    document: {getElementById: element, createElement: () => element()},
    window: {addEventListener() {}},
    AbortController, setInterval() {},
    Option: class { constructor(text, value) { Object.assign(this, {text, value}); } },
    ResizeObserver: class { observe() {} },
    fetch: async (path, options) => {
      if (path === '/api/session') return Response.json({email: 'creator@example.com'});
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
  element('add-game').listeners.click();
  assert.equal(element('universe').value, '');
  assert.equal(element('key').required, true);
  element('universe').value = '456';
  element('game-name').value = 'Second game';
  element('key').value = 'second-key';
  element('connection').listeners.submit({preventDefault() {}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(element('games').children.map(option => option.value), ['', '123', '456']);
  assert.equal(element('slots').textContent, '1 / 5');
  element('games').value = '123';
  element('games').listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('slots').textContent, '2 / 5');
  assert.deepEqual(browserCalls.map(({universe, key}) => [universe, key]),
    [['123', credentials.key], ['456', 'second-key'], ['123', credentials.key]]);
  element('disconnect').listeners.click();
  assert.equal(element('games').value, '456');
  assert.equal(element('performance').hidden, false);
  element('disconnect').listeners.click();
  assert.equal(element('performance').hidden, true);
  await element('report').listeners.change({target: {files: [{size: 100, text: async () => JSON.stringify({
    version: 1, universe: '123', challenger: 'third', events: [{at: started, message: 'Challenger became active.'}]
  })}]}});
  assert.match(element('events').children[0].textContent, /Challenger became active/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Dashboard Access protection, Roblox permissions, visual analytics, and multiple games passed.');
