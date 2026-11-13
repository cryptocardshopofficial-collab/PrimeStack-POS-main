import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

const WEBSITE_PORT = Number(process.env.WEBSITE_PORT || process.env.PORT || 9004);
const WEBSITE_HOST = process.env.WEBSITE_HOST || '127.0.0.1';
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9005);
const DASHBOARD_ORIGIN = new URL(
  process.env.DASHBOARD_ORIGIN || `http://localhost:${DASHBOARD_PORT}`
);
const PUBLIC_SITE_HTML = readFileSync(new URL('./public-site.html', import.meta.url));
const DEVELOPER_PORTAL_HTML = readFileSync(new URL('./developer-portal.html', import.meta.url));
const DEVELOPER_SERVICE_HTML = readFileSync(new URL('./developer-service.html', import.meta.url));
const PUBLIC_BRAND_IMAGE = readFileSync(new URL('./Designer (1).jpg', import.meta.url));
const CINEMATIC_THEME_CSS = readFileSync(new URL('./cinematic-theme.css', import.meta.url));
const CINEMATIC_THEME_JS = readFileSync(new URL('./cinematic-theme.js', import.meta.url));
const publicPages = new Set([
  '/', '/payments', '/collect', '/send', '/payouts', '/wallets',
  '/banking', '/settlement', '/network', '/technology', '/iso20022', '/iso8583',
  '/security', '/compliance', '/solutions', '/merchants', '/enterprises', '/partners',
  '/company', '/about', '/careers', '/contact', '/fintech-cloud', '/industries',
  '/resources', '/support', '/pricing',
  '/terms', '/privacy', '/cookies', '/acceptable-use'
]);
const developerServicePages = new Set([
  't2t', 's2s', 'external-terminal', 'api', 'security',
  'banking', 'wallets', 'iso20022', 'iso8583', 'ping'
]);
const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
];

function respond(res, status, contentType, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...headers });
  res.end(body);
}

function proxyToDashboard(req, res, requestUrl) {
  const target = new URL(DASHBOARD_ORIGIN);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  const requestHeaders = { ...req.headers, host: target.host };
  for (const header of hopByHopHeaders) delete requestHeaders[header];

  const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
    target,
    { method: req.method, headers: requestHeaders },
    upstream => {
      const responseHeaders = { ...upstream.headers };
      for (const header of hopByHopHeaders) delete responseHeaders[header];
      res.writeHead(upstream.statusCode || 502, responseHeaders);
      upstream.pipe(res);
    }
  );

  request.on('error', error => {
    console.error(`[public-site] Dashboard proxy failed for ${req.method} ${target.pathname}: ${error.message}`);
    if (!res.headersSent) {
      respond(res, 502, 'application/json; charset=utf-8', JSON.stringify({
        error: 'Bad Gateway',
        message: 'The dashboard/API service is unavailable.'
      }));
    }
  });
  req.on('aborted', () => request.destroy());
  req.pipe(request);
}

const server = createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || '/', 'http://localhost');
  } catch {
    respond(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    return;
  }

  const path = requestUrl.pathname;
  if (req.method === 'GET' && path === '/health') {
    respond(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      service: 'public-site',
      port: WEBSITE_PORT
    }));
    return;
  }

  if (path === '/login' || path === '/logout') {
    const target = new URL(`${path}${requestUrl.search}`, DASHBOARD_ORIGIN);
    res.writeHead(302, { Location: target.href });
    res.end();
    return;
  }

  if (path === '/api' || path.startsWith('/api/')) {
    proxyToDashboard(req, res, requestUrl);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    respond(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  const canonicalPath = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (canonicalPath !== path) {
    res.writeHead(308, { Location: `${canonicalPath}${requestUrl.search}` });
    res.end();
    return;
  }

  if (publicPages.has(path)) {
    respond(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : PUBLIC_SITE_HTML);
    return;
  }

  if (path === '/developer') {
    respond(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : DEVELOPER_PORTAL_HTML);
    return;
  }

  if (path.startsWith('/developer/')) {
    let serviceSlug;
    try {
      serviceSlug = decodeURIComponent(path.slice('/developer/'.length)).replace(/[^a-z0-9-]/g, '');
    } catch {
      respond(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
      return;
    }
    if (developerServicePages.has(serviceSlug)) {
      respond(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : DEVELOPER_SERVICE_HTML);
      return;
    }
  }

  if (path === '/Designer%20(1).jpg' || path === '/Designer (1).jpg') {
    respond(res, 200, 'image/jpeg', req.method === 'HEAD' ? '' : PUBLIC_BRAND_IMAGE, {
      'Cache-Control': 'public, max-age=86400'
    });
    return;
  }

  if (path === '/cinematic-theme.css') {
    respond(res, 200, 'text/css; charset=utf-8', req.method === 'HEAD' ? '' : CINEMATIC_THEME_CSS, {
      'Cache-Control': 'no-cache'
    });
    return;
  }

  if (path === '/cinematic-theme.js') {
    respond(res, 200, 'text/javascript; charset=utf-8', req.method === 'HEAD' ? '' : CINEMATIC_THEME_JS, {
      'Cache-Control': 'no-cache'
    });
    return;
  }

  respond(res, 404, 'text/plain; charset=utf-8', `Page not found: ${path}`);
});

server.on('error', error => {
  console.error(`[public-site] Failed to listen on ${WEBSITE_HOST}:${WEBSITE_PORT}: ${error.message}`);
  process.exitCode = 1;
});

if (!Number.isInteger(WEBSITE_PORT) || WEBSITE_PORT < 1 || WEBSITE_PORT > 65535) {
  throw new Error('WEBSITE_PORT must be an integer between 1 and 65535');
}
if (!Number.isInteger(DASHBOARD_PORT) || DASHBOARD_PORT < 1 || DASHBOARD_PORT > 65535) {
  throw new Error('DASHBOARD_PORT must be an integer between 1 and 65535');
}

server.listen(WEBSITE_PORT, WEBSITE_HOST, () => {
  console.log(`PrimeStack public website running at http://${WEBSITE_HOST}:${WEBSITE_PORT}`);
  console.log(`  Dashboard sign-in: ${DASHBOARD_ORIGIN.href}`);
});
