# Pi Omniagent extensions

## Pi Agent Extensions — How Each One Works

### The common idea (read this first)

All four files do the same job: they let Pi (the host coding agent) drive another coding agent's CLI as if it were just another model in Pi's `/model` picker. It uses ACP (https://agentclientprotocol.com/) to communicate with any coding agent. You pick "Cursor Sonnet" or "GPT-5 [codex-app-server]" or "Opus [claude-code-acp]" in Pi, and your turn is secretly executed by that external agent running in your workspace.

They all follow this shape:

```
┌────────────────────────────────────────────────────────────────────┐
│ Pi host process                                                    │
│                                                                    │
│   /model picker ──► pi.registerProvider(...)                       │
│        │                                                           │
│        │ streamSimple(model, context)                              │
│        ▼                                                           │
│   ┌─────────────┐   builds prompt    ┌──────────────────────┐      │
│   │  Provider   │ ─────────────────► │   Bridge (singleton) │      │
│   │  stream fn  │ ◄───────────────── │  serializes turns,   │      │
│   └─────────────┘   stream events    │  owns 1 session      │      │
│        ▲                             └──────────┬───────────┘      │
│        │ AssistantMessageEventStream            │ spawn            │
│        │ (text/thinking deltas)                 ▼                  │
└────────┼────────────────────────────────────────┼──────────────────┘
         │                                        │
         │                                        ▼
         │                              ┌───────────┬──────────┐
         └──── JSON-RPC over stdio ───► │ Child process (CLI)  │
                                        │ cursor-agent / rovo  │
                                        │ codex / claude-acp   │
                                        └──────────────────────┘
```

The bundled extensions:

- `cursor-acp.ts` — Cursor Agent over ACP
- `codex-app-server.ts` — OpenAI Codex over app-server
- `claude-code-acp.ts` — Claude Code over ACP (uses the official ACP SDK)
- `rovo-acp.ts` — Atlassian Rovo Dev over ACP

## Installing into `~/.pi/agent/extensions`

Pi auto-discovers `*.ts` files in `~/.pi/agent/extensions`, but external npm dependencies are not bundled into those files.

1. Clone this repo:

   ```bash
   git clone https://github.com/sathish316/pi-omniagent-extensions.git
   cd pi-omniagent-extensions
   ```

2. Copy the extension files into your Pi extensions directory:

   ```bash
   mkdir -p ~/.pi/agent/extensions
   cp cursor-acp.ts rovo-acp.ts codex-app-server.ts claude-code-acp.ts \
      acp-config.sample.json package.json ~/.pi/agent/extensions/
   cp -R acp-lib ~/.pi/agent/extensions/
   ```

   `acp-lib/` holds the shared provider gate the four extensions import, so it
   has to come along. It sits in a subdirectory without an `index.ts` on
   purpose — Pi only auto-loads `extensions/*.ts` and `extensions/<dir>/index.ts`,
   so it is never mistaken for an extension of its own.

3. Install the extension dependencies:

   ```bash
   cd ~/.pi/agent/extensions
   npm install
   npm run check:claude-code-acp-deps
   ```

4. Make sure the underlying agent CLIs are installed and on your `PATH` for the
   extensions you want to use: `cursor-agent` (cursor-acp), `rovo` (rovo-acp),
   `codex` (codex-app-server). `claude-code-acp` pulls its runtime from npm.

5. Restart Pi. The bridged models appear in the `/model` picker tagged with
   their provider, e.g. `[codex-app-server]` or `[claude-code-acp]`.

The `claude-code-acp.ts` extension needs:

- `@agentclientprotocol/sdk`
- `@agentclientprotocol/claude-agent-acp`

The Pi API packages imported by the extensions are provided by the running Pi installation.

## Choosing which ACP providers load

Each extension discovers its models by spawning the underlying agent CLI at
startup, and that is where Pi's startup time goes. On this machine, loading all
four costs about **13.9s**; loading none costs about **1.0s**. `acp-config.json`
decides which ones pay that cost.

### The config file

Copy the sample once — the real file is gitignored, so it stays local to your
machine:

```bash
cd ~/.pi/agent/extensions
cp acp-config.sample.json acp-config.json
```

It lives next to the extension `.ts` files (`~/.pi/agent/extensions/acp-config.json`)
and is found regardless of Pi's working directory. Set `PI_ACP_CONFIG=/path/to/file.json`
to read it from somewhere else. Line and block comments are allowed.

| Key | Effect |
| --- | --- |
| `enable_acp_models` | Master switch. `false` disables every ACP provider. |
| `enable_all_acp_models` | `true` enables cursor + codex + claude + rovo, ignoring the per-provider keys. |
| `enable_cursor_acp_models` | `true` enables only the Cursor ACP models. |
| `enable_codex_acp_models` | `true` enables only the Codex app-server models. |
| `enable_claude_acp_models` | `true` enables only the Claude Code ACP models. |
| `enable_rovo_acp_models` | `true` enables only the Rovo Dev ACP models. |

Precedence, highest first:

1. `ENABLE_<PROVIDER>_ACP` environment variable (see below).
2. `enable_acp_models: false` — nothing loads.
3. `enable_all_acp_models: true` — everything loads.
4. The matching `enable_<provider>_acp_models` key.
5. Nothing set: if **none** of the four per-provider keys are present, all four
   load (the behaviour from before this config existed). As soon as **at least
   one** is present, the ones you left out stay off.

So the "only Cursor" setup is a single key:

```json
{ "enable_cursor_acp_models": true }
```

A missing or unparseable `acp-config.json` falls back to loading everything, so
a typo never silently costs you your models.

### Environment overrides

One variable per provider, checked before anything in the file:

| Variable | Provider |
| --- | --- |
| `ENABLE_CURSOR_ACP` | `cursor-acp` |
| `ENABLE_CODEX_ACP` | `codex-app-server` |
| `ENABLE_CLAUDE_ACP` | `claude-code-acp` |
| `ENABLE_ROVO_ACP` | `rovo-acp` |

Any value other than `0` or `false` force-enables that provider **even when the
config file disabled it**. `0` or `false` force-disables it. Unset or empty means
"defer to the config file".

This is the fast setup: turn everything off by default, then opt in per shell.

```bash
# ~/.pi/agent/extensions/acp-config.json
{ "enable_acp_models": false }
```

```bash
pi                        # ~1s, no ACP models
ENABLE_CODEX_ACP=1 pi     # Codex models only
ENABLE_CURSOR_ACP=1 ENABLE_CLAUDE_ACP=1 pi   # Cursor + Claude
```

### What Pi shows at startup

```
ACP model providers loaded: cursor-acp (32 models, 9.07s), codex-app-server (29 models, 1.59s)
ACP model providers skipped: claude-code-acp (enable_claude_acp_models not set), rovo-acp (enable_rovo_acp_models not set)
Time taken for loading ACP models: 10.66s
```

Skipped providers list the rule that turned them off, so it is always clear
whether a model is missing because of the config file, an env toggle, or a CLI
that failed to start.

Run `/acp-config` inside Pi for the full picture — resolved config path, every
key's value, per-provider load time, and the current env toggles.
