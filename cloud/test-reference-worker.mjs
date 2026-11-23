import assert from 'node:assert/strict';
import worker from './reference-worker.mjs';

const thumbnail = 'https://tr.rbxcdn.com/180DAY-test/768/432/Image/Webp/noFilter';
const endpoints = [];
globalThis.fetch = async (url, options) => {
  endpoints.push(url);
  assert.equal(options.redirect, 'manual');
  if (url.includes('/places/123/universe')) return Response.json({universeId: 456});
  if (url.includes('/places/999/universe')) return new Response(null, {status: 404});
  if (url.includes('/places/888/universe')) return Response.redirect('https://example.com');
  assert.match(url, /^https:\/\/thumbnails\.roblox\.com\/.*\?universeIds=456&/);
  return Response.json({data: [{universeId: 456, thumbnails: [
    {imageUrl: thumbnail, state: 'Completed'},
    {imageUrl: thumbnail, state: 'Completed'},
    {imageUrl: thumbnail.replace('rbxcdn.com', 'example.com'), state: 'Completed'},
    {imageUrl: thumbnail.replace('test', 'pending'), state: 'Pending'},
  ]}]});
};
const lookup = (query, init) => worker.fetch(new Request(`https://references.rolibrary.win/roblox-thumbnails?${query}`, init));
assert.equal((await lookup('place=123%2F456')).status, 400);
assert.equal((await lookup('place=123', {method: 'POST'})).status, 405);
assert.equal(endpoints.length, 0);
assert.equal((await lookup('place=999')).status, 404);
assert.equal((await lookup('place=888')).status, 502);
const response = await lookup('place=123');
assert.equal(response.status, 200);
assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
assert.deepEqual(await response.json(), {thumbnails: [thumbnail]});
assert.equal(endpoints.length, 4);
