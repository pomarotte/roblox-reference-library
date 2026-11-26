import {readFile, rename, stat, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {activeThumbnails, canActivate, homeAnalytics, homeIds, hour, reportingWindow, rotationMinimum, sameSet} from './home-analytics.mjs';

const [universe, command, ...args] = process.argv.slice(2);
const usage = 'Usage: node cloud/home-thumbnails.mjs UNIVERSE_ID upload APPROVED_FILES... | status | activate HOME_IDS... | rank START_DATE [MIN_IMPRESSIONS] | rotate START_TIME CHALLENGER_ID | watch START_TIME CHALLENGER_ID [12|24]';
const key = process.env.ROBLOX_API_KEY;
const {thumbnails, request, activeConfig, listThumbnails, updateActive, scores} = homeAnalytics(universe, key);

async function upload(files) {
  if (files.length < 1 || files.length > 5) throw new Error('Pass 1–5 approved image downloads.');
  const names = files.map(file => basename(file));
  const pattern = new RegExp(`^roblox-home-${universe}-[a-z0-9]+-v[1-9]\\d*\\.(png|jpg)$`);
  if (new Set(names).size !== names.length || !names.every(name => pattern.test(name))) {
    throw new Error('Use uniquely named approved downloads from the generator for this Universe ID.');
  }
  const form = new FormData();
  for (const [index, file] of files.entries()) {
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size >= 3_000_000) throw new Error(`Invalid or oversized image: ${file}`);
    const contents = await readFile(file);
    form.append('files', new Blob([contents], {type: file.endsWith('.png') ? 'image/png' : 'image/jpeg'}), names[index]);
  }
  const {fileToOperationIdDict} = await request(`${thumbnails}/thumbnails/uploads`, {body: form});
  const operations = names.map(name => fileToOperationIdDict?.[name]);
  if (operations.some(id => !id)) throw new Error('Roblox did not return every upload operation. Check Creator Dashboard before retrying.');
  const query = new URLSearchParams(operations.map(id => ['operationIds', id]));
  console.log('Upload operations:', JSON.stringify(fileToOperationIdDict));
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await request(`${thumbnails}/thumbnails/uploads/status?${query}`);
    const results = operations.map(id => status.uploadThumbnailStatusDict?.[id]);
    if (results.every(Boolean)) {
      console.table(results.map((result, i) => ({file: names[i], ...result})));
      if (results.some(result => !result.homepageThumbnailId)) throw new Error('At least one upload did not receive a thumbnail ID.');
      return;
    }
    await delay(3_000);
  }
  throw new Error('Upload processing is still pending. Check Creator Dashboard or run status before retrying.');
}

async function activate(ids, expected) {
  if (ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length) {
    throw new Error('Pass 2–5 distinct Home thumbnail IDs, including any existing thumbnail you want to keep.');
  }
  const available = await listThumbnails();
  if (!ids.every(id => available.some(item => item.homepageThumbnailId === id && canActivate(item)))) {
    throw new Error('Every thumbnail must belong to this universe, be available and pass Roblox moderation.');
  }
  const config = await activeConfig();
  const current = homeIds(config);
  if (sameSet(ids, current)) {
    console.log('This set is already active.');
    return;
  }
  if (expected && (expected.id !== config?.id || !sameSet(current, homeIds(expected)))) {
    throw new Error('The active set changed during review. Check the latest thumbnails and start a new review.');
  }
  await updateActive(ids, config);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (sameSet(ids, homeIds(await activeConfig()))) {
      console.log(`Home personalization active for universe ${universe}: ${ids.join(', ')}`);
      return;
    }
    await delay(1_000);
  }
  throw new Error('Roblox did not confirm the new active set. Check Creator Dashboard and your API key permissions.');
}

async function rank(day, minImpressions = '1000') {
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !Number.isFinite(+start) ||
      !start.toISOString().startsWith(day) || start >= end || end - start > 29 * 86_400_000 ||
      !/^[1-9]\d*$/.test(minImpressions) || !Number.isSafeInteger(Number(minImpressions))) {
    throw new Error('Use a UTC start date 1–29 days ago and a positive minimum impression count.');
  }
  const candidates = activeThumbnails(await activeConfig());
  if (candidates.length < 2) throw new Error('Activate at least two Home thumbnails before ranking.');
  const rows = await scores(candidates, start, end, 'OneDay');
  console.table(rows.map(row => ({...row, qualifiedPlayRate: row.qualifiedPlayRate === null
    ? '—' : `${(100 * row.qualifiedPlayRate).toFixed(2)}%`})));
  if (rows.some(row => row.impressions < Number(minImpressions))) {
    console.log(`Waiting for ${minImpressions} impressions per variant on shared reporting days.`);
  } else {
    console.log(`Highest observed qualified play rate: Home thumbnail ${rows[0].homeId} (image asset ${rows[0].assetId}).`);
  }
}

async function rotate(start, challenger, baseline, log) {
  const config = await activeConfig();
  const current = homeIds(config);
  if (current.length < 2 || current.length > 5) throw new Error('Activate 2–5 Home thumbnails before rotating.');
  if (current.includes(challenger)) {
    log(`Challenger ${challenger} is already active.`, 'complete');
    return true;
  }
  if (baseline && (baseline.id !== config.id || !sameSet(current, homeIds(baseline)))) {
    throw new Error('The active set changed while waiting. Start a new review with its activation time.');
  }
  const candidate = (await listThumbnails()).find(item => item.homepageThumbnailId === challenger);
  if (!candidate || candidate.moderationStatus === 'Rejected' || candidate.homepageThumbnailStatus === 'Spammy') {
    throw new Error('The challenger must be an available Home thumbnail for this universe.');
  }
  if (!canActivate(candidate)) {
    log(`Waiting for Roblox moderation for ${challenger}.`);
    return config;
  }
  if (current.length < 5) {
    console.log(`Adding ${challenger} to an open slot.`);
    await activate([...current, challenger], config);
    log(`Challenger ${challenger} added to an open slot.`, 'changed');
    return true;
  }
  const end = new Date(Math.floor(Date.now() / hour) * hour);
  if (start >= end) {
    log('Waiting for the first full reporting hour.');
    return config;
  }
  const rows = await scores(activeThumbnails(config), start, end, 'OneHour');
  if (rows.some(row => row.impressions < rotationMinimum)) {
    log('Waiting for 10,000 impressions per thumbnail in shared reporting hours.');
    return config;
  }
  const leader = rows[0], lowest = rows.at(-1);
  if (leader.qualifiedPlayRate === lowest.qualifiedPlayRate) {
    log('The active thumbnails are tied. Waiting for more data.');
    return config;
  }
  console.log(`Keeping leader ${leader.homeId} (image asset ${leader.assetId}) and replacing ${lowest.homeId} with ${challenger}.`);
  await activate([...current.filter(id => id !== lowest.homeId), challenger], config);
  log(`Kept leader ${leader.homeId} and replaced ${lowest.homeId} with ${challenger}.`, 'changed');
  return true;
}

async function reviewRotation(timestamp, challenger, interval) {
  const startTime = Date.parse(timestamp);
  const hours = interval ?? '12';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp || '') ||
      !Number.isFinite(startTime) || new Date(startTime).toISOString() !== timestamp.replace('Z', '.000Z') ||
      startTime > Date.now() || !challenger?.trim() || !['12', '24'].includes(hours)) {
    throw new Error('Pass the UTC activation time (YYYY-MM-DDTHH:MM:SSZ), the approved Home thumbnail ID, and optionally 12 or 24 hours for watch.');
  }
  const {start} = reportingWindow(timestamp);
  const reportPath = process.env.ROLIBRARY_WATCH_REPORT;
  const activityToken = process.env.ROLIBRARY_WATCH_TOKEN?.trim();
  const report = {version: 1, universe, challenger, events: []};
  const log = (message, status = 'waiting') => {
    console.log(message);
    report.events.push({id: randomUUID(), at: new Date().toISOString(), status, message});
    if (report.events.length > 30) report.events.shift();
  };
  async function publishActivity(event, nextCheck) {
    if (!activityToken) return;
    const payload = {...event, universe, challenger, at: Date.parse(event.at), nextCheck};
    try {
      const response = await fetch('https://watch.rolibrary.win/events', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${activityToken}`},
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) console.error(`Dashboard activity update failed (HTTP ${response.status}). Thumbnail rotation continues.`);
    } catch {
      console.error('Could not reach the activity dashboard. Thumbnail rotation continues.');
    }
  }
  async function saveReport(nextCheck) {
    await publishActivity(report.events.at(-1), nextCheck === null ? null : Date.parse(nextCheck));
    if (!reportPath) return;
    const temp = `${reportPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({...report, nextCheck}) + '\n', {flag: 'wx'});
    await rename(temp, reportPath);
  }
  let baseline;
  while (Date.now() - startTime < 29 * 24 * hour) {
    await publishActivity({id: randomUUID(), at: new Date().toISOString(), status: 'checking', message: 'Checking Roblox thumbnail activity.'}, null);
    let result;
    try { result = await rotate(start, challenger, baseline, log); }
    catch (error) {
      if (reportPath || activityToken) {
        log('The check failed. See the watcher terminal for details.', 'error');
        await saveReport(null);
      }
      throw error;
    }
    const finished = result === true || command === 'rotate';
    await saveReport(finished ? null : new Date(Date.now() + Number(hours) * hour).toISOString());
    if (finished) return;
    baseline = result;
    await delay(Number(hours) * hour);
  }
  log('The experiment moved outside the analytics window.', 'complete');
  await saveReport(null);
  throw new Error('This experiment is outside the analytics window. Start a new review with a recent activation time.');
}

try {
  if (command === '--help' || universe === '--help') console.log(usage);
  else {
    if (!/^[1-9]\d{0,19}$/.test(universe || '') || !['upload', 'status', 'activate', 'rank', 'rotate', 'watch'].includes(command)) throw new Error(usage);
    if (!key) throw new Error('Set ROBLOX_API_KEY in the environment.');
    if (command === 'upload') await upload(args);
    if (command === 'status') console.table(await listThumbnails());
    if (command === 'activate') await activate(args);
    if (command === 'rank') await rank(...args);
    if (command === 'rotate' || command === 'watch') await reviewRotation(...args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
