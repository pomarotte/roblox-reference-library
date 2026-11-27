import {serveDashboard} from './dashboard-api.mjs';
import html from './dashboard/index.html';
import css from './dashboard/dashboard.css';
import script from './dashboard/dashboard.client.js';
import autopilot from './dashboard/autopilot.client.js';
import prompt from '../web/thumbnail-prompt.txt';
import upscaler from '../web/thumbnail-upscaler.js';
import {runAutopilot, runCampaign} from './autopilot-api.mjs';

const assets = {
  '/': [html, 'text/html; charset=utf-8'],
  '/dashboard.css': [css, 'text/css; charset=utf-8'],
  '/dashboard.js': [script, 'text/javascript; charset=utf-8'],
  '/thumbnail-upscaler.js': [upscaler, 'text/javascript; charset=utf-8'],
  '/autopilot.js': [autopilot, 'text/javascript; charset=utf-8']
};

export default {
  fetch(request, env, ctx) {
    return serveDashboard(request, env, ctx, assets, prompt);
  },
  scheduled(_controller, env) {
    return runAutopilot(env, prompt);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const {owner, universe} = message.body;
      if (await runCampaign(env, prompt, owner, universe)) message.ack();
      else message.retry({delaySeconds: 5});
    }
  }
};
