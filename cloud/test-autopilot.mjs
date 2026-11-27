import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {serveDashboard} from './dashboard-api.mjs';
import {runAutopilot, runCampaign} from './autopilot-api.mjs';
import {planSwap} from './autopilot-campaign.mjs';
import {generateDraft} from './autopilot-services.mjs';

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
const stored = new Map(), image = new Uint8Array([1, 2, 3]), contentType = 'image/jpeg', sizes = [];
const encodes = [];
const queue = [];
const media = {
  async put(key, data, metadata) { stored.set(key, {data, ...metadata}); },
  async get(key) {
    const value = stored.get(key);
    return value && {...value, body: new Blob([value.data]).stream(), arrayBuffer: async () => value.data.slice().buffer};
  }
};
const env = {ACCESS_AUDIENCE: 'dashboard', WATCH_ACTIVITY: db, AUTOPILOT_MEDIA: media,
  AUTOPILOT_IMAGES: {input: () => ({transform: size => {
    sizes.push(size);
    return {output: async options => {
      encodes.push(options);
      return {response: () => new Response(image, {headers: {'Content-Type': options.format}})};
    }};
  }})},
  AUTOPILOT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTOPILOT_GEMINI_KEY: 'gemini-test',
  AUTOPILOT_RESEND_KEY: 'resend-test', AUTOPILOT_MAIL_FROM: 'testing@example.com',
  AUTOPILOT_QUEUE: {send: async message => { queue.push(message); }}};
const origin = 'https://analytics.rolibrary.win', owner = 'creator@example.com';
const pending = [];
const user = (email = owner) => ({access: {aud: 'dashboard', getIdentity: async () => ({email})},
  waitUntil: promise => pending.push(promise)});
const endpoint = (query = '', init, ctx = user()) => serveDashboard(
  new Request(`${origin}/api/autopilot?${query}`, init), env, ctx, {}, 'Shared thumbnail rules');
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
const emails = [], generations = [], submissions = [], swaps = [], imageSizes = [];
let currentGenerations = 0, peakGenerations = 0;
const referenceDownloads = [];
const operations = new Map();
let moderated = false, enoughTraffic = false;
let omitActiveApproval = false;
let rejectedRead;
const preview = 'https://tr.rbxcdn.com/demo/768/432/Image/Webp/noFilter';
const racingPreviews = [preview, preview.replace('/demo/', '/racing/')];
const manualPreviews = Array.from({length: 8}, (_, index) => preview.replace('/demo/', `/manual-${index}/`));
const originalFetch = fetch;
globalThis.fetch = async (url, {body, headers, redirect} = {}) => {
  const {hostname, pathname, searchParams} = new URL(url);
  assert.equal(redirect, 'manual');
  if (hostname === 'www.rolibrary.win') {
    assert.equal(pathname, '/data/charts.json');
    return Response.json({genres: {Racing: {games: [
      {id: 456, name: 'Downhill Shopping Cart Racing', thumbnails: racingPreviews, genre: 'Racing'},
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
      if (content.generationConfig.responseJsonSchema.type === 'object') {
        assert.match(content.systemInstruction.parts[0].text, /Shared thumbnail rules/);
        return Response.json({candidates: [{content: {parts: [{text: '{"reason":"Check the depicted reward."}'}]}}]});
      }
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
    imageSizes.push(content.generationConfig.imageConfig.imageSize);
    currentGenerations++;
    peakGenerations = Math.max(peakGenerations, currentGenerations);
    await new Promise(resolve => setImmediate(resolve));
    currentGenerations--;
    return Response.json({candidates: [{content: {parts: [{inlineData: {data: 'AQID'}}]}}]});
  }
  if (hostname === 'thumbnails.roblox.com') {
    if (pathname.endsWith('/multiget/thumbnails')) return Response.json({data: searchParams.get('universeIds').split(',')
      .map(universeId => ({universeId, thumbnails: manualPreviews.map(imageUrl => ({state: 'Completed', imageUrl}))}))});
    return Response.json({data: searchParams.get('assetIds').split(',').map(targetId => ({
      targetId, state: 'Completed', imageUrl: preview
    }))});
  }
  if (hostname === 'tr.rbxcdn.com') {
    referenceDownloads.push(url);
    return new Response(image, {headers: {'Content-Type': 'image/Webp'}});
  }
  if (pathname === '/search-api/omni-search') {
    assert.equal(searchParams.get('searchQuery'), 'Cart Championship');
    return Response.json({searchResults: [{contentGroupType: 'Game', contents: [
      {universeId: 852, name: 'Cart Championship'}, {universeId: 123, name: 'Cart park'}
    ]}]});
  }
  if (pathname === '/universes/v1/places/777/universe') return Response.json({universeId: 852});
  if (hostname === 'games.roblox.com') return Response.json({data: [{id: 852, name: 'Cart Championship'},
    {id: 456, name: 'Downhill Carts', genre_l1: 'Racing', genre_l2: 'Arcade', description: 'Steer carts through mountain trails.'}]});
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
    assert.ok(next.filter(id => !active.includes(id)).length >= 1 && next.filter(id => !active.includes(id)).length <= 3);
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
    return Response.json({homepageThumbnails: [...variants.values()].map(row =>
      omitActiveApproval && row.homepageThumbnailId === 'base' && active.includes('base')
        ? {...row, moderationStatus: undefined} : row)});
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
  const uploadedAsset = (await upload('type=asset&kind=Character&name=Cart%20driver&required=1')).brief.assets[0];
  const tagged = await action('tagAsset', {id: uploadedAsset.id, tags: ['Character', 'Visual style']});
  assert.deepEqual(tagged.brief.assets[0].tags, ['Character', 'Visual style']);
  const brief = 'Players race downhill in shopping carts.';
  const found = await action('references', {description: brief});
  assert.equal(found.referenceLimit, 8);
  assert.deepEqual(found.suggestions.map(item => item.id), racingPreviews);
  assert.match(found.suggestions[0].reason, /race downhill/);
  await action('brief', {description: brief, references: racingPreviews, allowText: true, wording: 'CART CHAOS!'});
  assert.deepEqual((await action('searchGames', {query: 'Cart Championship'})).manualSuggestions.map(item => item.id), manualPreviews);
  assert.deepEqual((await action('searchGames', {query: 'https://www.roblox.com/games/777/Cart-Championship'}))
    .manualSuggestions.map(item => item.id), manualPreviews);
  assert.equal((await post('addReference', {id: '999'})).status, 400);
  const savedReferences = [...racingPreviews, ...manualPreviews.slice(0, 6)];
  for (const id of manualPreviews.slice(0, 6)) await action('addReference', {id});
  assert.deepEqual((await game()).brief.references.map(item => item.id), savedReferences);
  assert.equal((await post('addReference', {id: manualPreviews[6]})).status, 400);
  await upload('type=starting&name=Finished%20file');
  const first = (await action('start', {target: 10, rounds: 2})).batches[0];
  await Promise.all(pending.splice(0));
  assert.equal(queue.length, 1, 'Starting the campaign queues generation immediately');
  assert.equal(first.items.length, 10);
  assert.equal((await post('approve', {batch: first.id, ids: [first.items[0].id]})).status, 400);
  while (queue.length) {
    const job = queue.shift();
    await runCampaign(env, 'Existing RoLibrary GFX instructions', job.owner, job.universe);
  }
  await tick();
  assert.equal(generations.length, 9);
  assert.equal(peakGenerations, 3, 'Drafts generate concurrently');
  assert.ok(generations[0][0].text.includes('Cart driver (must include)'));
  assert.match(generations[0][0].text, /Render this exact text.*"CART CHAOS!"/);
  assert.equal(generations[0].filter(part => part.inlineData).length, 9);
  assert.equal(submissions.length, 0);
  await action('brief', {description: brief, references: savedReferences, allowText: false, wording: 'CART CHAOS!'});
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
  await Promise.all(pending.splice(0));
  assert.ok(queue.length, 'Approving a batch immediately queues uploads');
  while (queue.length) {
    const job = queue.shift();
    await runCampaign(env, 'Existing RoLibrary GFX instructions', job.owner, job.universe);
  }
  assert.equal(submissions.length, 10, 'All approved images upload without waiting for the scheduler');
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
  omitActiveApproval = true;
  for (let attempt = 0; attempt < 24; attempt++) await tick();
  assert.equal(swaps.length, 4);
  assert.ok(active.includes('upload-9') && active.includes('upload-10'));
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
  const ranked = ['a', 'b', 'c', 'd', 'e'].map(homeId => ({homeId}));
  const challengers = ['x', 'y', 'z', 'w'].map(homeId => ({stage: 'ready', homeId}));
  assert.deepEqual(planSwap({baseline: 'e', items: challengers}, ['a', 'b', 'c', 'd', 'e'], ranked), ['a', 'b', 'x', 'y', 'z']);
  assert.deepEqual(planSwap({items: challengers.slice(0, 2)}, ['a', 'b', 'c', 'd', 'e'], ranked), ['a', 'b', 'c', 'x', 'y']);
  const loadedBrief = (await game()).brief;
  const fullBrief = {...loadedBrief, assets: Array(8).fill(loadedBrief.assets[0])};
  const draft = {id: crypto.randomUUID(), description: 'Test composition', parent: {image: preview}};
  referenceDownloads.length = 0;
  await generateDraft(env, '123', draft, fullBrief, 'Test prompt', 0);
  assert.match(generations.at(-1)[1].text, /Character, Visual style/);
  assert.equal(generations.at(-1).filter(part => part.inlineData).length, 14);
  assert.deepEqual(referenceDownloads.slice(1), savedReferences.slice(0, 5));
  referenceDownloads.length = 0;
  await generateDraft(env, '123', draft, fullBrief, 'Test prompt', 1);
  assert.deepEqual(referenceDownloads.slice(1), [...savedReferences.slice(5), ...savedReferences.slice(0, 2)]);
  const makePreview = async () => (await action('generatePreview', {description: 'Race downhill in a cart.'}, '456')).preview;
  const upscaled = new Uint32Array([0x474e5089, 0x0a1a0a0d, 0x0d000000, 0x52444849, 0x80070000, 0x38040000]);
  const accept = async id => success(await endpoint(`game=456&type=accept&id=${id}`, {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'image/png'}, body: upscaled
  }));
  const initial = await makePreview();
  assert.equal(imageSizes.at(-1), '1K');
  assert.deepEqual(sizes.at(-1), {width: 960, height: 540, fit: 'cover'});
  assert.deepEqual(encodes.at(-1), {format: 'image/png', anim: false});
  assert.match(initial.safetyNote, /reward/);
  assert.equal((await post('generatePreview', {description: 'Another thumbnail'}, '456')).status, 400);
  const edited = (await action('editPreview', {id: initial.id, description: 'Change the camera.'}, '456')).preview;
  assert.notEqual(edited.id, initial.id);
  assert.ok(generations.at(-1)[2].inlineData);
  assert.equal(generations.at(-1)[2].inlineData.mimeType, 'image/png');
  const declined = await action('declinePreview', {id: edited.id}, '456');
  assert.equal(declined.preview, null);
  assert.equal(declined.bank?.length || 0, 0);
  const automatic = (await action('generatePreview', {}, '456')).preview;
  assert.match(generations.at(-1)[0].text, /Downhill Carts · Racing · Arcade · Steer carts through mountain trails/);
  assert.match(automatic.description, /one clear, readable gameplay hook/);
  await action('declinePreview', {id: automatic.id}, '456');
  for (let index = 0; index < 6; index++) await accept((await makePreview()).id);
  assert.deepEqual(sizes.at(-1), {width: 1920, height: 1080, fit: 'cover'});
  assert.deepEqual(encodes.at(-1), {format: 'image/jpeg', quality: 95, anim: false});
  const started = await action('start', {bank: true, target: 10, rounds: 2}, '456');
  assert.equal(started.bank.length, 1);
  assert.equal(started.batches[0].phase, 'testing');
  assert.equal(started.batches[0].items.filter(item => item.stage === 'queued').length, 5);
  assert.equal(started.batches[0].items.filter(item => item.stage === 'live').length, 5);
  assert.match(started.batches[0].brief.description, /mountain trails/);
  const saved = sqlite.prepare('SELECT state FROM autopilot_games WHERE universe = ?').get('456');
  const withHistory = JSON.parse(saved.state);
  const winner = withHistory.batches[0].items.find(item => item.stage === 'queued');
  winner.result = {impressions: 15000, qualifiedPlayRate: .16};
  withHistory.performance = 'Wider framing underperformed on comparable traffic.';
  withHistory.brief.references = loadedBrief.references;
  sqlite.prepare('UPDATE autopilot_games SET state = ? WHERE universe = ?').run(JSON.stringify(withHistory), '456');
  referenceDownloads.length = 0;
  const guided = (await action('generatePreview', {description: '   '}, '456')).preview;
  assert.match(guided.description, /Wider framing underperformed/);
  assert.match(guided.description, /wide environmental reveal/);
  assert.doesNotMatch(guided.description, /starting composition/);
  assert.deepEqual(referenceDownloads, savedReferences.slice(2, 4));
  assert.equal(generations.at(-1).filter(part => part.inlineData).length, 2, 'Exploration skips the winner image');
  await action('declinePreview', {id: guided.id}, '456');
  referenceDownloads.length = 0;
  const nextConcept = (await action('generatePreview', {}, '456')).preview;
  assert.match(nextConcept.description, /extreme close-up/);
  assert.deepEqual(referenceDownloads, savedReferences.slice(4, 6));
  await action('declinePreview', {id: nextConcept.id}, '456');
  const variation = (await action('generatePreview', {}, '456')).preview;
  assert.match(variation.description, /higher-performing thumbnail used this description/);
  assert.equal(generations.at(-1).filter(part => part.inlineData).length, 3, 'A deliberate variation uses the winner and two references');
  const recreation = (await action('recreatePreview', {id: variation.id}, '456')).preview;
  assert.equal(recreation.id, variation.id, 'Keep the original available for comparison');
  assert.equal(imageSizes.at(-1), '2K');
  assert.deepEqual(sizes.at(-1), {width: 1920, height: 1080, fit: 'cover'});
  assert.equal(generations.at(-1).filter(part => part.inlineData).length, 1, 'Gemini receives just the original thumbnail');
  assert.match(generations.at(-1)[0].text, /Keep all original lettering exactly as it appears/);
  assert.equal((await post('acceptRecreated', {id: variation.id, recreation: 'stale'}, '456')).status, 400);
  const accepted = await action('acceptRecreated', {id: variation.id, recreation: recreation.recreation.id}, '456');
  assert.equal(accepted.preview, null);
  assert.equal(accepted.bank.at(-1).id, recreation.recreation.id);
  const beforeUpload = generations.length;
  const manual = await success(await endpoint('game=456&type=bank&name=Finished%20thumbnail', {
    method: 'POST', headers: {Origin: origin, 'Content-Type': contentType}, body: image
  }));
  assert.equal(manual.bank.at(-1).label, 'Finished thumbnail');
  assert.equal(generations.length, beforeUpload, 'A manual bank upload bypasses generation');
  const deleted = await action('removeBankThumbnail', {id: manual.bank.at(-1).id}, '456');
  assert.deepEqual(deleted.bank, accepted.bank);
  assert.deepEqual(deleted.batches, accepted.batches);
  const testingId = deleted.batches[0].items.find(item => item.stage === 'queued').id;
  assert.equal((await post('removeBankThumbnail', {id: testingId}, '456')).status, 400);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.Date = RealDate;
  sqlite.close();
}

console.log('Autopilot passed private game setup, asset-backed generation, batch email, moderation, five-slot rotation, and automatic iteration.');
