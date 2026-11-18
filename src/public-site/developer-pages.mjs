import { readFileSync } from 'node:fs';
import { buildReferenceGuide, REFERENCE_BASE_PATH } from './reference-guide.mjs';

const DEVELOPER_PORTAL_HTML = readFileSync(
  new URL('../../developer-portal.html', import.meta.url),
  'utf8',
);
const DEVELOPER_SERVICE_HTML = readFileSync(
  new URL('../../developer-service.html', import.meta.url),
  'utf8',
);
const DEVELOPER_API_REFERENCE_HTML = readFileSync(
  new URL('../../docs/usage-guide.html', import.meta.url),
  'utf8',
);
const DEVELOPER_FUNDS_GUIDE_HTML = readFileSync(
  new URL('../../developer-funds.html', import.meta.url),
  'utf8',
);
const DEVELOPER_THEME_CSS = readFileSync(
  new URL('../../developer-theme.css', import.meta.url),
  'utf8',
);
const REFERENCE_GUIDE = buildReferenceGuide(DEVELOPER_API_REFERENCE_HTML);
const DEVELOPER_SERVICE_PAGES = new Set([
  't2t', 's2s', 'external-terminal', 'api', 'security',
  'banking', 'wallets', 'iso20022', 'iso8583', 'ping',
]);

export function normalizeDeveloperPath(requestPath) {
  if (!requestPath || requestPath === '/') return requestPath;
  const collapsed = requestPath.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function page(contentType, body, status = 200, headers = {}) {
  return { contentType, body, status, headers };
}

export function resolveDeveloperPage(requestPath) {
  const path = normalizeDeveloperPath(requestPath);

  if (path === '/developer') {
    return page('text/html; charset=utf-8', DEVELOPER_PORTAL_HTML);
  }
  if (path === '/developer/funds') {
    return page('text/html; charset=utf-8', DEVELOPER_FUNDS_GUIDE_HTML);
  }
  if (path === REFERENCE_BASE_PATH) {
    return page('text/html; charset=utf-8', REFERENCE_GUIDE.directory);
  }
  if (path.startsWith(`${REFERENCE_BASE_PATH}/`)) {
    const sectionPage = REFERENCE_GUIDE.pages.get(path.slice(REFERENCE_BASE_PATH.length + 1));
    return sectionPage
      ? page('text/html; charset=utf-8', sectionPage)
      : null;
  }
  if (path.startsWith('/developer/')) {
    let serviceSlug;
    try {
      serviceSlug = decodeURIComponent(path.slice('/developer/'.length))
        .replace(/[^a-z0-9-]/g, '');
    } catch {
      return page('text/plain; charset=utf-8', 'Bad Request', 400);
    }
    return DEVELOPER_SERVICE_PAGES.has(serviceSlug)
      ? page('text/html; charset=utf-8', DEVELOPER_SERVICE_HTML)
      : null;
  }
  if (path === '/developer-theme.css') {
    return page('text/css; charset=utf-8', DEVELOPER_THEME_CSS, 200, {
      'Cache-Control': 'no-cache',
    });
  }

  return null;
}
