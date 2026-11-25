import {serveDashboard} from './dashboard-api.mjs';
import html from './dashboard/index.html';
import css from './dashboard/dashboard.css';
import script from './dashboard/dashboard.client.js';

const assets = {
  '/': [html, 'text/html; charset=utf-8'],
  '/dashboard.css': [css, 'text/css; charset=utf-8'],
  '/dashboard.js': [script, 'text/javascript; charset=utf-8']
};

export default {
  fetch(request, env, ctx) {
    return serveDashboard(request, env, ctx, assets);
  }
};
