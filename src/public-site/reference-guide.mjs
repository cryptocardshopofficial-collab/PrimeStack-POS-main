// The API reference guide (docs/usage-guide.html) is authored as a single
// document. It is sliced into a directory page (/developer/reference) plus one
// standalone page per TOC section (/developer/reference/<slug>) so each entry
// opens its own URL in the same tab.
//
// Shared by the Node site server (start-public-site.js) and the Netlify static
// build (scripts/build-netlify.mjs) so both emit identical pages.

export const REFERENCE_BASE_PATH = '/developer/reference';

export function buildReferenceGuide(source) {
  const at = needle => {
    const index = source.indexOf(needle);
    if (index === -1) throw new Error(`usage-guide.html is missing the marker: ${needle}`);
    return index;
  };

  const navAt = at('<!-- ═══ NAV ═══ -->');
  const mainAt = at('<!-- ═══ MAIN ═══ -->');
  const heroAt = at('<!-- HERO -->');
  const flightAt = at('<!-- ─── FLIGHT LOG — integration path timeline ─── -->');
  const tocAt = at('<!-- ─── TABLE OF CONTENTS ─── -->');
  const firstSectionAt = source.search(/<!-- ─── \d+\./);
  const footerAt = at('<footer>');
  if (firstSectionAt === -1) throw new Error('usage-guide.html is missing its numbered sections');

  const prologue = source.slice(0, navAt);
  const nav = source.slice(navAt, mainAt);
  const mainOpen = source.slice(mainAt, heroAt);
  const hero = source.slice(heroAt, flightAt);
  const flight = source.slice(flightAt, tocAt);
  const toc = source.slice(tocAt, firstSectionAt);
  const tail = source.slice(footerAt);

  const sections = new Map();
  const sectionPattern = /<section id="([a-z0-9-]+)">[\s\S]*?<\/section>/g;
  for (let match = sectionPattern.exec(source); match; match = sectionPattern.exec(source)) {
    sections.set(match[1], match[0]);
  }
  if (sections.size === 0) throw new Error('usage-guide.html contains no <section id="..."> blocks');

  // Section entries stop being in-page anchors — each one becomes its own URL.
  const toPageLink = html => html.replace(/href="#([a-z0-9-]+)"/g, (full, slug) =>
    sections.has(slug) ? `href="${REFERENCE_BASE_PATH}/${slug}"` : full
  );

  const directory = toPageLink(prologue + nav + mainOpen + hero + flight + toc + tail);

  const pages = new Map();
  for (const [slug, block] of sections) {
    const url = `${REFERENCE_BASE_PATH}/${slug}`;
    const brandClose = nav.indexOf('</div>');
    const backLink = `<a href="${REFERENCE_BASE_PATH}">← All Sections</a>`;
    const spacedNav = brandClose === -1
      ? nav.replace('</nav>', `  ${backLink}\n</nav>`)
      : `${nav.slice(0, brandClose + 6)}\n  ${backLink}${nav.slice(brandClose + 6)}`;
    const navForSection = toPageLink(spacedNav)
      .replace(`<a href="${url}">`, `<a class="active" href="${url}">`);
    pages.set(slug, prologue + navForSection + mainOpen + block + tail);
  }

  return { directory, pages };
}
