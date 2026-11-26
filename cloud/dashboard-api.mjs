import {activeThumbnails, homeAnalytics, hour, reportingWindow, rotationMinimum} from './home-analytics.mjs';
import {dashboardActivity, watchHost, watcherIngest} from './dashboard-activity.mjs';
import {autopilotApi, autopilotConnection} from './autopilot-api.mjs';
import {robloxImages} from './autopilot-services.mjs';

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https://*.rbxcdn.com https://rbxcdn.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const json = (data, status = 200) => Response.json(data, {status, headers});

export async function serveDashboard(request, env, ctx, assets) {
  const {pathname, origin, hostname} = new URL(request.url);
  if (hostname === watchHost) {
    try { return await watcherIngest(request, env.WATCH_ACTIVITY); }
    catch { return json({error: 'Watcher activity is temporarily unavailable.'}, 503); }
  }
  if (!env.ACCESS_AUDIENCE || ctx.access?.aud !== env.ACCESS_AUDIENCE) {
    return json({error: 'Sign in through RoLibrary’s Cloudflare Access application.'}, 403);
  }

  if (request.method === 'GET' && Object.hasOwn(assets, pathname)) {
    const [body, type] = assets[pathname];
    return new Response(body, {headers: {...headers, 'Content-Type': type}});
  }
  if (request.method === 'GET' && pathname === '/api/session') {
    const identity = await ctx.access.getIdentity();
    return identity?.email ? json({email: identity.email}) : json({error: 'Sign in with your authorized email address.'}, 403);
  }
  if (pathname === '/api/activity') {
    const identity = await ctx.access.getIdentity();
    if (!identity?.email) return json({error: 'Sign in with your authorized email address.'}, 403);
    try { return await dashboardActivity(request, env.WATCH_ACTIVITY, identity.email.toLowerCase()); }
    catch { return json({error: 'Watcher activity is temporarily unavailable.'}, 503); }
  }
  if (pathname === '/api/autopilot') {
    const identity = await ctx.access.getIdentity();
    return identity?.email ? autopilotApi(request, env, identity.email.toLowerCase())
      : json({error: 'Sign in with your authorized email address.'}, 403);
  }
  if (pathname !== '/api/performance') return json({error: 'Page not found.'}, 404);
  if (request.method !== 'POST') return json({error: 'Use POST.'}, 405);
  if (request.headers.get('Origin') !== origin || !request.headers.get('Content-Type')?.startsWith('application/json')) {
    return json({error: 'Open the RoLibrary dashboard to connect Roblox.'}, 403);
  }
  let data;
  try { data = await request.json(); }
  catch { return json({error: 'Invalid connection request.'}, 400); }
  let {universe, key, activatedAt} = data || {};
  let minimum = rotationMinimum;
  if (key == null && typeof universe === 'string' && /^[1-9]\d{0,19}$/.test(universe) && env.AUTOPILOT_ENCRYPTION_KEY) {
    const identity = await ctx.access.getIdentity();
    if (!identity?.email) return json({error: 'Sign in with your authorized email address.'}, 403);
    try {
      const saved = await autopilotConnection(env, identity.email.toLowerCase(), universe);
      key = saved?.key;
      minimum = saved?.minimum ?? minimum;
      if (!activatedAt && saved?.since) activatedAt = new Date(Math.max(Date.parse(saved.since), Date.now() - 28 * 24 * hour)).toISOString();
    } catch {
      return json({error: 'The saved game connection is unavailable.'}, 503);
    }
  }
  if (typeof universe !== 'string' || !/^[1-9]\d{0,19}$/.test(universe) ||
      typeof key !== 'string' || !/^[!-~]{1,1024}$/.test(key) ||
      (activatedAt != null && (typeof activatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(activatedAt)))) {
    return json({error: 'Enter a Universe ID, scoped Roblox API key, and valid activation time.'}, 400);
  }
  const now = Date.now();
  try {
    const {activeConfig, scores} = homeAnalytics(universe, key);
    const config = await activeConfig();
    const startTime = activatedAt || config?.createdUtc || new Date(now).toISOString();
    let window;
    try { window = reportingWindow(startTime, now); }
    catch { return json({error: 'Enter the last activation time within the past 29 days.'}, 400); }
    const {start, end} = window;
    const active = activeThumbnails(config);
    const previews = robloxImages(active.map(item => item.assetId), 5000).catch(() => new Map());
    const trendHours = end - start <= 48 * hour ? 1 : 24;
    const metrics = start < end && active.length
      ? await scores(active, start, end, 'OneHour', trendHours)
      : active.map(item => ({homeId: item.homepageThumbnailId, assetId: String(item.assetId),
        impressions: 0, qualifiedPlays: 0, qualifiedPlayRate: null, timeline: []}));
    const images = await previews;
    const rows = metrics.map(row => ({...row, image: images.get(row.assetId)}));
    return json({universe, activatedAt: startTime, windowStart: start.toISOString(), windowEnd: end.toISOString(),
      checkedAt: new Date(now).toISOString(), minimum, trendHours, rows});
  } catch (error) {
    if (/HTTP (401|403) /.test(error.message)) {
      return json({error: 'Roblox denied access. Check the key, Universe ID, and thumbnail and analytics read permissions.'}, 403);
    }
    return json({error: 'Roblox analytics are unavailable. Try refreshing shortly.'}, 502);
  }
}
