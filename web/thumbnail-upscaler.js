'use strict';

let upscaler;

async function loadScript(path, integrity) {
  const response = await fetch('https://cdn.jsdelivr.net/npm/' + path, {integrity});
  if (!response.ok) throw new Error('The upscaler could not load.');
  const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], {type: 'text/javascript'}));
  try { importScripts(url); }
  finally { URL.revokeObjectURL(url); }
}

async function loadUpscaler() {
  await loadScript('@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    'sha384-vE8hbVJ4lezako5rlvE7bY0BVzWlFhZncPlckrqNwcUQpVtgbENTgZ8TBbnPjZre');
  await loadScript('@upscalerjs/default-model@1.0.0/dist/umd/index.min.js',
    'sha384-GBfBtFQvD01K2rgUfQyn9FasV6Lq+6aKOkoE7a+lghzwzdz+la3ct/nXp/t9EfOR');
  await loadScript('upscaler@1.0.0/dist/browser/umd/upscaler.min.js',
    'sha384-QMCS4oRU0yhc/triRbY4mcIreg38XzA/8NNuZfTWWvv/km8cX/L63yLb3hh0IaA3');
  return new Upscaler({model: DefaultUpscalerJSModel});
}

self.onmessage = async ({data: image}) => {
  let bitmap, input, output, pixels;
  try {
    upscaler ||= await loadUpscaler();
    bitmap = await createImageBitmap(image);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    input = tf.browser.fromPixels(context.getImageData(0, 0, canvas.width, canvas.height));
    output = await upscaler.upscale(input, {
      output: 'tensor', patchSize: 96, padding: 8,
      progress: progress => self.postMessage({progress})
    });
    if (output.shape[0] !== bitmap.height * 2 || output.shape[1] !== bitmap.width * 2) {
      throw new Error('The model returned an unexpected resolution.');
    }
    pixels = tf.tidy(() => output.round().clipByValue(0, 255).toInt());
    await tf.browser.toPixels(pixels, canvas);
    self.postMessage({image: await canvas.convertToBlob({type: 'image/png'})});
  } catch (error) {
    self.postMessage({error: error.message});
  } finally {
    bitmap?.close();
    input?.dispose();
    output?.dispose();
    pixels?.dispose();
  }
};
