import { describe, expect, it } from 'vitest';
import { resolveDeveloperPage } from './developer-pages.mjs';

describe('resolveDeveloperPage', () => {
  it('serves the step-by-step developer portal and sender IP onboarding form', () => {
    const page = resolveDeveloperPage('/developer');

    expect(page?.status).toBe(200);
    expect(page?.body).toContain('From access request to first integration');
    expect(page?.body).toContain('Sender Public IP');
  });

  it('serves all linked guide types from the same route map', () => {
    for (const slug of [
      't2t', 's2s', 'external-terminal', 'api', 'security',
      'banking', 'wallets', 'iso20022', 'iso8583', 'ping',
    ]) {
      expect(resolveDeveloperPage(`/developer/${slug}`)?.status).toBe(200);
    }
    expect(resolveDeveloperPage('/developer/funds')?.status).toBe(200);
    expect(resolveDeveloperPage('/developer/reference')?.status).toBe(200);
    expect(resolveDeveloperPage('/developer/reference/transfers')?.status).toBe(200);
    expect(resolveDeveloperPage('/developer-theme.css')?.contentType).toContain('text/css');
  });

  it('normalizes trailing-slash and double-slash developer URLs', () => {
    expect(resolveDeveloperPage('/developer/')).toMatchObject({ status: 200 });
    expect(resolveDeveloperPage('/developer/reference/')).toMatchObject({ status: 200 });
    expect(resolveDeveloperPage('/developer//reference//transfers//')).toMatchObject({ status: 200 });
    expect(resolveDeveloperPage('/developer-theme.css/')).toMatchObject({ status: 200, contentType: expect.stringContaining('text/css') });
  });

  it('does not resolve unknown guide paths', () => {
    expect(resolveDeveloperPage('/developer/not-a-guide')).toBeNull();
    expect(resolveDeveloperPage('/developer/reference/not-a-section')).toBeNull();
  });
});
