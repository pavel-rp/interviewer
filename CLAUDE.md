# Interviewer development

A Claude Code function-hook plugin. Launch with `claude --plugin-dir .`; nothing is installed or published.

- The interview's rules live in `src/card.ts` (what a card must carry) and `src/model.ts` (one pure state machine shared by the client and the host). `hooks/register.tsx` only adapts them to the host.
- `vendor/uinlay/` is a copy of UInlay's paint library. Never edit it here; change UInlay and run `pnpm run vendor`. Never import from `../uinlay`, since the host refuses imports outside this folder.
- Runtime modules use no DOM, Node globals or packages. Read the installed host's generated types before using an API.
- Fixtures never call a model. Live checks use host continuation on the subscription, never an API key.
- Pending, answered, cancelled, withdrawn and delivery are distinct facts. A typed reply becomes an answer only when the operator confirms a reading.
- `pnpm test`, `pnpm run test:host`, `pnpm run validate`, `pnpm run typecheck`; `tools/live-demo.py` for the real terminal.
- Package manager: pnpm only (pnpm 12, owner decision 2026-11-02). Never npm/npx/yarn; never commit package-lock.json.
