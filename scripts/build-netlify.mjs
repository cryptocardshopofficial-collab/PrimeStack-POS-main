// Builds the static Netlify bundle for the public website into ./netlify-dist.
//
// Mirrors the routing of start-public-site.js: the marketing site is a single
// HTML document with client-side routing, while the developer and merchant
// pages are separate documents served at their own URLs.

import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReferenceGuide, REFERENCE_BASE_PATH } from '../src/public-site/reference-guide.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'netlify-dist');

// Platform API/console origin. /api/* and sign-in are proxied here so the site
// keeps working without the Node server. Override per deploy with the
// PLATFORM_ORIGIN environment variable in Netlify.
const PLATFORM_ORIGIN = (process.env.PLATFORM_ORIGIN || 'https://primestack-switch.onrender.com').replace(/\/+$/, '');

// Every developer service slug renders the same document.
const DEVELOPER_SERVICE_PAGES = [
  't2t', 's2s', 'external-terminal', 'api', 'security',
  'banking', 'wallets', 'iso20022', 'iso8583', 'ping'
];

const read = name => readFileSync(join(root, name), 'utf8');

async function writeRoute(route, html) {
  const dir = route === '/' ? out : join(out, route.replace(/^\/+/, ''));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), html);
}

// Windows can still hold handles on freshly written files, so retry the clean
// instead of failing the whole build with ENOTEMPTY/EBUSY.
await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(out, { recursive: true });

// ─── Pages ───────────────────────────────────────────────────────────────────
await writeRoute('/', read('public-site.html'));
await writeRoute('/developer', read('developer-portal.html'));
await writeRoute('/developer/funds', read('developer-funds.html'));
await writeRoute('/merchant-register', read('merchant-registration.html'));
await writeRoute('/register', read('merchant-registration.html'));

await mkdir(join(out, 'developer'), { recursive: true });
await writeFile(join(out, 'developer', 'service.html'), read('developer-service.html'));

const guide = buildReferenceGuide(read('docs/usage-guide.html'));
await writeRoute(REFERENCE_BASE_PATH, guide.directory);
for (const [slug, html] of guide.pages) {
  await writeRoute(`${REFERENCE_BASE_PATH}/${slug}`, html);
}

// ─── Assets ──────────────────────────────────────────────────────────────────
for (const asset of [
  'Designer (1).jpg',
  'cinematic-theme.css',
  'cinematic-theme.js',
  'developer-theme.css'
]) {
  await copyFile(join(root, asset), join(out, asset));
}

// ─── Routing ─────────────────────────────────────────────────────────────────
// Existing files always win; these only catch paths with no file behind them.
const redirects = [
  '# API + console proxy (server-side, so /api/health and sign-in keep working)',
  `/api/*    ${PLATFORM_ORIGIN}/api/:splat    200`,
  `/login    ${PLATFORM_ORIGIN}/login         302`,
  `/logout   ${PLATFORM_ORIGIN}/logout        302`,
  `/merchant-login    ${PLATFORM_ORIGIN}/merchant-login    302`,
  '',
  '# Developer service pages all share one document',
  ...DEVELOPER_SERVICE_PAGES.map(slug => `/developer/${slug}    /developer/service.html    200`),
  '',
  '# Marketing site: one document, client-side routing',
  '/*    /index.html    200'
].join('\n');
await writeFile(join(out, '_redirects'), `${redirects}\n`);

const headers = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  "  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
].join('\n');
await writeFile(join(out, '_headers'), `${headers}\n`);

console.log(`Netlify bundle written to ${out}`);
console.log(`  platform origin: ${PLATFORM_ORIGIN}`);
console.log(`  reference pages: ${guide.pages.size}`);
