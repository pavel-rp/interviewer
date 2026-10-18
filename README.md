# Interviewer

One-card-at-a-time interviews for Claude Code. Claude sends every open decision in one `ask` call. You answer one card at a time in a pane docked beside the transcript. The answers go back together when you press Send. It is shaped by a usability study of how Claude Code interviewed one developer over a month: every card states why it is asked and what was checked, every option says what it changes and who does it, and a typed reply is never taken as an answer without your confirmation.

Cards are painted with UInlay's components, copied into `vendor/uinlay/`. Nothing in UInlay depends on this plugin.

## Try it

```sh
claude --plugin-dir /path/to/interviewer
```

`/interview demo` opens a fixture round. It never calls a model.

The card opens in a pane docked beside the transcript and shows the whole card, capped at 100 columns. When the surface won't place the pane, the card goes above the prompt instead. That happens for an unasked pane on a terminal narrower than about 144 columns. Above the prompt it takes a compact form: the focused option is shown whole, the others take one line, and context and preview become toggles. `f` (or the Full card button) opens the whole card in the pane.

The card is always drawn at its full height, and the host scrolls the pane or band over it. No plugin code runs per scroll step; the plugin only stretches a wheel tick to three rows. When the card overflows, the digit buttons sit above it so they stay armed.

| Where | Keys |
| --- | --- |
| Pane holding the keys, or an empty prompt under the band | `1`–`4` answer the current card |
| Card (click it first) | `1`–`4` choose, `←`/`→` cards, `w` why, `r` reply, `c` context, `p` preview, `Tab`/arrows + `Enter` |

The host keeps `?` for itself, so it never reaches the card; `w` asks why.

Other commands: `/interview pane|band`, `/interview cancel`, `/interview rules` (`rule <text>`, `unrule <n>`), `/interview decisions` (`forget <key>`), `/interview redirect on|off`.

## What Claude gets

| Tool | Does |
| --- | --- |
| `mcp__interviewer__ask` | Validates the cards and shows them. Returns `pending`, never an answer. |
| `mcp__interviewer__reply` | Answers your Why or reply on one card. Can propose a reading (`{option}` or `{text}`) that you confirm, or `revise` the card. |
| `mcp__interviewer__read` | The round, the decision log and your standing rules. |
| `mcp__interviewer__withdraw` | Drops the open round; nothing is sent. |

A card is refused without `why`, `evidence` (or `unverified` with the reason), and a `consequence` and `by` on every option. It is also refused for more than one question mark, or for an option that duplicates the built-in None / You decide / You do it. A `key` already in the decision log needs `changed` to be asked again. The log and the standing rules live in the plugin's own store and survive sessions; every continuation carries the rules.

What reaches Claude: one `interviewer.escalation` per Why or reply (that card only), then one `interviewer.answers` with the open cards listed, or `interviewer.cancelled`. Delivery is tracked per event: queued / sent / failed, or local for fixtures. A failed event is never replayed.

`redirect on` refuses `AskUserQuestion` and points Claude at `ask`. It is off by default because workflow skills call `AskUserQuestion` today.

## Develop

```text
src/card.ts      card schema and validation: the interview's rules
src/model.ts     the round state machine (client and host run the same one)
src/view.ts      the card layout, painted with vendor/uinlay
src/client.ts    the surface module: keys, mouse, acknowledged batches
src/fixtures.ts  the demo round and its canned replies
hooks/register.tsx  tools, band and pane, delivery, /interview
```

- `npm test`: Node behaviour tests (`tests/*.spec.ts`).
- `npm run test:host`: native host tests (`tests/*.test.ts`).
- `npm run validate`, then `npm run typecheck`. Typecheck reads `.claude-plugin/types/`, which the engine writes on launch.
- `python3 -I tools/live-demo.py`: the fixture demo in a real Claude Code terminal, with captures in `.runtime/live/`. It uses pyte and Pillow from `INTERVIEWER_PY_DEPS`, `.runtime/python` or `../uinlay/.runtime/python`. `INTERVIEWER_CWD` runs it from an already trusted folder.
- `npm run vendor -- ../uinlay`: re-copy the four UInlay files and record the commit in `vendor/uinlay/VENDORED.md`. Don't edit them here.
