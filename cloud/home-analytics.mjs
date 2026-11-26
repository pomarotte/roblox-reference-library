export const hour = 3_600_000;
export const rotationMinimum = 10_000;

export function reportingWindow(time, now = Date.now()) {
  const start = new Date(Math.ceil(Date.parse(time) / hour) * hour);
  const end = new Date(Math.floor(now / hour) * hour);
  if (!Number.isFinite(+start) || Date.parse(time) > now || now - Date.parse(time) >= 29 * 24 * hour) {
    throw new Error('Enter an activation time within the past 29 days.');
  }
  return {start, end};
}

export function activeThumbnails(config) {
  return (config?.thumbnails ?? []).filter(item => item.personalizedThumbnailStatus === 'Active');
}

export const homeIds = config => activeThumbnails(config).map(item => item.homepageThumbnailId);
export const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id));
export const canActivate = item => item.moderationStatus === 'Approved' && item.homepageThumbnailStatus === 'Active';

export class RobloxApiError extends Error {
  constructor(status, path, reason) {
    super(`Roblox returned HTTP ${status} for ${path.split('?')[0]}.`);
    this.status = status;
    this.reason = reason;
  }
}

export function homeAnalytics(universe, key) {
  const thumbnails = `/thumbnail-personalization-api/v1/universes/${universe}`;
  const analytics = `/analytics-query-api/v1/universes/${universe}`;

  async function request(path, {body, json} = {}) {
    const headers = {'x-api-key': key};
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const response = await fetch(`https://apis.roblox.com${path}`, {
      method: body ? 'POST' : 'GET', body, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const data = [401, 403].includes(response.status) ? await response.json().catch(() => null) : null;
      const message = data?.errors?.[0]?.message || data?.message;
      let reason;
      if (typeof message === 'string' && /\bip\b/i.test(message)) reason = 'ip';
      if (message === 'Invalid authentication data provided' || message === 'Invalid API Key') reason = 'authentication';
      throw new RobloxApiError(response.status, path, reason);
    }
    const content = await response.text();
    return content && response.headers.get('content-type')?.includes('json') ? JSON.parse(content) : undefined;
  }

  async function activeConfig() {
    const result = await request(`${thumbnails}/personalization?status=Active`);
    const personalizedConfigs = result?.personalizedConfigs;
    if (!Array.isArray(personalizedConfigs) || personalizedConfigs.length > 1) throw new Error('Unexpected active configuration response.');
    return personalizedConfigs[0];
  }

  async function listThumbnails() {
    const items = [], cursors = new Set();
    let cursor = '';
    do {
      if (cursors.has(cursor)) throw new Error('Roblox repeated a thumbnail page.');
      cursors.add(cursor);
      const query = cursor ? `?${new URLSearchParams({nextCursor: cursor})}` : '';
      const page = await request(`${thumbnails}/thumbnails${query}`);
      if (!Array.isArray(page?.homepageThumbnails)) throw new Error('Unexpected homepage thumbnail list response.');
      items.push(...page.homepageThumbnails);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  function updateActive(ids, config) {
    return request(`${thumbnails}/personalization/${config ? 'update' : 'create'}`, {
      json: config ? {id: config.id, homepageThumbnailIds: ids} : {homepageThumbnailIds: ids}
    });
  }

  async function thumbnailMetric(metric, startTime, endTime, assetIds, granularity) {
    let result = await request(`${analytics}/metrics`, {json: {
      metric, startTime, endTime, granularity, breakdown: ['ThumbnailAsset'],
      filter: [{dimension: 'ThumbnailAsset', operation: 'In', values: assetIds}]
    }});
    for (let attempt = 0; !result.done && attempt < 20; attempt++) {
      const prefix = `v1/universes/${universe}/operations/metrics/`;
      if (!result.path?.startsWith(prefix) || !/^[\w-]+$/.test(result.path.slice(prefix.length))) {
        throw new Error('Unexpected analytics operation path.');
      }
      await new Promise(resolve => setTimeout(resolve, 3_000));
      result = await request(`/analytics-query-api/${result.path}`);
    }
    if (!result.done || result.error) throw new Error(`${metric} is unavailable. Check the date range and analytics permission.`);
    return new Map(result.response.values.map(series => [
      String(series.breakdowns.find(item => item.dimension === 'ThumbnailAsset')?.value),
      new Map(series.dataPoints.filter(point => Number.isFinite(point.value) &&
        point.value >= 0 && (!point.status || point.status === 'Valid')).map(point => [point.time, point.value]))
    ]));
  }

  async function scores(candidates, start, end, granularity, trendHours = 0) {
    const assetIds = candidates.map(item => String(item.assetId));
    const [impressions, plays] = await Promise.all(['ThumbnailImpressions', 'ThumbnailQualifiedPlays'].map(metric =>
      thumbnailMetric(metric, start.toISOString(), end.toISOString(), assetIds, granularity)));
    const buckets = [...(impressions.get(assetIds[0])?.keys() || [])].filter(time => {
      const timestamp = Date.parse(time);
      return timestamp >= +start && timestamp < +end && assetIds.every(id => {
        const views = impressions.get(id)?.get(time), qualified = plays.get(id)?.get(time);
        return views > 0 && qualified >= 0 && qualified <= views;
      });
    }).sort((a, b) => Date.parse(a) - Date.parse(b));
    return candidates.map(variant => {
      const id = String(variant.assetId);
      const timeline = new Map();
      let views = 0, qualifiedPlays = 0;
      for (const time of buckets) {
        const impressionsInBucket = impressions.get(id).get(time), playsInBucket = plays.get(id).get(time);
        views += impressionsInBucket;
        qualifiedPlays += playsInBucket;
        if (trendHours) {
          const interval = trendHours * hour;
          const at = Math.floor(Date.parse(time) / interval) * interval;
          const point = timeline.get(at) || {at, impressions: 0, qualifiedPlays: 0};
          point.impressions += impressionsInBucket;
          point.qualifiedPlays += playsInBucket;
          timeline.set(at, point);
        }
      }
      const row = {homeId: variant.homepageThumbnailId, assetId: id, impressions: views, qualifiedPlays,
        qualifiedPlayRate: views ? qualifiedPlays / views : null};
      if (trendHours) row.timeline = [...timeline.values()];
      return row;
    }).sort((a, b) => b.qualifiedPlayRate - a.qualifiedPlayRate);
  }

  return {thumbnails, request, activeConfig, listThumbnails, updateActive, scores};
}
