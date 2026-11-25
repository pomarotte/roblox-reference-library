import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const variants = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
  homepageThumbnailId: id, assetId: 100 + index, moderationStatus: 'Approved',
  homepageThumbnailStatus: 'Active', personalizedThumbnailStatus: 'Active'
}));
let active = variants.slice(1, 3);
let impressionsPerThumbnail = 2000;
let applied, requestCount = 0, run = 0;
const messages = [];
const {log, table} = console;
console.log = (...values) => messages.push(values.join(' '));
console.table = values => messages.push(values);
const originalArgv = process.argv;
const originalKey = process.env.ROBLOX_API_KEY;
const originalReport = process.env.ROLIBRARY_WATCH_REPORT;
const originalFetch = globalThis.fetch;
process.env.ROBLOX_API_KEY = 'test-key';

globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://apis.roblox.com');
  assert.equal(options.headers['x-api-key'], 'test-key');
  assert.equal(options.redirect, 'error');
  requestCount++;
  const endpoint = parsed.pathname.split('/123')[1];
  if (endpoint === '/thumbnails/uploads') {
    const files = options.body.getAll('files');
    assert.deepEqual(files.map(file => file.type), ['image/png', 'image/jpeg']);
    return Response.json({fileToOperationIdDict: Object.fromEntries(files.map((file, index) => [file.name, `op${index}`]))});
  }
  if (endpoint === '/thumbnails/uploads/status') {
    assert.deepEqual(parsed.searchParams.getAll('operationIds'), ['op0', 'op1']);
    return Response.json({uploadStatus: 'Finished', uploadThumbnailStatusDict: {op0: variants[0], op1: variants[1]}});
  }
  if (endpoint === '/thumbnails') {
    return Response.json(parsed.searchParams.has('nextCursor')
      ? {homepageThumbnails: variants.slice(1)}
      : {homepageThumbnails: variants.slice(0, 1), nextCursor: 'page2'});
  }
  if (endpoint === '/personalization') {
    assert.equal(parsed.searchParams.get('status'), 'Active');
    return Response.json({personalizedConfigs: [{id: 'current', thumbnails: active}]});
  }
  if (endpoint === '/personalization/update') {
    applied = JSON.parse(options.body);
    active = variants.filter(variant => applied.homepageThumbnailIds.includes(variant.homepageThumbnailId));
    return new Response('Saved');
  }
  assert.equal(endpoint, '/metrics');
  const body = JSON.parse(options.body);
  assert.deepEqual(body.breakdown, ['ThumbnailAsset']);
  assert.deepEqual(body.filter[0].values, active.map(item => String(item.assetId)));
  const rates = body.metric === 'ThumbnailImpressions'
    ? active.map(() => impressionsPerThumbnail)
    : [100, 300, 250, 140, 150];
  return Response.json({done: true, response: {values: active.map((variant, index) => ({
    breakdowns: [{dimension: 'ThumbnailAsset', value: String(variant.assetId)}],
    dataPoints: [{time: body.startTime, value: rates[index]}, {time: body.endTime, value: 9999, status: 'Projected'}]
  }))}});
};

async function invoke(...args) {
  process.argv = [...originalArgv.slice(0, 2), '123', ...args];
  await import(`./home-thumbnails.mjs?run=${++run}`);
  assert.equal(process.exitCode || 0, 0);
}

const folder = await mkdtemp(join(tmpdir(), 'rolibrary-home-'));
const files = ['roblox-home-123-test-v1.png', 'roblox-home-123-test-v2.jpg'].map(name => join(folder, name));
const reportFile = join(folder, 'rotation.json');
process.env.ROLIBRARY_WATCH_REPORT = reportFile;
try {
  await Promise.all(files.map(file => writeFile(file, 'fixture')));
  await invoke('upload', ...files);
  assert.equal(messages.at(-1)[0].homepageThumbnailId, 'a');
  await invoke('activate', 'a', 'b');
  assert.deepEqual(applied, {id: 'current', homepageThumbnailIds: ['a', 'b']});
  assert.match(messages.at(-1), /Home personalization active/);
  await invoke('activate', 'b', 'a');
  assert.match(messages.at(-1), /already active/);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await invoke('rank', yesterday);
  assert.deepEqual(messages.at(-2).map(row => row.qualifiedPlayRate), ['15.00%', '5.00%']);
  assert.match(messages.at(-1), /thumbnail b \(image asset 101\)/);
  await invoke('rank', yesterday, '3000');
  assert.match(messages.at(-1), /Waiting for 3000 impressions/);
  const started = `${yesterday}T00:00:00Z`;
  await invoke('rotate', started, 'c');
  assert.deepEqual(applied.homepageThumbnailIds, ['a', 'b', 'c']);
  active = variants.slice(0, 5);
  applied = undefined;
  impressionsPerThumbnail = 9_999;
  await invoke('rotate', started, 'f');
  assert.match(messages.at(-1), /10,000 impressions per thumbnail in shared reporting hours/);
  assert.equal(applied, undefined);
  impressionsPerThumbnail = 10_000;
  await invoke('watch', started, 'f', '24');
  assert.deepEqual(applied, {id: 'current', homepageThumbnailIds: ['b', 'c', 'd', 'e', 'f']});
  assert.match(messages.at(-1), /Kept leader b and replaced a with f/);
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(report.nextCheck, null);
  assert.equal(report.universe, '123');
  assert.equal(report.challenger, 'f');
  assert.match(report.events[0].message, /replaced a with f/);
  applied = undefined;
  await invoke('rotate', started, 'f');
  assert.match(messages.at(-1), /already active/);
  assert.equal(applied, undefined);
  assert.ok(requestCount > 0);
} finally {
  await Promise.all([...files, reportFile].map(file => rm(file, {force: true})));
  await rmdir(folder);
  process.argv = originalArgv;
  if (originalKey === undefined) delete process.env.ROBLOX_API_KEY;
  else process.env.ROBLOX_API_KEY = originalKey;
  if (originalReport === undefined) delete process.env.ROLIBRARY_WATCH_REPORT;
  else process.env.ROLIBRARY_WATCH_REPORT = originalReport;
  globalThis.fetch = originalFetch;
  console.log = log;
  console.table = table;
}

console.log('Open Cloud upload, activation, ranking, and five-slot rotation passed.');
