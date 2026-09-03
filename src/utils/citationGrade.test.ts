import assert from 'node:assert/strict';
import test from 'node:test';

// authParam() (src/sources/openalex.ts) warns on stderr when CONTACT_EMAIL
// is unset - harmless for grading (the mailto param is just polite-pool
// courtesy), but this keeps the suite's output pristine, matching
// src/web/openAccess.test.ts's precedent.
process.env.CONTACT_EMAIL = 'test@example.org';

import {
  fetchOpenAlexGradeSignals,
  type GradeSignals,
  gradeCitations,
  gradeFromSignals,
  normalizeDoi,
  retractedWarning,
  sourceTierFor,
} from './citationGrade.ts';

test('sourceTierFor', async (t) => {
  await t.test('a known preprint server is tier 2 regardless of cluster', () => {
    assert.equal(sourceTierFor('arxiv', 'academic'), 2);
    assert.equal(sourceTierFor('biorxiv', 'science'), 2);
  });

  await t.test('academic cluster (minus preprint servers) is tier 1', () => {
    assert.equal(sourceTierFor('openalex', 'academic'), 1);
    assert.equal(sourceTierFor('semanticscholar', 'academic'), 1);
  });

  await t.test('libraries, archives, and government cluster to tier 2', () => {
    assert.equal(sourceTierFor('gutenberg', 'literature'), 2);
    assert.equal(sourceTierFor('loc', 'archives'), 2);
    assert.equal(sourceTierFor('congress', 'government'), 2);
  });

  await t.test('news and web fetch cluster to tier 4', () => {
    assert.equal(sourceTierFor('guardian', 'news_global'), 4);
    assert.equal(sourceTierFor('webfetch', 'web'), 4);
  });

  await t.test('an unmapped cluster defaults to tier 3', () => {
    assert.equal(sourceTierFor('ietf', 'standards'), 3);
  });

  await t.test('no cluster at all also defaults to tier 3', () => {
    assert.equal(sourceTierFor('knowledge', undefined), 3);
  });
});

function fullSignals(overrides: Partial<GradeSignals> = {}): GradeSignals {
  return { sourceTier: 1, fullTextVerified: true, ...overrides };
}

test('gradeFromSignals', async (t) => {
  await t.test('retracted is always D, regardless of every other signal', () => {
    assert.equal(gradeFromSignals(fullSignals({ retracted: true })), 'D');
    assert.equal(
      gradeFromSignals(fullSignals({ retracted: true, sourceTier: 1, chainSupported: true })),
      'D',
    );
  });

  await t.test('tier 1, full text verified, no chain check: A', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 1 })), 'A');
  });

  await t.test('tier 2, full text verified: B', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 2 })), 'B');
  });

  await t.test('tier 3 or 4, full text verified: C', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 3 })), 'C');
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 4 })), 'C');
  });

  await t.test('unverified full text downgrades one step', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 1, fullTextVerified: false })), 'B');
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 2, fullTextVerified: false })), 'C');
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 3, fullTextVerified: false })), 'D');
  });

  await t.test('a failed chain-support check downgrades one step', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 1, chainSupported: false })), 'B');
  });

  await t.test('two downgrades compound (tier 2 base, both apply): B -> C -> D', () => {
    assert.equal(
      gradeFromSignals(
        fullSignals({ sourceTier: 2, fullTextVerified: false, chainSupported: false }),
      ),
      'D',
    );
  });

  await t.test('chainSupported undefined ("not checked") does not downgrade', () => {
    assert.equal(gradeFromSignals(fullSignals({ sourceTier: 1, chainSupported: undefined })), 'A');
  });

  await t.test('a tier already at D cannot downgrade further', () => {
    assert.equal(
      gradeFromSignals(
        fullSignals({ sourceTier: 3, fullTextVerified: false, chainSupported: false }),
      ),
      'D',
    );
  });
});

test('normalizeDoi', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/Example'), '10.1000/example');
  assert.equal(normalizeDoi('10.1000/Example'), '10.1000/example');
});

test('retractedWarning', () => {
  assert.equal(
    retractedWarning(3, 'A Paper Title'),
    'citation [3] (A Paper Title) is marked retracted',
  );
});

// fetchOpenAlexGradeSignals and gradeCitations both call fetchJSON, which
// (per src/tools/libraryCitations.test.ts's own precedent) resolves through
// the ambient global fetch - stubbed here the same way, keyed by URL
// substring.
function stubFetchOnce(respond: (url: string) => Response) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    return respond(u);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('fetchOpenAlexGradeSignals', async (t) => {
  await t.test('empty input makes no request and returns an empty map', async () => {
    const { calls, restore } = stubFetchOnce(() => {
      throw new Error('should not be called');
    });
    t.after(restore);
    const result = await fetchOpenAlexGradeSignals([]);
    assert.equal(result.size, 0);
    assert.deepEqual(calls, []);
  });

  await t.test('maps a batched response back by normalized DOI', async () => {
    const { calls, restore } = stubFetchOnce((url) => {
      assert.match(url, /filter=doi:https:\/\/doi\.org\/10\.1000\/a/);
      return jsonResponse({
        results: [
          {
            doi: 'https://doi.org/10.1000/A',
            is_retracted: true,
            cited_by_count: 42,
            primary_location: { source: { type: 'repository' } },
          },
        ],
      });
    });
    t.after(restore);

    const result = await fetchOpenAlexGradeSignals(['10.1000/a']);
    assert.equal(calls.length, 1);
    const signal = result.get('10.1000/a');
    assert.ok(signal);
    assert.equal(signal.retracted, true);
    assert.equal(signal.citationCount, 42);
    assert.equal(signal.sourceType, 'repository');
  });

  await t.test('a failed batch resolves to an empty map rather than throwing', async () => {
    const { restore } = stubFetchOnce(() => jsonResponse({ error: 'boom' }, 500));
    t.after(restore);
    const result = await fetchOpenAlexGradeSignals(['10.1000/b']);
    assert.equal(result.size, 0);
  });
});

test('gradeCitations', async (t) => {
  await t.test('a retracted, DOI-bearing academic citation grades D', async () => {
    const { restore } = stubFetchOnce(() =>
      jsonResponse({
        results: [
          {
            doi: 'https://doi.org/10.1000/retracted',
            is_retracted: true,
            cited_by_count: 5,
          },
        ],
      }),
    );
    t.after(restore);

    const grades = await gradeCitations([
      {
        n: 1,
        source: 'openalex',
        id: 'W123',
        cluster: 'academic',
        doi: '10.1000/retracted',
        fullTextVerified: true,
      },
    ]);
    const grade = grades.get(1);
    assert.ok(grade);
    assert.equal(grade.tier, 'D');
    assert.equal(grade.signals.retracted, true);
    assert.equal(grade.signals.citationCount, 5);
  });

  await t.test('OpenAlex source type refines the static sourceTier', async () => {
    const { restore } = stubFetchOnce(() =>
      jsonResponse({
        results: [
          {
            doi: 'https://doi.org/10.1000/preprint',
            is_retracted: false,
            primary_location: { source: { type: 'preprint' } },
          },
        ],
      }),
    );
    t.after(restore);

    // doaj is registered academic (static tier 1), but this work's own
    // primary_location says 'preprint' - live data should win, dropping
    // the effective sourceTier to 2 (grade B, not A).
    const grades = await gradeCitations([
      {
        n: 1,
        source: 'doaj',
        id: 'x',
        cluster: 'academic',
        doi: '10.1000/preprint',
        fullTextVerified: true,
      },
    ]);
    const grade = grades.get(1);
    assert.ok(grade);
    assert.equal(grade.signals.sourceTier, 2);
    assert.equal(grade.tier, 'B');
  });

  await t.test('no DOI at all still grades from the static sourceTier alone', async () => {
    const { calls, restore } = stubFetchOnce(() => {
      throw new Error('should not be called with no DOIs');
    });
    t.after(restore);

    const grades = await gradeCitations([
      {
        n: 1,
        source: 'webfetch',
        id: 'https://example.com/a',
        cluster: 'web',
        fullTextVerified: true,
      },
    ]);
    assert.deepEqual(calls, []);
    const grade = grades.get(1);
    assert.ok(grade);
    assert.equal(grade.signals.sourceTier, 4);
    assert.equal(grade.tier, 'C');
  });

  await t.test(
    'a semanticscholar citation with no DOI still gets its own citation-count signals',
    async () => {
      const { calls, restore } = stubFetchOnce((url) => {
        assert.match(
          url,
          /paper\/paperId123\?fields=citationCount,influentialCitationCount,isOpenAccess/,
        );
        return jsonResponse({
          paperId: 'paperId123',
          citationCount: 120,
          influentialCitationCount: 7,
          isOpenAccess: true,
        });
      });
      t.after(restore);

      const grades = await gradeCitations([
        {
          n: 1,
          source: 'semanticscholar',
          id: 'paperId123',
          cluster: 'academic',
          fullTextVerified: true,
        },
      ]);
      assert.equal(
        calls.length,
        1,
        'only the Semantic Scholar lookup fires - no DOI means no OpenAlex call',
      );
      const grade = grades.get(1);
      assert.ok(grade);
      assert.equal(grade.signals.sourceTier, 1);
      assert.equal(grade.signals.citationCount, 120);
      assert.equal(grade.signals.influentialCitations, 7);
      assert.equal(grade.tier, 'A');
    },
  );
});
