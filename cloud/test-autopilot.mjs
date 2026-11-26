import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {serveDashboard} from './dashboard-api.mjs';
import {runAutopilot} from './autopilot-api.mjs';
import {planSwap} from './autopilot-campaign.mjs';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(new URL('./dashboard-migrations/0002_autopilot.sql', import.meta.url), 'utf8'));
const db = {
  prepare(sql) {
    return {bind(...args) {
      const statement = sqlite.prepare(sql);
      return {
        first: () => statement.get(...args),
        run: () => ({meta: statement.run(...args)}),
        all: () => ({results: statement.all(...args)})
      };
    }};
  }
};
const stored = new Map(), image = new Uint8Array([1, 2, 3]), contentType = 'image/jpeg';
const media = {
  async put(key, data, metadata) { stored.set(key, {data, ...metadata}); },
  async get(key) {
    const value = stored.get(key);
    return value && {...value, body: new Blob([value.data]).stream(), arrayBuffer: async () => value.data.slice().buffer};
  }
};
const env = {ACCESS_AUDIENCE: 'dashboard', WATCH_ACTIVITY: db, AUTOPILOT_MEDIA: media,
  AUTOPILOT_IMAGES: {input: () => ({transform: () => ({output: async ({format}) => ({
    response: () => new Response(image, {headers: {'Content-Type': format}})
  })})})},
  AUTOPILOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTOPILOT_GEMINI_KEY: 'gemini-test',
  AUTOPILOT_RESEND_KEY: 'resend-test', AUTOPILOT_MAIL_FROM: 'testing@example.com'};
const origin = 'https://analytics.rolibrary.win', owner = 'creator@example.com';
const user = (email = owner) => ({access: {aud: 'dashboard', getIdentity: async () => ({email})}});
const endpoint = (query = '', init, ctx = user()) => serveDashboard(
  new Request(`${origin}/api/autopilot?${query}`, init), env, ctx, {});
const post = (action, payload = {}, universe = '123', email = owner) => endpoint(`game=${universe}`, {
  method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify({action, ...payload})
}, user(email));
async function success(response) {
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
const action = async (...args) => success(await post(...args));
const game = async () => success(await endpoint('game=123'));
const batch = async () => (await game()).batches.at(-1);
const upload = async (query) => success(await endpoint(`game=123&${query}`, {
  method: 'POST', headers: {Origin: origin, 'Content-Type': contentType}, body: image
}));
const RealDate = Date;
let time = RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [time])); }
  static now() { return time; }
};

async function tick() {
  time += 3 * 3_600_000;
  sqlite.exec('UPDATE autopilot_games SET next_check = 0 WHERE next_check IS NOT NULL');
  await runAutopilot(env, 'Existing RoLibrary GFX instructions');
}

const variants = new Map();
let active = ['base', 'second', 'third', 'fourth', 'fifth'];
for (const [index, id] of active.entries()) {
  variants.set(id, {homepageThumbnailId: id, assetId: 100 + index, moderationStatus: 'Approved', homepageThumbnailStatus: 'Active',
    rate: .2 - index * .02});
}
const emails = [], generations = [], submissions = [], swaps = [];
const operations = new Map();
let moderated = false, enoughTraffic = false;
let rejectedRead;
const preview = 'https://tr.rbxcdn.com/demo/768/432/Image/Webp/noFilter';
const originalFetch = fetch;
globalThis.fetch = async (url, {body, headers, redirect} = {}) => {
  const {hostname, pathname, searchParams} = new URL(url);
  assert.equal(redirect, 'manual');
  if (hostname === 'www.rolibrary.win') {
    assert.equal(pathname, '/data/charts.json');
    return Response.json({genres: {Racing: {games: [
      {id: 456, name: 'Downhill Shopping Cart Racing', image: preview, genre: 'Racing'},
      {id: 789, name: 'My Farm', image: preview, genre: 'Simulation', description: 'Race to sell your crops.'}
    ]}}});
  }
  if (hostname === 'api.resend.com') {
    emails.push({body: JSON.parse(body), key: headers['Idempotency-Key']});
    return Response.json({}, {status: emails.length === 1 ? 503 : 200});
  }
  if (hostname === 'generativelanguage.googleapis.com') {
    const content = JSON.parse(body);
    if (pathname.includes('gemini-3.1-flash-lite')) {
      const input = JSON.parse(content.contents[0].parts[0].text);
      assert.deepEqual(input.candidates.map(game => game.id).sort(), ['456', '789']);
      assert.equal(headers['x-goog-api-key'], 'gemini-test');
      return Response.json({candidates: [{content: {parts: [{text: JSON.stringify([
        {id: '456', reason: 'Both games race downhill in shopping carts.'},
        {id: '999', reason: 'This game is outside the shortlist.'},
        {id: '456', reason: 'Duplicate match.'}
      ])}]}}]});
    }
    generations.push(content.contents[0].parts);
    return Response.json({candidates: [{content: {parts: [{inlineData: {data: 'AQID'}}]}}]});
  }
  if (hostname === 'thumbnails.roblox.com') {
    if (pathname.endsWith('/multiget/thumbnails')) return Response.json({data: searchParams.get('universeIds').split(',')
      .map(universeId => ({universeId, thumbnails: [{state: 'Completed', imageUrl: preview}]}))});
    return Response.json({data: searchParams.get('assetIds').split(',').map(targetId => ({
      targetId, state: 'Completed', imageUrl: preview
    }))});
  }
  if (hostname === 'tr.rbxcdn.com') return new Response(image, {headers: {'Content-Type': contentType}});
  if (pathname === '/search-api/omni-search') {
    assert.equal(searchParams.get('searchQuery'), 'Cart Championship');
    return Response.json({searchResults: [{contentGroupType: 'Game', contents: [
      {universeId: 852, name: 'Cart Championship'}, {universeId: 123, name: 'Cart park'}
    ]}]});
  }
  if (pathname === '/universes/v1/places/777/universe') return Response.json({universeId: 852});
  if (hostname === 'games.roblox.com') return Response.json({data: [{id: 852, name: 'Cart Championship'}]});
  assert.equal(hostname, 'apis.roblox.com');
  assert.equal(headers['x-api-key'], 'example-key');
  if (rejectedRead && pathname.endsWith(rejectedRead.path)) {
    if (rejectedRead.status === 302) return Response.redirect('https://example.com/');
    return Response.json({errors: [{message: rejectedRead.message}]}, {status: rejectedRead.status});
  }
  if (pathname.endsWith('/personalization')) {
    return Response.json({personalizedConfigs: [{id: 'config', createdUtc: new Date(time - 3_600_000).toISOString(),
      thumbnails: active.map(id => ({...variants.get(id), personalizedThumbnailStatus: 'Active'}))}]});
  }
  if (pathname.endsWith('/personalization/update')) {
    const next = JSON.parse(body).homepageThumbnailIds;
    assert.equal(next.length, 5);
    assert.equal(next.filter(id => !active.includes(id)).length, 1);
    assert.ok(next.every(id => variants.get(id).moderationStatus === 'Approved'));
    active = next;
    swaps.push(next);
    return Response.json({});
  }
  if (pathname.endsWith('/thumbnails/uploads')) {
    const [file] = body.getAll('files');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image);
    const index = submissions.push(file.name);
    const homeId = `upload-${index}`, operation = `op-${index}`;
    variants.set(homeId, {homepageThumbnailId: homeId, assetId: 200 + index, moderationStatus: 'Pending',
      homepageThumbnailStatus: 'Active', rate: .18 + index * .01});
    operations.set(operation, {homepageThumbnailId: homeId});
    return Response.json({fileToOperationIdDict: {[file.name]: operation}});
  }
  if (pathname.endsWith('/thumbnails/uploads/status')) {
    return Response.json({uploadThumbnailStatusDict: Object.fromEntries(searchParams.getAll('operationIds').map(id => [id, operations.get(id)]))});
  }
  if (pathname.endsWith('/thumbnails')) {
    if (moderated) for (const row of variants.values()) row.moderationStatus = 'Approved';
    return Response.json({homepageThumbnails: [...variants.values()]});
  }
  if (pathname.endsWith('/metrics')) {
    const query = JSON.parse(body), views = enoughTraffic ? 12_000 : 5;
    return Response.json({done: true, response: {values: [...variants.values()].filter(row =>
      query.filter[0].values.includes(String(row.assetId))).map(row => ({
      breakdowns: [{dimension: 'ThumbnailAsset', value: String(row.assetId)}],
      dataPoints: [{time: query.startTime, value: query.metric === 'ThumbnailImpressions' ? views : Math.floor(row.rate * views)}]
    }))}});
  }
  throw new Error(`Unexpected request: ${url}`);
};

try {
  assert.equal((await endpoint('', undefined, {})).status, 403);
  assert.equal((await endpoint('game=123', {method: 'POST', headers: {Origin: 'https://unrelated.test'}})).status, 403);
  const connection = {name: 'Cart park', key: 'example-key'};
  rejectedRead = {path: '/personalization', status: 403, message: 'Invalid authentication data provided'};
  const invalidKey = await post('connect', connection);
  assert.equal(invalidKey.status, 400);
  assert.match((await invalidKey.json()).error, /active Home thumbnail set.*key as invalid/);
  rejectedRead = {path: '/personalization', status: 302};
  const redirected = await post('connect', connection);
  assert.equal(redirected.status, 400);
  assert.match((await redirected.json()).error, /active Home thumbnail set \(HTTP 302\)/);
  rejectedRead = {path: '/thumbnails', status: 403, message: 'IP address not allowed — example-key'};
  const blockedIp = (await (await post('connect', connection)).json()).error;
  assert.match(blockedIp, /list the game’s Home thumbnails.*IP restrictions/);
  assert.ok(!blockedIp.includes(connection.key));
  rejectedRead = {path: '/thumbnails', status: 503, message: 'Service unavailable'};
  assert.match((await (await post('connect', connection)).json()).error, /Home thumbnails \(HTTP 503\).*Try again/);
  rejectedRead = undefined;
  await action('connect', {name: 'Cart park', key: 'example-key'});
  await action('connect', {name: 'Different game', key: 'example-key'}, '456');
  assert.equal((await game()).library.length, 0);
  const picked = (await action('pick', {id: 'base'})).starting[0];
  assert.equal(picked.existing, true);
  assert.equal(picked.image, preview);
  await action('removeStarting', {id: picked.id});
  assert.equal((await game()).minimum, 10_000);
  assert.equal((await post('minimum', {minimum: 0})).status, 400);
  assert.equal((await post('minimum', {minimum: 1.5})).status, 400);
  await action('minimum', {minimum: 13_000});
  assert.equal((await success(await endpoint('game=456'))).minimum, 10_000);
  const performance = await success(await serveDashboard(new Request(origin + '/api/performance', {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: '{"universe":"123"}'
  }), env, user(), {}));
  assert.equal(performance.minimum, 13_000);
  assert.equal((await endpoint('game=123', undefined, user('other@example.com'))).status, 404);
  assert.ok(!JSON.stringify(await game()).includes('example-key'));
  assert.ok(!sqlite.prepare("SELECT secret FROM autopilot_games WHERE universe = '123'").get().secret.includes('example-key'));
  const library = await action('library');
  assert.equal(library.library.length, 5);
  await upload('type=asset&kind=Character&name=Cart%20driver&required=1');
  const brief = 'Players race downhill in shopping carts.';
  const found = await action('references', {description: brief});
  assert.deepEqual(found.suggestions.map(item => item.id), ['456']);
  assert.match(found.suggestions[0].reason, /race downhill/);
  await action('brief', {description: brief, references: ['456'], allowText: true, wording: 'CART CHAOS!'});
  assert.deepEqual((await action('searchGames', {query: 'Cart Championship'})).manualSuggestions.map(item => item.id), ['852']);
  assert.deepEqual((await action('searchGames', {query: 'https://www.roblox.com/games/777/Cart-Championship'}))
    .manualSuggestions.map(item => item.id), ['852']);
  assert.equal((await post('addReference', {id: '999'})).status, 400);
  assert.deepEqual((await action('addReference', {id: '852'})).brief.references.map(item => item.id), ['456', '852']);
  await upload('type=starting&name=Finished%20file');
  const first = (await action('start', {target: 10, rounds: 2})).batches[0];
  assert.equal(first.items.length, 10);
  assert.equal((await post('approve', {batch: first.id, ids: [first.items[0].id]})).status, 400);
  for (let attempt = 0; attempt < 12; attempt++) await tick();
  assert.equal(generations.length, 9);
  assert.ok(generations[0][0].text.includes('Cart driver (must include)'));
  assert.match(generations[0][0].text, /Render this exact text.*"CART CHAOS!"/);
  assert.equal(generations[0].filter(part => part.inlineData).length, 3);
  assert.equal(submissions.length, 0);
  await action('brief', {description: brief, references: ['456', '852'], allowText: false, wording: 'CART CHAOS!'});
  assert.equal(swaps.length, 0);
  assert.equal(emails.length, 2);
  assert.equal(emails[0].key, emails[1].key);
  assert.deepEqual(emails[1].body.to, [owner]);
  assert.ok(emails[1].body.text.includes(`?game=123&batch=${first.id}`));
  const summary = await success(await endpoint());
  assert.deepEqual(summary.games.map(item => [item.universe, item.review]), [['123', true], ['456', false]]);
  assert.equal((await endpoint(`game=123&image=${first.items[0].id}`, undefined, user('other@example.com'))).status, 404);
  assert.deepEqual(new Uint8Array(await (await endpoint(`game=123&image=${first.items[0].id}`)).arrayBuffer()), image);
  await action('regenerate', {batch: first.id, id: first.items.at(-1).id, description: 'Show the driver at a different angle.'});
  await tick();
  await tick();
  await tick();
  const reviewed = await batch();
  assert.equal(emails.length, 2);
  assert.equal((await post('approve', {batch: first.id, ids: [first.items.at(-1).id]})).status, 400);
  assert.equal((await post('approve', {batch: first.id, ids: reviewed.items.map(item => item.id)}, '123', 'other@example.com')).status, 404);
  await action('approve', {batch: first.id, ids: reviewed.items.map(item => item.id)});
  for (let attempt = 0; attempt < 12; attempt++) await tick();
  assert.equal(submissions.length, 10);
  assert.equal(swaps.length, 0);
  assert.equal((await batch()).items[0].stage, 'moderating');
  moderated = true;
  await tick();
  assert.equal(swaps.length, 0, 'Rotation waits for impression minimum');
  await action('pause');
  enoughTraffic = true;
  await tick();
  assert.equal(swaps.length, 0, 'Paused campaigns do not rotate');
  await action('resume');
  await tick();
  assert.equal(swaps.length, 0, '12,000 impressions do not pass a saved minimum of 13,000');
  await action('minimum', {minimum: 12_000});
  for (let attempt = 0; attempt < 24; attempt++) await tick();
  assert.equal(swaps.length, 10);
  assert.ok(active.includes('base'));
  assert.equal((await game()).batches[0].items.filter(item => item.stage === 'tested').length, 10);
  const next = await batch();
  assert.equal(next.number, 2);
  assert.ok(next.items.every(item => /Draft/.test(item.label) && item.parent.id));
  assert.ok(next.items.some(item => item.parent.label === 'Draft 10'));
  while ((await batch()).phase === 'generating') await tick();
  await tick();
  assert.equal(emails.length, 3);
  assert.match(generations.at(-1)[0].text, /Do not add titles/);
  assert.doesNotMatch(generations.at(-1)[0].text, /CART CHAOS!/);
  assert.equal(submissions.length, 10, 'The next round waits for approval');
  const nextReview = await batch();
  await action('approve', {batch: nextReview.id, ids: [nextReview.items[0].id]});
  await tick();
  await tick();
  assert.equal(submissions.length, 11, 'Only the selected image is submitted');
  assert.equal((await batch()).items.filter(item => item.stage === 'excluded').length, 9);
  assert.deepEqual(planSwap({items: [{stage: 'ready', homeId: 'new'}]}, ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd', 'new']);
  assert.equal(planSwap({items: [{stage: 'ready', homeId: 'new'}]}, ['a', 'b', 'c']), null);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.Date = RealDate;
  sqlite.close();
}

console.log('Autopilot passed private game setup, asset-backed generation, batch email, moderation, five-slot rotation, and automatic iteration.');
