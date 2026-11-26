import {RobloxApiError, homeAnalytics, homeIds, rotationMinimum, sameSet} from './home-analytics.mjs';
import {advanceCampaign, batchOf, createBatch, populateLibrary} from './autopilot-campaign.mjs';
import {describeDraft, findReferences, imageKey, readJson, searchGameReferences, storageKey, storeImage} from './autopilot-services.mjs';

const universePattern = /^[1-9]\d{0,19}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const assetKinds = ['Character', 'Environment', 'Prop', 'Logo', 'Gameplay screenshot'];
const minute = 60_000;
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const clean = (value, max) => typeof value === 'string' && value.length <= max ? value.trim() : '';

class InputError extends Error {}
const requireInput = (condition, message) => { if (!condition) throw new InputError(message); };

function enabled(env) {
  return Boolean(env.AUTOPILOT_MEDIA && env.AUTOPILOT_IMAGES && env.AUTOPILOT_ENCRYPTION_KEY &&
    env.AUTOPILOT_GEMINI_KEY && env.AUTOPILOT_RESEND_KEY && env.AUTOPILOT_MAIL_FROM);
}

async function lookup(db, owner, universe) {
  return db.prepare('SELECT * FROM autopilot_games WHERE owner = ? AND universe = ?').bind(owner, universe).first();
}

export async function autopilotConnection(env, owner, universe) {
  const row = await lookup(env.WATCH_ACTIVITY, owner, universe);
  if (!row) return null;
  const game = JSON.parse(row.state);
  return {key: await storageKey(env.AUTOPILOT_ENCRYPTION_KEY, owner, universe, row.secret, true), since: game.since,
    minimum: game.minimum ?? rotationMinimum};
}

async function lease(db, owner, universe) {
  const now = Date.now();
  return db.prepare(`
    UPDATE autopilot_games SET lease = ?, lease_until = ?
    WHERE owner = ? AND universe = ? AND lease_until <= ?
    RETURNING *
  `).bind(crypto.randomUUID(), now + 10 * minute, owner, universe, now).first();
}

async function release(db, row) {
  await db.prepare(`
    UPDATE autopilot_games SET lease = NULL, lease_until = 0 WHERE owner = ? AND universe = ? AND lease = ?
  `).bind(row.owner, row.universe, row.lease).run();
}

async function saveGame(db, row, game, nextCheck) {
  const saved = await db.prepare(`
    UPDATE autopilot_games SET state = ?, next_check = ?
    WHERE owner = ? AND universe = ? AND lease = ?
  `).bind(JSON.stringify(game), nextCheck, row.owner, row.universe, row.lease).run();
  if (!saved.meta.changes) throw new Error('The campaign lock expired.');
}

function summary(game) {
  const batch = batchOf(game);
  return {universe: game.universe, name: game.name, review: batch?.phase === 'review', phase: batch?.phase,
    paused: game.paused, since: game.since};
}

function publicGame(game) {
  const {swap, ...view} = game;
  return {...view, minimum: view.minimum ?? rotationMinimum};
}

async function checkThumbnailConnection(roblox) {
  let operation = 'read the active Home thumbnail set';
  try {
    const config = await roblox.activeConfig();
    operation = 'list the game’s Home thumbnails';
    await roblox.listThumbnails();
    return config;
  } catch (error) {
    if (error instanceof RobloxApiError) {
      const context = `Roblox would not let RoLibrary ${operation} (HTTP ${error.status}).`;
      if (error.reason === 'ip') throw new InputError(`${context} Check the IP restrictions on this Open Cloud key. RoLibrary connects from a Cloudflare Worker.`);
      if (error.reason === 'authentication') throw new InputError(`${context} Roblox rejected the key as invalid. Verify it is active and paste the full key again.`);
      if (error.status === 401 || error.status === 403) throw new InputError(`${context} Check that the key is active, has Thumbnail Read for this game, and allows requests from Cloudflare.`);
      throw new InputError(`${context} Try again shortly.`);
    }
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new InputError(`Roblox timed out while trying to ${operation}. Try again shortly.`);
    if (error.name === 'TypeError') throw new InputError(`RoLibrary could not reach Roblox to ${operation}. Try again shortly.`);
    throw new InputError(`RoLibrary could not ${operation} because Roblox sent an unexpected response.`);
  }
}

async function connect(db, env, owner, universe, body) {
  const name = clean(body.name, 60), key = clean(body.key, 1024);
  requireInput(name && /^[!-~]{1,1024}$/.test(key), 'Enter a game name and a Roblox Open Cloud key.');
  const existing = await lookup(db, owner, universe);
  if (existing) return json(publicGame(JSON.parse(existing.state)));
  const config = await checkThumbnailConnection(homeAnalytics(universe, key));
  const game = {name, universe, brief: {description: '', assets: [], references: []}, suggestions: [],
    library: [], starting: [], batches: [], active: homeIds(config), paused: false};
  const secret = await storageKey(env.AUTOPILOT_ENCRYPTION_KEY, owner, universe, key);
  const inserted = await db.prepare('INSERT OR IGNORE INTO autopilot_games (owner, universe, secret, state) VALUES (?, ?, ?, ?)')
    .bind(owner, universe, secret, JSON.stringify(game)).run();
  return inserted.meta.changes ? json(publicGame(game), 201)
    : json({error: 'Autopilot is already connected for this universe.'}, 409);
}

const editablePool = batch => !batch || batch.phase === 'complete';

async function updateGame(request, env, row, game, url, body) {
  const batch = batchOf(game);
  const roblox = async () => homeAnalytics(row.universe,
    await storageKey(env.AUTOPILOT_ENCRYPTION_KEY, row.owner, row.universe, row.secret, true));
  const action = body.action;
  if (action === 'key') {
    const key = clean(body.key, 1024);
    requireInput(/^[!-~]{1,1024}$/.test(key), 'Enter a Roblox Open Cloud key.');
    await checkThumbnailConnection(homeAnalytics(row.universe, key));
    const secret = await storageKey(env.AUTOPILOT_ENCRYPTION_KEY, row.owner, row.universe, key);
    await env.WATCH_ACTIVITY.prepare('UPDATE autopilot_games SET secret = ? WHERE owner = ? AND universe = ? AND lease = ?')
      .bind(secret, row.owner, row.universe, row.lease).run();
  } else if (action === 'image') {
    const asset = url.searchParams.get('type') === 'asset';
    const name = clean(url.searchParams.get('name'), 80);
    const kind = url.searchParams.get('kind');
    requireInput(name && /^image\/(jpeg|png|webp)$/.test(request.headers.get('Content-Type') || ''), 'Choose a named JPEG, PNG, or WebP image.');
    requireInput(asset ? game.brief.assets.length < 8 && assetKinds.includes(kind)
      : editablePool(batch) && game.starting.length < 10, asset
      ? 'Choose an asset type and upload up to eight assets.'
      : 'You can add up to ten starting images before starting a campaign.');
    const id = crypto.randomUUID();
    try { await storeImage(env, row.universe, id, request.body, asset); }
    catch { throw new InputError('The image could not be prepared. Choose a valid image under 8 MB.'); }
    if (asset) game.brief.assets.push({id, name, kind, required: url.searchParams.get('required') === '1'});
    else game.starting.push({id, label: name, stage: 'draft', imageReady: true});
  } else if (action === 'brief' || action === 'references') {
    const description = clean(body.description, 1800);
    requireInput(description, 'Describe your game and what its thumbnails should show.');
    if (action === 'references') {
      game.suggestions = await findReferences(env.AUTOPILOT_GEMINI_KEY, row.universe, description);
    } else {
      requireInput(Array.isArray(body.references) && body.references.length <= 3, 'Choose up to three similar-game references.');
      const offered = new Map([...game.brief.references, ...game.suggestions].map(reference => [reference.id, reference]));
      requireInput(body.references.every(id => offered.has(id)), 'Choose references from the suggested games.');
      game.brief.references = [...new Set(body.references)].map(id => offered.get(id));
    }
    game.brief.description = description;
  } else if (action === 'searchGames') {
    const query = clean(body.query, 300);
    requireInput(query, 'Enter a game name, Roblox game link, or Universe ID.');
    game.manualSuggestions = await searchGameReferences(row.universe, query);
  } else if (action === 'addReference') {
    const reference = game.manualSuggestions?.find(item => item.id === body.id);
    requireInput(reference, 'Choose a thumbnail from the current search results.');
    if (!game.brief.references.some(item => item.id === reference.id)) {
      requireInput(game.brief.references.length < 3, 'You can save up to three references. Uncheck one and save the brief to make room.');
      game.brief.references.push(reference);
    }
  } else if (action === 'removeAsset') {
    game.brief.assets = game.brief.assets.filter(asset => asset.id !== body.id);
  } else if (action === 'library') {
    game.library = await populateLibrary(await roblox());
  } else if (action === 'pick' || action === 'removeStarting') {
    requireInput(editablePool(batch), 'Start a new campaign to change the starting pool.');
    if (action === 'removeStarting') game.starting = game.starting.filter(item => item.id !== body.id);
    else {
      const item = game.library.find(candidate => candidate.homeId === body.id);
      requireInput(item?.approved && item.image && game.starting.length < 10 && !game.starting.some(candidate =>
        candidate.homeId === item.homeId), 'Choose an available thumbnail that is not already in the pool.');
      game.starting.push({...item, id: crypto.randomUUID(), existing: true, stage: 'draft'});
    }
  } else if (action === 'minimum') {
    requireInput(Number.isSafeInteger(body.minimum) && body.minimum > 0, 'Enter a positive whole number of impressions.');
    game.minimum = body.minimum;
  } else if (action === 'start') {
    requireInput(editablePool(batch), 'Finish the current campaign before starting a new one.');
    requireInput(Number.isInteger(body.target) && body.target >= Math.max(1, game.starting.length) && body.target <= 10 &&
      Number.isInteger(body.rounds) && body.rounds >= 1 && body.rounds <= 10, 'Choose 1–10 thumbnails and 1–10 rounds.');
    requireInput(game.brief.description || (body.target === game.starting.length && body.rounds === 1),
      'Save a game description before asking Autopilot to generate thumbnails.');
    const config = await (await roblox()).activeConfig();
    game.active = homeIds(config);
    game.since = new Date().toISOString();
    game.target = body.target;
    game.rounds = game.batches.length + body.rounds;
    game.swap = null;
    game.measurements = [];
    game.paused = false;
    game.problem = null;
    createBatch(game, [], true);
  } else if (action === 'approve') {
    requireInput(batch?.id === body.batch && batch.phase === 'review' && !game.paused &&
      Array.isArray(body.ids) && body.ids.length > 0 && body.ids.every(id =>
        batch.items.some(item => item.stage === 'draft' && item.id === id)), 'Review the current batch and select the final thumbnails to submit.');
    const config = await (await roblox()).activeConfig();
    const current = homeIds(config);
    requireInput(sameSet(current, game.active), 'The active set changed. Use Sync active set before submitting.');
    const chosen = new Set(body.ids);
    const available = batch.items.filter(item => chosen.has(item.id) && !current.includes(item.homeId)).length;
    requireInput(current.length + available >= 5, 'Select enough thumbnails to fill five active slots.');
    for (const item of batch.items) {
      item.stage = !chosen.has(item.id) ? 'excluded' : item.existing ? 'moderating' : 'queued';
      if (chosen.has(item.id)) item.approvedAt = new Date().toISOString();
    }
    batch.phase = 'testing';
  } else if (action === 'regenerate') {
    const item = batch?.items.find(candidate => candidate.id === body.id);
    const description = clean(body.description, 6000);
    requireInput(batch?.id === body.batch && batch.phase === 'review' && item && !item.existing &&
      ['draft', 'generationFailed'].includes(item.stage) && description, 'Open the current draft and enter a generation description.');
    item.description = description;
    item.id = crypto.randomUUID();
    item.stage = 'generating';
    item.imageReady = false;
    item.detail = null;
    batch.phase = 'generating';
  } else if (action === 'pause' || action === 'resume' || action === 'sync') {
    requireInput(batch && batch.phase !== 'complete', 'There is no running campaign.');
    if (action === 'sync') {
      const config = await (await roblox()).activeConfig();
      const ids = homeIds(config);
      requireInput(!game.swap || !sameSet(game.swap.before, ids) || (config?.id || null) !== game.swap.configId,
        'A Roblox activation update is still unconfirmed. Resume to let Autopilot confirm it.');
      game.active = ids;
      game.since = new Date().toISOString();
      for (const item of batch.items) {
        if (item.stage === 'live' && !ids.includes(item.homeId)) item.stage = 'ready';
      }
      batch.baseline = null;
      batch.results = {};
      game.swap = null;
    } else {
      game.paused = action === 'pause';
    }
    game.problem = null;
  } else if (action === 'recover') {
    const item = batch?.items.find(candidate => candidate.id === body.id && candidate.stage === 'submitting');
    requireInput(item && batch.id === body.batch, 'This upload is not awaiting a receipt.');
    item.stage = 'excluded';
    game.problem = null;
  } else {
    throw new InputError('Unknown Autopilot action.');
  }
}

export async function autopilotApi(request, env, owner) {
  const url = new URL(request.url), universe = url.searchParams.get('game') || '';
  if (!enabled(env)) return json(request.method === 'GET' && !universe
    ? {enabled: false, games: []} : {error: 'Autopilot is not configured.'}, request.method === 'GET' && !universe ? 200 : 503);
  const db = env.WATCH_ACTIVITY;
  try {
    if (request.method === 'GET' && !universe) {
      const {results} = await db.prepare('SELECT state FROM autopilot_games WHERE owner = ? ORDER BY rowid').bind(owner).all();
      return json({enabled: true, games: results.map(row => summary(JSON.parse(row.state)))});
    }
    requireInput(universePattern.test(universe), 'Enter a valid Roblox Universe ID.');
    if (request.method === 'GET') {
      const row = await lookup(db, owner, universe);
      if (!row) return json({error: 'Game not found.'}, 404);
      const image = url.searchParams.get('image');
      if (!image) return json(publicGame(JSON.parse(row.state)));
      if (!idPattern.test(image)) return json({error: 'Image not found.'}, 404);
      const object = await env.AUTOPILOT_MEDIA.get(imageKey(universe, image));
      return object ? new Response(object.body, {headers: {'Content-Type': object.httpMetadata.contentType,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}}) : json({error: 'Image not found.'}, 404);
    }
    if (request.method !== 'POST') return json({error: 'Use POST.'}, 405);
    if (request.headers.get('Origin') !== url.origin) return json({error: 'Open the RoLibrary dashboard.'}, 403);
    const image = url.searchParams.has('type');
    let body;
    try { body = image ? {action: 'image'} : await readJson(request); }
    catch { throw new InputError('Invalid Autopilot request.'); }
    requireInput(body && typeof body.action === 'string', 'Choose an Autopilot action.');
    if (body.action === 'connect') return await connect(db, env, owner, universe, body);
    const row = await lease(db, owner, universe);
    if (!row) return await lookup(db, owner, universe)
      ? json({error: 'Autopilot is updating this game. Try again in a moment.'}, 409) : json({error: 'Game not found.'}, 404);
    try {
      const game = JSON.parse(row.state);
      await updateGame(request, env, row, game, url, body);
      const batch = batchOf(game);
      const reschedule = ['start', 'approve', 'regenerate', 'resume', 'recover', 'sync', 'key'].includes(body.action) ||
        (body.action === 'minimum' && batch?.phase === 'testing' && row.next_check !== null);
      const next = game.paused || !batch || batch.phase === 'complete' ? null
        : reschedule ? Date.now() : row.next_check;
      await saveGame(db, row, game, next);
      return json(publicGame(game));
    } finally {
      await release(db, row);
    }
  } catch (error) {
    return error instanceof InputError ? json({error: error.message}, 400)
      : json({error: 'Autopilot could not complete this request. Try again shortly.'}, 502);
  }
}

export async function runAutopilot(env, prompt) {
  if (!enabled(env)) return;
  const db = env.WATCH_ACTIVITY, now = Date.now();
  const {results} = await db.prepare(`
    SELECT owner, universe FROM autopilot_games WHERE next_check <= ? AND lease_until <= ?
    ORDER BY next_check LIMIT 4
  `).bind(now, now).all();
  await Promise.all(results.map(async ({owner, universe}) => {
    const row = await lease(db, owner, universe);
    if (!row) return;
    try {
      if (row.next_check === null || row.next_check > Date.now()) return;
      const game = JSON.parse(row.state);
      const save = () => saveGame(db, row, game, row.next_check);
      let delay;
      try {
        const key = await storageKey(env.AUTOPILOT_ENCRYPTION_KEY, owner, universe, row.secret, true);
        delay = await advanceCampaign(env, owner, game, homeAnalytics(universe, key), save, prompt);
      } catch (error) {
        if (/Roblox returned HTTP (401|403)/.test(error.message)) {
          game.paused = true;
          game.problem = 'Roblox denied this action. Update the saved key with thumbnail read and write and analytics read permissions, then resume.';
          delay = null;
        } else {
          game.problem = 'A background service could not complete its check. Autopilot will check again.';
          delay = 15 * minute;
        }
      }
      await saveGame(db, row, game, game.paused || delay === null ? null : Date.now() + delay);
    } finally {
      await release(db, row);
    }
  }));
}
