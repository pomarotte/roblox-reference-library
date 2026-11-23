const thumbnailPath = /^https:\/\/(?:[a-z0-9-]+\.)?rbxcdn\.com\/[a-z0-9-]+\/768\/432\/Image\/Webp\/noFilter$/i;
const idPattern = /^[1-9]\d{0,19}$/;
const headers = {'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'};

function failure(error, status) {
  return Response.json({error}, {status, headers});
}

async function get(url) {
  return fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(8000)});
}

export default {
  async fetch(request) {
    const {pathname, searchParams} = new URL(request.url);
    if (pathname !== '/roblox-thumbnails') return failure('Not found.', 404);
    if (request.method !== 'GET') return failure('Use GET.', 405);
    const place = searchParams.get('place');
    if (!idPattern.test(place || '')) return failure('Use a valid Roblox place ID.', 400);
    try {
      const resolution = await get(`https://apis.roblox.com/universes/v1/places/${place}/universe`);
      if (resolution.status === 404) return failure('Roblox could not find this game.', 404);
      if (!resolution.ok) return failure('Roblox game lookup is unavailable.', 502);
      const {universeId} = await resolution.json();
      if (!universeId) return failure('Roblox could not find this game.', 404);
      if (!Number.isSafeInteger(universeId) || !idPattern.test(String(universeId))) return failure('Invalid Roblox game response.', 502);
      const result = await get(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=10&defaults=false&size=768x432&format=Webp&isCircular=false`);
      if (!result.ok) return failure('Roblox thumbnails are unavailable.', 502);
      const {data} = await result.json();
      const thumbnails = (data.find(game => game.universeId === universeId)?.thumbnails || [])
        .filter(item => item.state === 'Completed' && thumbnailPath.test(item.imageUrl))
        .map(item => item.imageUrl);
      return Response.json({thumbnails: [...new Set(thumbnails)]}, {headers});
    } catch {
      return failure('Roblox thumbnails are unavailable. Try again later.', 502);
    }
  }
};
