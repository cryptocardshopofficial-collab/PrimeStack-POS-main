import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const pages = [
  {
    file: '../../public-site.html',
    selector: 'applySiteGoogleLanguage',
    storageKey: 'primestack-site-language',
  },
  {
    file: '../../developer-portal.html',
    selector: 'applyDeveloperGoogleLanguage',
    storageKey: 'primestack-developer-language',
  },
];

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);

  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed ${name}`);
}

describe('public site language selectors', () => {
  for (const page of pages) {
    it(`${page.file} offers Russian, Malayalam, and Tamil`, async () => {
      const html = await readFile(new URL(page.file, import.meta.url), 'utf8');
      const optionValues = Array.from(html.matchAll(/<option value="([^"]*)">/g), match => match[1]);
      const includedLanguages = html.match(/includedLanguages:\s*'([^']+)'/);

      expect(optionValues).toEqual(expect.arrayContaining(['ru', 'ml', 'ta']));
      expect(includedLanguages).not.toBeNull();
      expect(includedLanguages?.[1].split(',')).toEqual(expect.arrayContaining(['ru', 'ml', 'ta']));
      expect(html).toContain(`localStorage.getItem('${page.storageKey}')`);
    });

    it(`${page.file} restores English by clearing the translation cookie and reloading`, async () => {
      const html = await readFile(new URL(page.file, import.meta.url), 'utf8');
      const functionSource = extractFunction(html, page.selector);
      let cookie = 'googtrans=/en/ru';
      let reloads = 0;
      const googleSelect = {
        value: 'ru',
      };

      vm.runInNewContext(`${functionSource}; ${page.selector}('en', 0);`, {
        document: {
          querySelector: () => googleSelect,
          get cookie() {
            return cookie;
          },
          set cookie(value: string) {
            if (value.startsWith('googtrans=;expires=')) cookie = '';
          },
        },
        window: { setTimeout, location: { hostname: 'example.test', reload: () => { reloads += 1; } } },
        Event: class {
          type: string;
          bubbles: boolean;

          constructor(type: string, options: { bubbles: boolean }) {
            this.type = type;
            this.bubbles = options.bubbles;
          }
        },
      });

      expect(cookie).toBe('');
      expect(reloads).toBe(1);
    });

    it(`${page.file} applies Russian, Malayalam, and Tamil to Google Translate`, async () => {
      const html = await readFile(new URL(page.file, import.meta.url), 'utf8');
      const functionSource = extractFunction(html, page.selector);

      for (const language of ['ru', 'ml', 'ta']) {
        const dispatched: Array<{ type: string; bubbles: boolean }> = [];
        const googleSelect = {
          value: '',
          dispatchEvent(event: { type: string; bubbles: boolean }) {
            dispatched.push({ type: event.type, bubbles: event.bubbles });
          },
        };
        vm.runInNewContext(`${functionSource}; ${page.selector}('${language}', 0);`, {
          document: { querySelector: () => googleSelect, cookie: '' },
          window: { setTimeout, location: { hostname: 'example.test', reload() {} } },
          Event: class {
            type: string;
            bubbles: boolean;

            constructor(type: string, options: { bubbles: boolean }) {
              this.type = type;
              this.bubbles = options.bubbles;
            }
          },
        });

        expect(googleSelect.value).toBe(language);
        expect(dispatched).toEqual([{ type: 'change', bubbles: true }]);
      }
    });
  }
});
