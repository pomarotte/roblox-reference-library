import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {serveDashboard} from './dashboard-api.mjs';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(new URL('./dashboard-migrations/0001_watch_activity.sql', import.meta.url), 'utf8'));
const database = {
  prepare(sql) {
    return {bind(...args) {
      const statement = sqlite.prepare(sql);
      return {
        first: () => statement.get(...args),
        run: () => ({meta: statement.run(...args)}),
        execute: () => sql.trimStart().startsWith('SELECT')
          ? {results: statement.all(...args)}
          : {meta: statement.run(...args)}
      };
    }};
  },
  async batch(statements) { return statements.map(statement => statement.execute()); }
};
const env = {ACCESS_AUDIENCE: 'dashboard', WATCH_ACTIVITY: database};
const origin = 'https://analytics.rolibrary.win';
const user = (email = 'creator@example.com') => ({access: {aud: 'dashboard', getIdentity: async () => ({email})}});
const activity = (method = 'GET', ctx = user(), universe = '123', source = origin) =>
  serveDashboard(new Request(`${origin}/api/activity?universe=${universe}`, {
    method, headers: {Origin: source}
  }), env, ctx, {});
const publish = (token, event) => serveDashboard(new Request('https://watch.rolibrary.win/events', {
  method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
  body: JSON.stringify(event)
}), env, {}, {});

try {
  assert.equal((await activity('GET', {})).status, 403);
  assert.equal((await activity('POST', user(), '123', 'https://example.org')).status, 403);
  const pair = await activity('POST');
  assert.equal(pair.status, 201);
  const {token} = await pair.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(sqlite.prepare('SELECT token_hash FROM watch_connections').get().token_hash, token);

  const at = Date.now();
  const first = {universe: '123', id: crypto.randomUUID(), at, status: 'waiting', message: 'Waiting for impressions.',
    challenger: 'test-challenger', nextCheck: at + 12 * 3_600_000};
  assert.equal((await publish('wrong', first)).status, 401);
  assert.equal((await publish(token, {...first, universe: '456'})).status, 403);
  assert.equal((await publish(token, {...first, status: 'invalid'})).status, 400);
  assert.equal((await publish(token, {...first, message: 'x'.repeat(4096)})).status, 400);
  assert.equal((await publish(token, first)).status, 202);
  assert.equal((await publish(token, first)).status, 202);
  const second = {...first, id: crypto.randomUUID(), at: at + 1, status: 'changed', message: 'Challenger became active.', nextCheck: null};
  assert.equal((await publish(token, second)).status, 202);

  const current = await (await activity()).json();
  assert.equal(current.paired, true);
  assert.equal(current.lastRotationAt, second.at);
  assert.deepEqual(current.events.map(item => item.status), ['changed', 'waiting']);
  assert.equal(current.events[1].nextCheck, first.nextCheck);
  assert.ok(!JSON.stringify(current).includes(token));
  assert.deepEqual((await (await activity('GET', user('second@example.com'))).json()).events, []);
  assert.deepEqual((await (await activity('GET', user(), '456')).json()).events, []);

  const refreshed = await (await activity('POST')).json();
  assert.notEqual(refreshed.token, token);
  assert.equal((await publish(token, first)).status, 403);
  assert.equal((await publish(refreshed.token, first)).status, 202);
  assert.equal((await activity('DELETE')).status, 200);
  assert.equal((await publish(refreshed.token, first)).status, 403);
  assert.equal((await (await activity()).json()).paired, false);
  assert.equal((await (await activity()).json()).events.length, 2);
} finally {
  sqlite.close();
}

console.log('Watcher token scoping, automatic activity history, deduplication, and revocation passed.');
