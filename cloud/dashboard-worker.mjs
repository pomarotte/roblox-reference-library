import {serveDashboard} from './dashboard-api.mjs';
import html from './dashboard/index.html';
import css from './dashboard/dashboard.css';
import script from './dashboard/dashboard.client.js';
import autopilot from './dashboard/autopilot.client.js';
import prompt from '../web/thumbnail-prompt.txt';
import {runAutopilot} from './autopilot-api.mjs';

const assets = {
  '/': [html, 'text/html; charset=utf-8'],
  '/dashboard.css': [css, 'text/css; charset=utf-8'],
  '/dashboard.js': [script, 'text/javascript; charset=utf-8'],
  '/autopilot.js': [autopilot, 'text/javascript; charset=utf-8']
};

export default {
  fetch(request, env, ctx) {
    return serveDashboard(request, env, ctx, assets);
  },
  scheduled(_controller, env) {
    return runAutopilot(env, prompt);
  }
};
