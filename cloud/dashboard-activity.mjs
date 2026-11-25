export const watchHost = 'watch.rolibrary.win';
const maxEventBytes = 4096;
const universePattern = /^[1-9]\d{0,19}$/;
const eventPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const statuses = ['checking', 'waiting', 'changed', 'complete', 'error'];
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const tokenHash = async token => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store'}});

async function eventBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json') || !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxEventBytes);
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (size + value.length > maxEventBytes) { await reader.cancel(); return null; }
    bytes.set(value, size);
    size += value.length;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); }
  catch { return null; }
}

export async function watcherIngest(request, db) {
  if (new URL(request.url).pathname !== '/events') return json({error: 'Page not found.'}, 404);
  if (request.method !== 'POST') return json({error: 'Use POST.'}, 405);
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return json({error: 'A watcher connection token is required.'}, 401);
  const event = await eventBody(request);
  const {universe, id, at, status, message, challenger, nextCheck} = event || {};
  if (typeof universe !== 'string' || !universePattern.test(universe) || typeof id !== 'string' || !eventPattern.test(id) ||
      !Number.isSafeInteger(at) || Math.abs(at - Date.now()) > 86_400_000 ||
      !statuses.includes(status) || typeof message !== 'string' || !message.trim() || message.length > 400 ||
      typeof challenger !== 'string' || !/^[\w:.-]{1,128}$/.test(challenger) ||
      (nextCheck !== null && (!Number.isSafeInteger(nextCheck) || nextCheck < at || nextCheck - at > 90_000_000))) {
    return json({error: 'Invalid watcher event.'}, 400);
  }
  const hash = await tokenHash(token);
  const [insert] = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO watch_events (owner, universe, event_id, at, status, message, challenger, next_check)
      SELECT owner, universe, ?, ?, ?, ?, ?, ?
      FROM watch_connections WHERE token_hash = ? AND universe = ?
    `).bind(id, at, status, message, challenger, nextCheck, hash, universe),
    db.prepare(`
      DELETE FROM watch_events WHERE rowid IN (
        SELECT e.rowid FROM watch_connections c
        JOIN watch_events e ON e.owner = c.owner AND e.universe = c.universe
        WHERE c.token_hash = ? AND c.universe = ?
        ORDER BY e.at DESC, e.event_id DESC LIMIT -1 OFFSET 100
      )
    `).bind(hash, universe)
  ]);
  if (!insert.meta.changes) {
    const duplicate = await db.prepare(`
      SELECT 1 FROM watch_connections c JOIN watch_events e ON e.owner = c.owner AND e.universe = c.universe
      WHERE c.token_hash = ? AND c.universe = ? AND e.event_id = ?
    `).bind(hash, universe, id).first();
    if (!duplicate) return json({error: 'The watcher token is invalid for this Universe ID.'}, 403);
  }
  return json({accepted: true}, 202);
}

export async function dashboardActivity(request, db, owner) {
  const {origin, searchParams} = new URL(request.url);
  const universe = searchParams.get('universe') || '';
  if (!universePattern.test(universe)) return json({error: 'Enter a valid Universe ID.'}, 400);
  if (request.method === 'GET') {
    const [connection, activity, recentChange] = await db.batch([
      db.prepare('SELECT token_hash IS NOT NULL AS paired FROM watch_connections WHERE owner = ? AND universe = ?').bind(owner, universe),
      db.prepare(`
        SELECT event_id AS id, at, status, message, challenger, next_check AS nextCheck
        FROM watch_events WHERE owner = ? AND universe = ?
        ORDER BY at DESC, event_id DESC LIMIT 30
      `).bind(owner, universe),
      db.prepare("SELECT MAX(at) AS at FROM watch_events WHERE owner = ? AND universe = ? AND status = 'changed'").bind(owner, universe)
    ]);
    return json({paired: Boolean(connection.results[0]?.paired), events: activity.results, lastRotationAt: recentChange.results[0]?.at ?? null});
  }
  if (request.headers.get('Origin') !== origin) return json({error: 'Use the RoLibrary dashboard.'}, 403);
  if (request.method === 'POST') {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare(`
      INSERT INTO watch_connections (owner, universe, token_hash) VALUES (?, ?, ?)
      ON CONFLICT(owner, universe) DO UPDATE SET token_hash = excluded.token_hash
    `).bind(owner, universe, await tokenHash(token)).run();
    return json({token}, 201);
  }
  if (request.method === 'DELETE') {
    await db.prepare('UPDATE watch_connections SET token_hash = NULL WHERE owner = ? AND universe = ?').bind(owner, universe).run();
    return json({paired: false});
  }
  return json({error: 'Method not allowed.'}, 405);
}
