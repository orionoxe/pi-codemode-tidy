# pi-codemode-tidy

Tidy transcript rendering for Pi's built-in `codemode` tool. **Display only** — tool results,
model-facing content, and keybindings keep working exactly as before.

## Why

`codemode` batches many tool calls into one script — and paints the screen with it: the full
script, raw JSON arguments for every nested call, and output that wraps as one unreadable blob.

## What you get

Before (Pi's built-in rendering):

```text
codemode
const r = await Promise.allSettled([
  tools.fffind({pattern:"business",limit:12}),
  tools.fffind({pattern:"",path:"contracts/source/**",limit:8}),
  tools.read({path:"docs/agents/workflow.md",offset:1,limit:80}),
]);
for (let i = 0; i < r.length; i++) text({ check: i, ...r[i] });

✓ fffind {"pattern":"business","limit":12} 4ms
✓ fffind {"pattern":"","path":"contracts/source/**","limit":8} 2ms
✓ read {"path":"docs/agents/workflow.md","offset":1,"limit":80} 5ms
==> text 1/2 <==
{"check":0,"status":"fulfilled","value":"alpha\nbeta\ngamma\n..."} ← one long wrapped line
... (147 more lines, ctrl+o to expand)
```

After (collapsed — the default):

```text
codemode  6 lines  Ctrl+O to expand

✓ fffind business · limit=12 4ms
✓ fffind contracts/source/** · limit=8 2ms
✓ read docs/agents/workflow.md · offset=1 · limit=80 5ms
==> text 1/2 <==
{
  "check": 0,
  "status": "fulfilled",
  "value": "alpha
beta
gamma"
... (3 more lines, Ctrl+O to expand)
```

Press **Ctrl+O** (your `app.tools.expand` binding) and the original rendering comes back, script
and raw output included.

## Details

- **Script** collapses to one line (`6 lines`); expand to read it.
- **Nested calls** become one summary row each — tool name, main argument, then limits and
  offsets — instead of raw argument JSON. Earlier calls fold away past 8 rows.
- **Output** previews 6 wrapped lines. Compact JSON is split at escaped `\n` and `\t`, so long
  payloads read as text instead of one wrapping blob; literal backslashes survive untouched.
- **Errors stay on top**: `Script error:` and failing call rows render above the preview, never
  behind it. Long output keeps its `Full output: /tmp/...` path.
- **Display only**: the tool result the model sees is never rewritten, and the expanded view is
  Pi's own renderer, not a reimplementation.

## Install

```sh
pi install npm:pi-codemode-tidy
```

or straight from git:

```sh
pi install git:github.com/orionoxe/pi-codemode-tidy
```

Then `/reload`.

## Requirements

Pi with the `registerToolRenderer` extension API (Pi 0.84+). Developed and tested against Pi 1.1.0.

## Development

```sh
npm install
npm test          # renders real fixtures through Pi's own codemode renderer
npm run typecheck
```

## License

MIT
