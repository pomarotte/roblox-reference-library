const chartsUrl = 'https://pomarotte.github.io/roblox-reference-library/cloud/data/charts.json';
const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent';
export const imageLimit = 3_000_000;
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const cdnImage = value => typeof value === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)?rbxcdn\.com\/[\w./-]+$/i.test(value);
export const imageKey = (universe, id) => `autopilot/${universe}/${id}`;
function base64(buffer) {
  const input = new Uint8Array(buffer), chunks = [];
  for (let offset = 0; offset < input.length; offset += 8192) {
    chunks.push(String.fromCharCode(...input.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(''));
}
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export async function storageKey(secret, owner, universe, value, decrypt = false) {
  const key = await crypto.subtle.importKey('raw', bytes(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const additionalData = encoder.encode(`${owner}/${universe}`);
  if (decrypt) {
    const [iv, ciphertext] = value.split('.').map(bytes);
    return decoder.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData}, key, ciphertext));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData}, key, encoder.encode(value));
  return `${base64(iv)}.${base64(ciphertext)}`;
}

async function readLimited(stream, limit) {
  if (!stream) throw new Error('The image is empty.');
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('The input exceeds the size limit.');
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

export async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new Error('Use a JSON request.');
  return JSON.parse(decoder.decode(await readLimited(request.body, 48_000)));
}

async function checkedFetch(url, options = {}, timeout = 20_000) {
  const response = await fetch(url, {...options, redirect: 'manual', signal: AbortSignal.timeout(timeout)});
  if (!response.ok) throw new Error(`Upstream service returned HTTP ${response.status}.`);
  return response;
}

async function remoteImage(url) {
  if (!cdnImage(url)) throw new Error('The Roblox thumbnail URL is unavailable.');
  const response = await checkedFetch(url);
  const mimeType = response.headers.get('Content-Type')?.split(';')[0];
  if (!imageTypes.includes(mimeType)) throw new Error('The Roblox thumbnail format is unsupported.');
  return {mimeType, data: base64(await readLimited(response.body, 1_500_000))};
}

export async function storeImage(env, universe, id, stream, asset = false, inputLimit = 8_000_000) {
  const input = await readLimited(stream, inputLimit);
  const format = asset ? 'image/webp' : 'image/jpeg';
  const size = asset ? {width: 900, height: 900, fit: 'scale-down'} : {width: 1920, height: 1080, fit: 'cover'};
  const response = (await env.AUTOPILOT_IMAGES.input(new Blob([input]).stream())
    .transform(size).output({format, quality: asset ? 85 : 91, anim: false})).response();
  if (!response.ok || response.headers.get('Content-Type') !== format) throw new Error('The image could not be prepared.');
  const output = await readLimited(response.body, asset ? 800_000 : imageLimit - 1);
  if (!output.length) throw new Error('The image could not be prepared.');
  await env.AUTOPILOT_MEDIA.put(imageKey(universe, id), output, {httpMetadata: {contentType: format}});
}

export async function robloxImages(ids) {
  const images = new Map();
  const unique = [...new Set(ids.map(String))].filter(id => /^\d{1,20}$/.test(id));
  for (let offset = 0; offset < unique.length; offset += 50) {
    const query = new URLSearchParams({assetIds: unique.slice(offset, offset + 50).join(','), size: '768x432', format: 'Webp', isCircular: 'false'});
    const response = await checkedFetch(`https://thumbnails.roblox.com/v1/assets?${query}`);
    for (const item of (await response.json()).data || []) {
      if (item.state === 'Completed' && cdnImage(item.imageUrl)) images.set(String(item.targetId), item.imageUrl);
    }
  }
  return images;
}

const stop = new Set('about after also another around away because been being before could each from game games have into just make many more much only other over play player players really should show some than that their them then these they this those through together used very want were what when where which while will with work would your'.split(' '));
const words = value => new Set((String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  .map(word => word.replace(/(?<=.{3})s$/, '')).filter(word => !stop.has(word)));

export function matchReferences(snapshot, universe, description) {
  const keywords = words(description);
  const candidates = new Map();
  for (const category of Object.values(snapshot.genres || {})) {
    for (const games of [category.games || [], ...Object.values(category.subgenres || {})]) {
      for (const game of games) candidates.set(String(game.id), game);
    }
  }
  return [...candidates].flatMap(([id, game]) => {
    const image = [...(game.thumbnails || []), game.image].find(cdnImage);
    if (id === universe || !image) return [];
    const title = words(`${game.name} ${game.genre} ${game.subgenre || ''}`);
    const summary = words(game.description || '');
    const rank = [...keywords].reduce((total, word) => total + (title.has(word) ? 3 : summary.has(word) ? 1 : 0), 0);
    return rank ? [{id, name: game.name, image, rank}] : [];
  }).sort((left, right) => right.rank - left.rank).slice(0, 8);
}

export async function findReferences(universe, description) {
  const response = await checkedFetch(chartsUrl);
  return matchReferences(await response.json(), universe, description);
}

const directions = [
  'a close-up of a recognizable character reacting to an in-game event',
  'a clear action shot showing the main gameplay mechanic',
  'a wide scene that shows the most distinctive environment',
  'a low-angle composition that makes the central action easy to read',
  'a tight composition centered on a recognizable gameplay prop',
  'a dramatic moment with a clear foreground and strong depth',
  'a two-subject composition that shows an actual gameplay interaction',
  'a simple silhouette and strong lighting that communicate the game’s mood',
  'a different camera angle on an in-game turning point',
  'a bright, readable composition focused on the game’s main objective'
];

export function describeDraft(brief, index, parent) {
  const assets = brief.assets.map(asset => `${asset.kind} ${asset.name}${asset.required ? ' (must include)' : ''}`).join(', ');
  const references = brief.references.map(reference => reference.name).join(', ');
  return [
    `Create a Roblox Home thumbnail for this game. ${brief.description}`,
    `Explore ${directions[index % directions.length]}. Only depict characters, environments, and actions that fit the game.`,
    parent && `Use the performance reference ${parent.label} as the starting composition. Preserve its recognizable subject and change the camera or emphasis to match this direction.`,
    assets && `Use these supplied game assets as the source of truth: ${assets}.`,
    references && `Use the following similar-game examples only for framing, lighting, or composition: ${references}. Do not reproduce their characters, names, logos or distinctive graphic layouts.`,
    'Compose for a 16:9 Home feed tile. Keep the main action readable at small sizes. Avoid added lettering unless the brief explicitly requires it.'
  ].filter(Boolean).join('\n');
}

export async function generateDraft(env, universe, item, brief, prompt) {
  const parts = [{text: `${prompt}\n\n${item.description}`}];
  for (const asset of brief.assets) {
    const source = await env.AUTOPILOT_MEDIA.get(imageKey(universe, asset.id));
    if (!source) throw new Error('A game asset is missing.');
    parts.push({text: `Game asset: ${asset.kind} — ${asset.name}.`},
      {inlineData: {mimeType: 'image/webp', data: base64(await source.arrayBuffer())}});
  }
  if (item.parent) {
    const {id, image} = item.parent;
    const source = id && await env.AUTOPILOT_MEDIA.get(imageKey(universe, id));
    const reference = source
      ? {mimeType: 'image/jpeg', data: base64(await source.arrayBuffer())}
      : await remoteImage(image);
    parts.push({text: 'This is the selected high-performing thumbnail for your own game.'}, {inlineData: reference});
  }
  for (const reference of brief.references) {
    parts.push({text: `Composition and lighting inspiration only: ${reference.name}.`},
      {inlineData: await remoteImage(reference.image)});
  }
  const response = await checkedFetch(geminiUrl, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.AUTOPILOT_GEMINI_KEY},
    body: JSON.stringify({contents: [{parts}], generationConfig: {
      responseModalities: ['IMAGE'], imageConfig: {aspectRatio: '16:9', imageSize: '2K'}
    }})
  }, 100_000);
  const data = await response.json();
  const result = (data.candidates || []).flatMap(candidate => candidate.content?.parts || [])
    .find(part => !part.thought && part.inlineData?.data)?.inlineData;
  if (!result) throw new Error('Gemini did not return an image.');
  await storeImage(env, universe, item.id, new Blob([bytes(result.data)]).stream(), false, 15_000_000);
}

export function sendReviewEmail(env, owner, universe, game, batch) {
  const url = `https://analytics.rolibrary.win/?game=${universe}&batch=${batch.id}`;
  return checkedFetch('https://api.resend.com/emails', {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${env.AUTOPILOT_RESEND_KEY}`,
      'Idempotency-Key': `rolibrary-review-${batch.id}`},
    body: JSON.stringify({from: env.AUTOPILOT_MAIL_FROM, to: [owner], subject: 'RoLibrary thumbnails ready for review',
      text: `${game.name}'s round ${batch.number} is ready for review. Review the final images and approve the ones to submit to Roblox.\n\n${url}`})
  });
}
