import {activeThumbnails, canActivate, homeIds, hour, reportingWindow, rotationMinimum, sameSet} from './home-analytics.mjs';
import {describeDraft, generateDraft, imageKey, robloxImages, sendReviewEmail} from './autopilot-services.mjs';

const minute = 60_000;
const terminal = new Set(['tested', 'rejected', 'excluded']);
export const batchOf = game => game.batches.at(-1);

export function createBatch(game, parents = [], startingRound = false) {
  let starting = startingRound ? game.starting : [];
  if (game.useBank) {
    const baselines = game.active.map(homeId => ({...game.library.find(item => item.homeId === homeId),
      id: crypto.randomUUID(), homeId, existing: true, stage: 'live', label: 'Existing baseline'}));
    const free = game.target - baselines.length;
    const picked = startingRound ? game.starting.filter(item => !game.active.includes(item.homeId)).slice(0, free) : [];
    const draftCount = startingRound ? 0 : 2;
    const reserved = (game.bank ||= []).splice(0, Math.max(0, free - picked.length - draftCount));
    starting = [...baselines, ...[...picked, ...reserved].map(item => ({
      ...item, stage: item.existing ? 'moderating' : 'queued', approvedAt: new Date().toISOString()
    }))];
    if (startingRound) game.starting = game.starting.filter(item =>
      !game.active.includes(item.homeId) && !picked.includes(item));
  }
  const batch = {id: crypto.randomUUID(), number: game.batches.length + 1, phase: 'generating',
    items: starting, brief: structuredClone(game.brief), results: {}, ...(game.useBank ? {keepBaseline: true} : {})};
  if (!batch.brief.description && game.useBank) batch.brief.description = game.gameContext || game.name;
  if (game.performance) batch.brief.performance = game.performance;
  const uploaded = starting.length;
  for (let index = batch.items.length; index < game.target; index++) {
    const parent = parents.length ? parents[(index - uploaded) % parents.length] : undefined;
    batch.items.push({id: crypto.randomUUID(), label: `Draft ${index + 1}`, parent, needsUpscale: Boolean(game.useBank),
      stage: 'generating', description: describeDraft(batch.brief, index, parent).slice(0, 6000)});
  }
  game.batches.push(batch);
  if (!game.useBank) game.starting = [];
  else if (!batch.items.some(item => item.stage === 'generating')) batch.phase = 'testing';
  return batch;
}

export function recordResults(batch, rows, minimum = rotationMinimum) {
  if (rows.length !== 5 || rows.some(row => row.impressions < minimum || row.qualifiedPlayRate === null)) {
    return false;
  }
  const base = rows.find(row => row.homeId === batch.baseline) || rows[0];
  batch.baseline = base.homeId;
  for (const row of rows) {
    const result = {...row, difference: row.qualifiedPlayRate - base.qualifiedPlayRate};
    batch.results[row.homeId] = result;
    const item = batch.items.find(item => item.homeId === row.homeId);
    if (item) {
      item.result = result;
      if (item.stage === 'live') item.stage = 'tested';
    }
  }
  return true;
}

export function planSwap(batch, current, rows) {
  const ready = batch.items.filter(item => item.stage === 'ready' && !current.includes(item.homeId));
  if (current.length < 5) {
    return current.length + ready.length >= 5 ? [...current, ...ready.slice(0, 5 - current.length).map(item => item.homeId)] : null;
  }
  if (!ready.length || rows?.length !== 5) return null;
  const replacements = ready.slice(0, 3);
  const replaceable = batch.keepBaseline ? rows.filter(row => row.homeId !== batch.baseline) : rows;
  const removed = new Set(replaceable.slice(-replacements.length).map(row => row.homeId));
  return [...current.filter(id => !removed.has(id)), ...replacements.map(item => item.homeId)];
}

async function populateLibrary(roblox) {
  const [config, items] = await Promise.all([roblox.activeConfig(), roblox.listThumbnails()]);
  const images = await robloxImages(items.map(item => item.assetId));
  const active = homeIds(config);
  return items.map(item => ({homeId: item.homepageThumbnailId, assetId: String(item.assetId),
    label: item.displayName || `Thumbnail ${item.homepageThumbnailId}`, image: images.get(String(item.assetId)),
    active: active.includes(item.homepageThumbnailId), approved: canActivate(item)}));
}

export {populateLibrary};

async function confirmSwap(game, batch, roblox, config, save) {
  const {before, after, configId} = game.swap;
  const current = homeIds(config);
  if (sameSet(current, after)) {
    for (const item of batch.items) {
      if (item.stage === 'ready' && after.includes(item.homeId)) item.stage = 'live';
    }
    game.active = after;
    game.since = new Date().toISOString();
    game.measurements = [];
    game.swap = null;
    return;
  }
  if ((config?.id || null) !== configId || !sameSet(current, before)) {
    game.paused = true;
    game.problem = 'The active set changed outside Autopilot. Review it in Creator Dashboard before resuming.';
    return;
  }
  const available = await roblox.listThumbnails();
  if (!after.filter(id => !before.includes(id)).every(id =>
    available.some(item => item.homepageThumbnailId === id && canActivate(item)))) {
    game.paused = true;
    game.problem = 'Roblox no longer lists all five planned thumbnails as approved. Review the set before resuming.';
    return;
  }
  // Save before the write, then confirm by reading Roblox on the next check.
  await save();
  const latest = await roblox.activeConfig();
  if ((latest?.id || null) !== configId || !sameSet(homeIds(latest), before)) return;
  await roblox.updateActive(after, latest);
}

async function uploadOne(env, game, roblox, item, save) {
  const media = await env.AUTOPILOT_MEDIA.get(imageKey(game.universe, item.id));
  if (!media) throw new Error('An approved image is missing from storage.');
  const name = `rolibrary-${game.universe}-${item.id}.jpg`, form = new FormData();
  form.append('files', new Blob([await media.arrayBuffer()], {type: 'image/jpeg'}), name);
  item.stage = 'submitting';
  await save();
  const result = await roblox.request(`${roblox.thumbnails}/thumbnails/uploads`, {body: form});
  item.operation = result?.fileToOperationIdDict?.[name];
  if (!item.operation) throw new Error('Roblox did not return an upload receipt.');
  item.stage = 'uploading';
}

function markRejected(item, result) {
  item.stage = 'rejected';
  const reason = result.moderationReason || result.rejectionReason || result.errorMessage || result.error?.message;
  item.detail = typeof reason === 'string' ? reason.slice(0, 500) : 'Roblox rejected or could not process this thumbnail.';
}

async function checkModeration(roblox, batch, available) {
  const uploads = batch.items.filter(item => item.stage === 'uploading');
  if (uploads.length) {
    const query = new URLSearchParams(uploads.map(item => ['operationIds', item.operation]));
    const result = await roblox.request(`${roblox.thumbnails}/thumbnails/uploads/status?${query}`);
    for (const item of uploads) {
      const status = result.uploadThumbnailStatusDict?.[item.operation];
      if (!status) continue;
      if (!status.homepageThumbnailId) markRejected(item, status);
      else {
        item.homeId = status.homepageThumbnailId;
        item.stage = 'moderating';
      }
    }
  }
  for (const item of batch.items.filter(item => item.stage === 'moderating' || item.stage === 'ready')) {
    const result = available.find(row => row.homepageThumbnailId === item.homeId);
    if (!result) continue;
    if (canActivate(result)) item.stage = 'ready';
    else if (result.moderationStatus === 'Rejected' || result.homepageThumbnailStatus === 'Spammy') markRejected(item, result);
    else item.stage = 'moderating';
  }
}

async function iterate(game, batch, config, available) {
  if (!Object.keys(batch.results).length) {
    batch.phase = 'complete';
    return;
  }
  const active = homeIds(config);
  const strongest = Object.values(batch.results).filter(result =>
    available.some(item => item.homepageThumbnailId === result.homeId && canActivate(item)))
    .sort((left, right) => right.difference - left.difference);
  const candidates = strongest.slice(0, 3);
  const history = game.batches.flatMap(round => round.items);
  if (game.useBank) {
    const described = Object.values(batch.results).flatMap(result => {
      const item = history.find(item => item.homeId === result.homeId && item.description);
      return item ? [{...result, description: item.description.slice(0, 550)}] : [];
    }).sort((a, b) => b.qualifiedPlayRate - a.qualifiedPlayRate);
    const summarize = item => `${(item.qualifiedPlayRate * 100).toFixed(2)}% qualified plays on ${item.impressions} impressions: ${item.description}`;
    game.performance = described.length > 1 ? `Higher: ${summarize(described[0])}. Lower: ${summarize(described.at(-1))}.`
      : described.length ? summarize(described[0]) : null;
  }
  if (batch.number >= game.rounds) {
    batch.phase = 'complete';
    return;
  }
  const images = await robloxImages(candidates.filter(result =>
    !history.some(item => item.homeId === result.homeId && !item.existing)).map(result => result.assetId));
  const parents = candidates.flatMap(result => {
    const original = history.find(item => item.homeId === result.homeId && !item.existing);
    const image = images.get(result.assetId);
    return original || image ? [{id: original?.id, image, label: original?.label || `Thumbnail ${result.homeId}`,
      description: original?.description}] : [];
  });
  if (!parents.length && !game.useBank) {
    game.problem = 'The strongest thumbnails are missing image previews. Autopilot will check again.';
    return;
  }
  batch.phase = 'complete';
  const next = createBatch(game, parents);
  next.baseline = strongest.find(result => active.includes(result.homeId))?.homeId;
}

async function testBatch(env, game, batch, roblox, save) {
  const config = await roblox.activeConfig();
  if (game.swap) {
    await confirmSwap(game, batch, roblox, config, save);
    return minute;
  }
  const active = homeIds(config);
  if (!sameSet(active, game.active)) {
    game.paused = true;
    game.problem = 'The active set was changed outside Autopilot. Check the live set before resuming.';
    return null;
  }
  const queued = batch.items.find(item => item.stage === 'queued');
  if (queued) {
    await uploadOne(env, game, roblox, queued, save);
    return 0;
  }
  const available = await roblox.listThumbnails();
  await checkModeration(roblox, batch, available);
  for (const item of batch.items) {
    if (item.stage === 'ready' && active.includes(item.homeId)) item.stage = 'live';
  }
  if (active.length < 5) {
    const after = planSwap(batch, active);
    if (after) {
      game.swap = {before: active, after, configId: config?.id || null};
      await confirmSwap(game, batch, roblox, config, save);
      return minute;
    }
    game.problem = 'Waiting for five approved thumbnails to fill the active set.';
    if (!batch.items.some(item => ['uploading', 'moderating'].includes(item.stage))) {
      game.problem = 'There are too few cleared thumbnails for five slots. Start a replacement batch to add more.';
      batch.phase = 'complete';
      return null;
    }
    return 15 * minute;
  }
  if (!active.includes(batch.baseline)) batch.baseline = null;
  if (batch.items.every(item => terminal.has(item.stage))) {
    await iterate(game, batch, config, available);
    return batchOf(game).phase === 'complete' ? null : minute;
  }
  if (!batch.items.some(item => item.stage === 'live' || item.stage === 'ready')) {
    return 15 * minute;
  }
  const now = Date.now();
  const since = now - 28 * 24 * hour;
  const {start, end} = reportingWindow(new Date(since).toISOString(), now);
  const rows = start < end ? await roblox.scores(activeThumbnails(config), start, end, 'OneHour', 0, false) : [];
  game.measurements = rows;
  if (!recordResults(batch, rows, game.minimum)) {
    game.problem = 'Waiting for each thumbnail to reach the impression minimum in the past 28 days.';
    return 30 * minute;
  }
  if (batch.items.every(item => terminal.has(item.stage))) {
    await iterate(game, batch, config, available);
    return batchOf(game).phase === 'complete' ? null : minute;
  }
  const after = planSwap(batch, active, rows);
  if (after) {
    game.swap = {before: active, after, configId: config?.id || null};
    await confirmSwap(game, batch, roblox, config, save);
    return minute;
  }
  return 15 * minute;
}

export async function advanceCampaign(env, owner, game, roblox, save, prompt) {
  const batch = batchOf(game);
  if (!batch || game.paused || batch.phase === 'complete') return null;
  game.problem = null;
  if (batch.phase === 'generating') {
    const drafts = batch.items.filter(item => item.stage === 'generating').slice(0, game.useBank ? 1 : 3);
    if (drafts.length) {
      await Promise.all(drafts.map(async draft => {
        try {
          await generateDraft(env, game.universe, draft, batch.brief, prompt, batch.items.indexOf(draft), draft.needsUpscale);
          draft.stage = 'draft';
          draft.imageReady = true;
        } catch (error) {
          draft.stage = 'generationFailed';
          draft.detail = /^(A thumbnail reference|Gemini generation failed|Could not reach Gemini|The generated image|A game asset is missing|Gemini did not return an image)/.test(error.message)
            ? error.message : 'Generation failed unexpectedly. Try this draft again.';
        }
      }));
      return 0;
    }
    batch.phase = 'review';
    return 0;
  }
  if (batch.phase === 'review') {
    if (batch.emailed || !batch.items.some(item => item.stage === 'draft')) return null;
    batch.emailStarted ||= Date.now();
    if (Date.now() - batch.emailStarted >= 23 * hour) {
      game.problem = 'The review email could not be confirmed. This batch can still be reviewed in Analytics.';
      return null;
    }
    await save();
    await sendReviewEmail(env, owner, game.universe, game, batch);
    batch.emailed = true;
    return null;
  }
  if (batch.items.some(item => item.stage === 'submitting')) {
    game.problem = 'Roblox did not confirm an upload. Check Creator Dashboard before skipping it.';
    return null;
  }
  return testBatch(env, game, batch, roblox, save);
}
