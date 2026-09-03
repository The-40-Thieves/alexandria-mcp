// Task 9: claim verification for library_answer/library_research
// (checkClaims), wired in after the answer is synthesized and its
// citations built. For each sentence that carries a citation marker, asks
// the `verify` role (falls back to `synth` when ALEXANDRIA_VERIFY_* is
// unset - src/utils/providers.ts) whether the cited text actually WARRANTS
// the sentence: not merely "is this on the same topic" but the same
// strength, scope, and time (the warrant-strength rubric from
// research/retrieval-sota.md section 4; scripts/eval-answer.ts applies the
// identical rubric offline, as a single supported/unsupported judgment,
// for its citation-precision score). Batches up to BATCH_SIZE sentences
// per chatJSON call, so an answer with several cited sentences costs a
// small, bounded number of extra LLM calls rather than one per sentence.
//
// A sentence whose cited source(s) have no text available to check against
// (a citation whose read() text wasn't captured, e.g. it was cited by
// research's union across rounds rather than this run's own readTopSources)
// fails closed: supported: false, with a note explaining why, rather than
// being skipped or assumed fine.
import { z } from 'zod';
import { extractCitationNumbers, splitSentences } from '../tools/libraryAnswer.ts';
import { chatJSON } from './providers.ts';

// A structural subset of tools/libraryAnswer.ts's Citation - only `n` is
// needed to know which marker numbers are real citations vs. prose (a
// bare "[9]" the model wrote with no matching source). Kept local rather
// than importing the full Citation type so this module only depends on
// libraryAnswer.ts's plain function exports, not its exported types too.
export interface CitationRef {
  n: number;
}

const BATCH_SIZE = 8;

export interface ClaimCheckChunk {
  n: number;
  text: string;
}

export interface ClaimVerdict {
  sentence: string;
  citations: number[];
  supported: boolean;
  strengthWarranted: boolean;
  note?: string;
}

const WARRANT_SYSTEM_PROMPT = `You are a strict fact-checker verifying claims made in a research answer against the source text each claim cites.

For each numbered CLAIM / SOURCE TEXT pair, decide two things:
1. "supported": does the source text actually entail the claim at all - not merely share its topic?
2. "strengthWarranted": if supported, does the source text warrant the claim's specific strength, scope, and time, not just its topic?
   - strength: a source that says something "may" happen or "is associated with" X does not warrant a claim that X definitely happens or is caused.
   - scope: a source about one country, dataset, version, or population does not warrant a claim generalized beyond it.
   - time: a source describing a past or point-in-time state does not warrant a claim about the current, ongoing, or future state, unless the source itself says so.
   If "supported" is false, "strengthWarranted" must also be false.

Optionally include a brief "note" explaining an unsupported or over-strength judgment.

Respond with JSON only: {"results": [{"index": 0, "supported": true, "strengthWarranted": true}, ...]}, exactly one entry per claim index given, in any order.`;

const BatchResultSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      supported: z.boolean(),
      strengthWarranted: z.boolean(),
      note: z.string().optional(),
    }),
  ),
});

interface JudgeableClaim {
  sentence: string;
  evidence: string;
}

interface Judgment {
  supported: boolean;
  strengthWarranted: boolean;
  note?: string;
}

async function judgeBatch(batch: JudgeableClaim[]): Promise<Map<number, Judgment>> {
  const user = batch
    .map((c, i) => `CLAIM ${i}:\n${c.sentence}\n\nSOURCE TEXT ${i}:\n${c.evidence}`)
    .join('\n\n---\n\n');
  const result = await chatJSON('verify', WARRANT_SYSTEM_PROMPT, user, BatchResultSchema);
  const byIndex = new Map<number, Judgment>();
  for (const r of result.results) {
    byIndex.set(r.index, {
      supported: r.supported,
      strengthWarranted: r.supported && r.strengthWarranted,
      note: r.note,
    });
  }
  return byIndex;
}

interface Candidate {
  sentence: string;
  citations: number[];
  evidence?: string;
}

export async function checkClaims(
  answer: string,
  citations: CitationRef[],
  chunks: ClaimCheckChunk[],
): Promise<ClaimVerdict[]> {
  const validNumbers = new Set(citations.map((c) => c.n));
  const textByN = new Map(chunks.map((c) => [c.n, c.text]));

  const candidates: Candidate[] = [];
  for (const sentence of splitSentences(answer)) {
    const nums = [...new Set(extractCitationNumbers(sentence))].filter((n) => validNumbers.has(n));
    if (nums.length === 0) continue;
    const texts = nums.map((n) => textByN.get(n)).filter((t): t is string => Boolean(t));
    candidates.push({
      sentence,
      citations: nums,
      evidence: texts.length > 0 ? texts.join('\n\n---\n\n') : undefined,
    });
  }

  const verdicts: ClaimVerdict[] = candidates.map((c) => ({
    sentence: c.sentence,
    citations: c.citations,
    supported: false,
    strengthWarranted: false,
    ...(c.evidence ? {} : { note: 'no source text available to verify this citation' }),
  }));

  const judgeableIndexes = candidates.map((_, i) => i).filter((i) => candidates[i].evidence);

  for (let i = 0; i < judgeableIndexes.length; i += BATCH_SIZE) {
    const batchIndexes = judgeableIndexes.slice(i, i + BATCH_SIZE);
    const batch = batchIndexes.map((idx) => ({
      sentence: candidates[idx].sentence,
      evidence: candidates[idx].evidence as string,
    }));
    const judged = await judgeBatch(batch);
    batchIndexes.forEach((idx, localI) => {
      const result = judged.get(localI);
      if (result) {
        verdicts[idx].supported = result.supported;
        verdicts[idx].strengthWarranted = result.strengthWarranted;
        if (result.note) verdicts[idx].note = result.note;
      } else {
        verdicts[idx].note = 'verify role returned no judgment for this claim';
      }
    });
  }

  return verdicts;
}
