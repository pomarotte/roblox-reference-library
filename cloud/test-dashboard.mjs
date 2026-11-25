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
  return Response.json({done: true, response: {values: [100, 101].map(id => ({
    breakdowns: [{dimension: 'ThumbnailAsset', value: String(id)}],
    dataPoints: [{time: query.startTime, value: query.metric === 'ThumbnailImpressions' ? 10000 : id}]
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
  assert.match(await (await open('/')).text(), /Rotation activity/);
  const result = await performance(credentials);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const data = await result.json();
  assert.equal(data.minimum, 10_000);
  assert.deepEqual(data.rows.map(row => row.homeId), ['second', 'first']);
  assert.equal(data.rows[0].qualifiedPlayRate, 0.0101);
  assert.ok(!JSON.stringify(data).includes(credentials.key));

  const elements = new Map();
  const element = (id = Symbol()) => {
    if (!elements.has(id)) elements.set(id, {
      children: [], listeners: {}, value: '',
      addEventListener(event, fn) { this.listeners[event] = fn; },
      replaceChildren(...nodes) { this.children = nodes; },
      append(...nodes) { this.children.push(...nodes); },
      setAttribute() {}
    });
    return elements.get(id);
  };
  const browser = {
    document: {getElementById: element, createElement: () => element()},
    window: {addEventListener() {}},
    AbortController, setInterval() {},
    fetch: async path => path === '/api/session' ? Response.json({email: 'creator@example.com'}) : Response.json(data)
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
  element('disconnect').listeners.click();
  assert.equal(element('performance').hidden, true);
  await element('report').listeners.change({target: {files: [{size: 100, text: async () => JSON.stringify({
    version: 1, universe: '123', challenger: 'third', events: [{at: started, message: 'Challenger became active.'}]
  })}]}});
  assert.match(element('events').children[0].textContent, /Challenger became active/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Dashboard Access protection, Roblox permissions, and hourly performance passed.');
