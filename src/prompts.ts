// Task 14 (2026-07-28 dual-era handler, brief 05): canonical research
// workflow prompts. A client surfaces these as slash commands (Claude
// Code's `/alexandria:literature_review`, VS Code's `/alexandria.prompt`) so
// a user gets a ready-made tool-calling plan instead of having to know
// Alexandria's tool names. Each prompt returns exactly one user message
// naming the tools to call, in order; it does not call any tool itself.
//
// Prompt arguments arrive over the wire as a string map (GetPromptRequest's
// `arguments` field, per the MCP spec) regardless of protocol era, so
// `depth` below is `z.coerce.number()` rather than `z.number()` - a bare
// `z.number()` would reject the wire string "2" before the handler ever runs.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'literature_review',
    {
      title: 'Literature Review',
      description: "Survey a topic across Alexandria's library sources and produce a cited report.",
      argsSchema: z.object({
        topic: z.string().min(1).describe('Topic or research question'),
        depth: z.coerce
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('library_research recursion depth, 1-5 (default 2)'),
      }),
    },
    ({ topic, depth }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Conduct a literature review on "${topic}". Call these tools in order: ` +
              '(1) library_list_sources to see which sources are available; ' +
              `(2) library_ask with query "${topic}" to search across the relevant ones; ` +
              `(3) library_research with query "${topic}"${depth ? ` and depth ${depth}` : ''} for a deep, cited report; ` +
              '(4) library_citations on the most relevant result(s) to pull in related work. ' +
              'Summarize the findings with citations, noting any gaps or disagreements between sources.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'fact_check_claim',
    {
      title: 'Fact-Check a Claim',
      description: 'Check one claim against Alexandria and report whether it is supported.',
      argsSchema: z.object({
        claim: z.string().min(1).describe('The claim to check'),
      }),
    },
    ({ claim }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Fact-check this claim: "${claim}". Call these tools in order: ` +
              `(1) library_ask with query "${claim}" to find sources that bear on it; ` +
              '(2) library_read on the most relevant result(s) to check the claim against full text; ' +
              `(3) library_answer with query "${claim}" for a cited verdict. ` +
              'Report whether the claim is supported, contradicted, or unresolved, and cite the sources either way.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'verify_bibliography',
    {
      title: 'Verify a Bibliography',
      description: 'Check that a list of references resolves to real, findable items.',
      argsSchema: z.object({
        references: z.string().min(1).describe('Bibliography entries, one per line'),
      }),
    },
    ({ references }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Verify this bibliography, one reference per line:\n\n${references}\n\n` +
              'For each reference, call these tools in order: ' +
              "(1) library_search (or library_ask if the source is unclear) with the reference's title/authors to confirm it exists; " +
              "(2) library_citations on any match to check it isn't retracted and see what cites or is cited by it; " +
              '(3) library_read if you need the full text to confirm the reference actually supports the claim it is cited for. ' +
              'Report each reference as verified, not found, or suspicious (e.g. mismatched authors/year), with the evidence.',
          },
        },
      ],
    }),
  );
}
