import assert from 'node:assert/strict';
import test from 'node:test';
import { captionJsonUrl, supadataRead } from '../youtube.ts';

test('supadataRead', async (t) => {
  await t.test('returns undefined when SUPADATA_API_KEY is unset (caller falls back)', async () => {
    const saved = process.env.SUPADATA_API_KEY;
    delete process.env.SUPADATA_API_KEY;
    try {
      assert.equal(await supadataRead('dQw4w9WgXcQ'), undefined);
    } finally {
      if (saved !== undefined) process.env.SUPADATA_API_KEY = saved;
    }
  });

  await t.test('maps the text=true response shape ({content, lang})', async () => {
    const saved = process.env.SUPADATA_API_KEY;
    process.env.SUPADATA_API_KEY = 'test-key';

    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ content: 'Never gonna give you up', lang: 'en', availableLangs: ['en'] }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const out = await supadataRead('dQw4w9WgXcQ');
      assert.equal(out?.text, 'Never gonna give you up');
      assert.equal(out?.language, 'en');
      assert.match(capturedUrl, /v1\/youtube\/transcript\?videoId=dQw4w9WgXcQ&text=true/);
      assert.equal(capturedHeaders['x-api-key'], 'test-key');
    } finally {
      globalThis.fetch = originalFetch;
      if (saved !== undefined) process.env.SUPADATA_API_KEY = saved;
      else delete process.env.SUPADATA_API_KEY;
    }
  });

  await t.test('returns metadataOnly when the API has no transcript content', async () => {
    const saved = process.env.SUPADATA_API_KEY;
    process.env.SUPADATA_API_KEY = 'test-key';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    try {
      const out = await supadataRead('novideo');
      assert.equal(out?.metadataOnly, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (saved !== undefined) process.env.SUPADATA_API_KEY = saved;
      else delete process.env.SUPADATA_API_KEY;
    }
  });
});

test('captionJsonUrl', async (t) => {
  await t.test('replaces an existing fmt parameter instead of appending a second one', () => {
    const out = captionJsonUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3');
    const params = new URL(out).searchParams;
    assert.equal(params.get('fmt'), 'json3');
    assert.equal(params.getAll('fmt').length, 1);
    assert.equal(params.get('lang'), 'en');
  });

  await t.test('adds fmt when absent', () => {
    const out = captionJsonUrl('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    assert.equal(new URL(out).searchParams.get('fmt'), 'json3');
  });
});
