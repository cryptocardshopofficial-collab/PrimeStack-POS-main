import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolveDeveloperPage } from './src/public-site/developer-pages.mjs';

const WEBSITE_PORT = Number(process.env.WEBSITE_PORT || process.env.PORT || 9004);
const WEBSITE_HOST = process.env.WEBSITE_HOST || '127.0.0.1';
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9005);
const DASHBOARD_ORIGIN = new URL(
  process.env.DASHBOARD_ORIGIN || `http://localhost:${DASHBOARD_PORT}`
);
const PUBLIC_SITE_HTML = readFileSync(new URL('./public-site.html', import.meta.url));
const PUBLIC_BRAND_IMAGE = readFileSync(new URL('./Designer (1).jpg', import.meta.url));
const CINEMATIC_THEME_CSS = readFileSync(new URL('./cinematic-theme.css', import.meta.url));
const CINEMATIC_THEME_JS = readFileSync(new URL('./cinematic-theme.js', import.meta.url));
const BANKING_THEME_JS = readFileSync(new URL('./banking-theme.js', import.meta.url));
const MERCHANT_REGISTRATION_HTML = readFileSync(new URL('./merchant-registration.html', import.meta.url));
const publicPages = new Set([
  '/', '/payments', '/collect', '/send', '/payouts', '/wallets',
  '/banking', '/settlement', '/network', '/technology', '/iso20022', '/iso8583',
  '/security', '/compliance', '/solutions', '/merchants', '/enterprises', '/partners',
  '/company', '/about', '/careers', '/contact', '/fintech-cloud', '/industries',
  '/resources', '/support', '/pricing',
  '/terms', '/privacy', '/cookies', '/acceptable-use'
]);
const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
];

function respond(res, status, contentType, body, headers = {}) {
  const cache = contentType.startsWith('text/html') ? { 'Cache-Control': 'no-store' } : {};
  res.writeHead(status, { 'Content-Type': contentType, ...cache, ...headers });
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

// Content-Security-Policy is delivered in REPORT-ONLY mode first. The site's
// pages are built from inline scripts/styles, so an enforcing policy has to be
// validated against real traffic before it is switched on.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
  res.removeHeader('X-Powered-By');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const server = createServer((req, res) => {
  applySecurityHeaders(res);

  let requestUrl;
  try {
    requestUrl = new URL(req.url || '/', 'http://localhost');
  } catch {
    respond(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    return;
  }

  const path = requestUrl.pathname;

  // Never serve dotfiles (.env, .git, .ssh, …) or directory listings.
  if (path !== '/' && /(^|\/)\.[^/]/.test(path)) {
    respond(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    respond(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      service: 'public-site',
      port: WEBSITE_PORT
    }));
    return;
  }

  if (path === '/login' || path === '/logout' || path === '/merchant-login') {
    const targetPath = path === '/logout' ? '/logout' : '/merchant-login';
    const target = new URL(`${targetPath}${requestUrl.search}`, DASHBOARD_ORIGIN);
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

  if (path === '/merchant-register' || path === '/register') {
    respond(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : MERCHANT_REGISTRATION_HTML);
    return;
  }

  const developerPage = resolveDeveloperPage(path);
  if (developerPage) {
    respond(
      res,
      developerPage.status,
      developerPage.contentType,
      req.method === 'HEAD' ? '' : developerPage.body,
      developerPage.headers,
    );
    return;
  }
  if (path === '/developer' || path.startsWith('/developer/')) {
    respond(res, 404, 'text/plain; charset=utf-8', `Page not found: ${path}`);
    return;
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

  if (path === '/banking-theme.js') {
    respond(res, 200, 'text/javascript; charset=utf-8', req.method === 'HEAD' ? '' : BANKING_THEME_JS, {
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
