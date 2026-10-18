import type { AskInput } from './card';
import type { InterviewCard, InterviewDecision, InterviewMessage, InterviewReading } from './types';

// A demo round shaped after the usability report's own cases. Fixture rounds
// never reach Claude: their events stay local and replies are canned here.

export const DEMO: AskInput = {
  title: 'Rerank spec gaps (demo)',
  cards: [
    {
      id: 'rerank-fields',
      question: 'How should Model and Provider be filled on each rerank item?',
      why: 'AC 3.2 requires both fields on every item, but the plan never says where their values come from.',
      evidence: [{ source: '01_spec.md AC 3.2', asOf: 'read 14:02' }, { source: 'src/rerank.py:40-88', asOf: 'read 14:03' }],
      context: 'AC 3.2: "Each rerank item records the model and provider that scored it."\nsrc/rerank.py:52: item = RerankItem(text=hit.text, score=s)',
      options: [
        { id: 'from-request', label: 'Copy from the request', consequence: 'Every item gets the model and provider of the call that scored it. One small change in rerank.py.', by: 'claude', preview: '{\n  "text": "…",\n  "score": 0.82,\n  "model": "rerank-v3",\n  "provider": "cohere"\n}' },
        { id: 'from-config', label: 'Read from settings', consequence: 'Values come from the app settings, so they can be wrong when a request overrides the model.', by: 'claude', preview: 'model=settings.RERANK_MODEL\nprovider=settings.RERANK_PROVIDER' },
        { id: 'leave-null', label: 'Leave them empty for now', consequence: 'AC 3.2 stays unmet; the verify step will report it as PARTIAL.', by: 'claude' },
      ],
      recommended: { option: 'from-request', reason: 'It is the only option that stays correct when a request picks a different model.' },
      leaves: 'whether old stored items are backfilled',
      key: 'rerank.model-provider',
    },
    {
      id: 'commit-shape',
      question: 'Commit only, or commit, push and open the PR?',
      why: 'The four fixes are done and the tests pass; the next step depends on whether you want to review locally first.',
      evidence: [{ source: 'npm test', asOf: 'passed 14:10' }, { source: 'git status, branch fix/rerank-fields', asOf: '0 behind origin/main at 14:11' }],
      options: [
        { id: 'commit', label: 'Commit only', consequence: 'One commit on the branch; nothing leaves your machine.', by: 'claude', preview: 'git commit -m "Fill model and provider on rerank items"' },
        { id: 'pr', label: 'Commit, push and open the PR', consequence: 'Pushes the branch and opens a PR your reviewers will see.', by: 'claude', preview: 'git commit …\ngit push -u origin fix/rerank-fields\ngh pr create --fill' },
      ],
      recommended: { option: 'commit', reason: 'You said you review locally before anything is pushed.' },
    },
    {
      id: 'paid-run',
      question: 'Run the live evaluation now?',
      why: 'The rerank change only shows its effect against the real model; the unit tests stub it.',
      evidence: [{ source: 'tools/eval.py --help', asOf: 'read 14:12' }, { source: 'API key check', asOf: 'valid at 14:12' }],
      options: [
        { id: 'run', label: 'Run it', consequence: 'Calls the paid API once per item; stops after 20 items or the first error.', by: 'claude', preview: 'python tools/eval.py --items 20 --stop-on-error\n# cost: about $0.40 · time: ~2 min' },
        { id: 'hold', label: 'Hold until the PR is reviewed', consequence: 'No cost now; the PR goes out without live numbers.', by: 'claude' },
      ],
      recommended: { option: 'run', reason: 'Cheap, bounded, and the numbers make the PR easier to review.' },
      gate: true,
    },
    {
      id: 'ticket-wording',
      question: 'Should AC 5 be reworded to match what was built?',
      why: 'The implementation returns 502 for an upstream failure; the ticket text says 500.',
      evidence: [],
      unverified: 'Azure DevOps is unreachable from this session, so this compares against the local 00_reqs.md copy from 2026-09-14.',
      options: [
        { id: 'reword', label: 'Draft the new wording', consequence: 'You get the exact text to paste into the ticket; nothing is written to the tracker.', by: 'you', preview: 'AC 5: "An upstream failure returns 502 Bad Gateway."' },
        { id: 'change-code', label: 'Change the code to 500', consequence: 'Code follows the ticket; one test changes.', by: 'claude' },
      ],
    },
    {
      id: 'vector-store',
      question: 'Keep Chroma as the vector store for the retrieval tests?',
      why: 'Plan step 4 still names Chroma while setting up test data.',
      evidence: [{ source: '02_plan.md step 4', asOf: 'read 14:15' }],
      options: [
        { id: 'drop', label: 'Drop it from the plan', consequence: 'Plan step 4 uses the in-memory store like the rest of the tests.', by: 'claude' },
        { id: 'keep', label: 'Keep Chroma for this step', consequence: 'Adds a test dependency the spec removed.', by: 'claude' },
      ],
      recommended: { option: 'drop', reason: 'The spec already removed Chroma; only the plan is stale.' },
      key: 'storage.vector',
      changed: 'Nothing about the decision; the plan text is stale. Shown to demonstrate the warning.',
    },
  ],
};

export const DEMO_PREVIOUS: Record<string, InterviewDecision> = {
  'storage.vector': { key: 'storage.vector', question: 'Keep Chroma?', answer: 'Remove Chroma', at: '2026-09-30T15:21:08Z', round: 'earlier' },
};

/** A canned stand-in for Claude's reply, so the demo shows the whole loop without a model. */
export function fixtureReply(card: InterviewCard, message: InterviewMessage): { text: string; reading?: InterviewReading } {
  if (message.kind === 'why') {
    return { text: `Fixture: ${card.why}${card.recommended ? ` Recommended because: ${card.recommended.reason}` : ''}` };
  }
  const said = message.text.toLowerCase().trim();
  const option = card.options.find(item => item.label.toLowerCase() === said)
    ?? card.options.find(item => item.label.toLowerCase().split(/\W+/).some(word => word.length >= 4 && said.includes(word)));
  if (option && !/\?\s*$/.test(message.text)) return { text: `Fixture: that sounds like "${option.label}".`, reading: { option: option.id } };
  if (/\?\s*$/.test(message.text)) return { text: 'Fixture: Claude would answer your question here. No model was called.' };
  return { text: 'Fixture: Claude would read this as your own answer.', reading: { text: message.text } };
}
