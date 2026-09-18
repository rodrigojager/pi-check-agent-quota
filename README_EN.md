# pi-check-agent-quota

Display AI provider quota and balance, plus consumption of recent dialogue rounds in the pi TUI.

English | [中文说明](./README.md)

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot-en.png)

## Supported Providers

| Provider | Display |
|---|---|
| MiniMax (`minimax`, `minimax-cn`) | 5h / 7d usage |
| Kimi API (`moonshotai`, `moonshotai-cn`) | Balance |
| Kimi For Coding (`kimi-coding`) | 5h / 7d usage |
| Z.AI / GLM (`zai`) | Balance |
| Z.AI Coding Plan (`zai-coding-cn`) | Usage |
| DeepSeek (`deepseek`) | Balance |
| OpenRouter (`openrouter`) | Balance |
| OpenCode Go (`opencode-go`) | 5h / 7d / mo usage |
| OpenAI Codex (`openai-codex`, ChatGPT Plus/Pro OAuth login) | 5h / weekly usage, plan badge |
| Codex Account Pool (`codex-account-pool`) | Active pool account, 5h / weekly usage, plan badge |

Other providers are not queried, widget shows `--`. `opencode-go` uses pi's existing `OPENCODE_API_KEY`. `openai-codex` reuses pi's `/login openai-codex` OAuth credential (access token, auto-refreshed by pi); a plain OpenAI API key cannot query ChatGPT subscription limits. `codex-account-pool` resolves quota through Pi's shared event bus and displays the account actually bound to the current session; no OAuth token crosses the bus. `kimi-coding` supports both pi's `/login kimi-coding` OAuth subscription and a plain `KIMI_API_KEY`.

## Installation

```bash
pi install https://github.com/rodrigojager/pi-check-agent-quota
```

This fork adds account-aware integration with `rodrigojager/pi-codex-account-pool`; all original provider fetchers remain available.

API keys reuse pi's existing provider authentication, no extra configuration required.

## Authentication commands (built into pi)

These commands belong to pi, not to this extension, but are required when using OAuth-backed quota providers:

```text
/login kimi-coding       # sign in to Kimi For Coding OAuth
/login openai-codex      # sign in to ChatGPT Plus/Pro Codex OAuth
```

- Complete the browser/device-code flow shown by pi;
- pi stores and refreshes the credential in its own credential store;
- after login, switch to the corresponding provider/model and this extension reads only the resolved access credential;
- the extension does not register `/login`, does not receive the login secret, and does not persist OAuth tokens.

## Display

### Color and Status

- **Quota colors**: low usage green, near-limit yellow, over-limit red; consumption delta purple.
- **Last round consumption**: balance `(¥-0.20)`, bucket `(-20%)`; increase shows `+`, no change shows no sign.
- **Status labels**:
  - Conversation in progress → `(using)`
  - Fetch failed → `(Failed)`
  - Cross-provider switch → `(changed)`
- **Balance alert**: number turns red when below threshold (default 10; change via `/aqset <red> <yellow> <balance>`, env `PI_QUOTA_BALANCE_ALERT` works as initial value).

### Estimated Remaining (ETA)

Shown on the right side of the status bar as `2m ago · Available: N rounds/2h15m`:

- **Consumption rate**: shortest available window by priority (`5h` → `used` → `7d` → `mo`). `5h`/`used` deltas are true per-round consumption; `7d`/`mo` are sliding windows, used only as fallback when no smaller window exists.
- **Bottleneck bucket**: rounds for each bucket = remaining / unified rate, take the first to exhaust. `7d`/`mo` that will reset first is not a constraint.
- **Hidden when**: insufficient samples, any bucket exhausted, or request failed.
- **Special displays**:
  - No consumption recently → `0 used in last N rounds` (supported for both balance and bucket types)
  - Over 365 rounds → `365+ rounds`
  - ≤5 rounds or ≤30 minutes remaining → number highlighted in red
- **Layout**: auto-wraps on narrow windows, recalculates on resize; time precise to minutes (`2h15m`), converted to days at ≥24h (`3d4h`).
- **Last refresh**: `2m ago ·` (zh: `2分前 ·`) before the ETA label when ETA is available; without ETA it is shown as `2m ago` (zh: `2分前`) = the displayed quota snapshot was fetched 2 minutes ago. Definition: `age = now − latest successful fetch of this provider` (fetches are triggered by session start, model switch, round settlement, `/checkaq`; on session resume it may come from the disk cache and honestly show e.g. `5h ago`). Recomputed every minute even when idle; age remains independent when ETA is unavailable (including exhausted/narrow windows or insufficient samples), and shows the latest successful snapshot age even after a fetch failure.
- **Auto refresh (opt-in)**: off by default. Enable via `/aqauto 5` (every 5 minutes), `/aqauto on` (default 5), disable via `/aqauto off`, view via `/aqauto`. With it on, idle pi fetches the quota on that interval (pure monitoring; no conversation needed). Manual `/checkaq` and round settlement still work as usual and postpone the next auto fetch. The setting is persisted like thresholds; the env var `PI_QUOTA_AUTO_REFRESH_MINUTES` works as an initial value.

## Commands

| Command | Usage | Description |
|---|---|---|
| `/checkaq` | `/checkaq` | Force refresh and show live quota for current provider |
| `/aq10` | `/aq10` | Show the latest 10 settled-round consumption summary |
| `/aqlang` | `/aqlang zh\|en` | Switch interface language (default zh) |
| `/aqset` | `/aqset [red yellow balance] \| reset` | View/set display thresholds |
| `/aqauto` | `/aqauto [minutes\|on\|off]` | View/toggle idle auto refresh |

### `/checkaq` — force refresh

Usage:

```text
/checkaq
```

- Takes no parameters (any extra text is ignored) and always requests the current provider's live quota instead of relying on the cache;
- Uses the current provider's configured API key or pi-managed OAuth credential;
- Updates the widget, `age`, and ETA when a successful snapshot is returned, but does not create a consumption record by itself;
- If a same-provider request is already in flight, the command waits for and reuses it; repeated `/checkaq` calls for the same provider within 1 second are throttled;
- With no active provider, pi shows a warning; unsupported or unconfigured providers remain `--`/unavailable.

### `/aq10` — recent consumption summary

Usage:

```text
/aq10
```

- Takes no parameters (any extra text is ignored) and does not trigger a network request;
- Shows the latest successful settled conversation rounds for the current provider, up to 10 records;
- Quota providers show percentage consumption by window; balance providers show currency consumption;
- Cross-provider or failed rounds are not counted as consumption; zero/positive balance changes are omitted from the summary;
- If there are no usable records, pi reports that no consumption records are available.

Examples:

```text
minimax-cn last 2 rounds 5h 23% / 7d 11%
opencode-go last 5 rounds 5h 15% / 7d 10% / mo 5%
openrouter last 5 rounds $0.69
```

### `/aqlang` — switch interface language

Usage:

```text
/aqlang zh
/aqlang en
```

- Accepts exactly `zh` or `en` (case-insensitive, surrounding spaces are ignored);
- Changes widget labels, status text, ETA text, notifications, and command descriptions immediately;
- Persists the language choice in the local cache and restores it on the next session;
- Any other value, missing value, or extra parameters is rejected with a usage hint.

### `/aqset` — display thresholds

One line, three numbers in fixed order: **red / yellow / balance alert**.

- 1st number: usage ≥ this % turns **red**
- 2nd number: usage ≥ this % turns **yellow**
- 3rd number: balance ≤ this value turns red (currency unit)

```text
/aqset               # view current thresholds (printed in the same format, edit and resend)
/aqset 80 40 10      # defaults: usage ≥80% red, ≥40% yellow, balance ≤10 red
/aqset 60 30 20      # more sensitive: earlier yellow/red, higher balance alert
/aqset reset         # back to defaults
```

Rules:

- Red must be greater than yellow, otherwise the command is rejected with the usage hint;
- Invalid input (wrong count, non-numeric, out of range) is rejected without saving;
- Settings take effect immediately and persist across sessions (stored in the local cache file);
- The legacy env vars `PI_QUOTA_PCT_YELLOW` / `PI_QUOTA_PCT_RED` / `PI_QUOTA_BALANCE_ALERT` still work as initial values.

### `/aqauto` — idle auto refresh

Off by default; when enabled, the quota is refetched on the given interval even with no conversation:

```text
/aqauto               # view current status (e.g. Auto refresh: every 5 minutes)
/aqauto 4             # enable, every 4 minutes
/aqauto 30            # maximum interval
/aqauto on            # enable with the current interval, or 5 minutes by default
/aqauto off           # disable (same as /aqauto 0)
```

Rules:

- Interval accepts integers only, in the range 0–30 minutes: `0` = off, `30` = hard cap; decimals and values above 30 are rejected;
- Takes effect immediately and persists across sessions (stored in the local cache file, same as `/aqset`);
- Debounced: repeating the same `/aqauto` command within 1 second is ignored; any fetch attempt (manual `/checkaq`, round settlement, session start) postpones the next auto fetch; in-flight requests are joined, never duplicated;
- `/aqset reset` also resets auto refresh back to the env initial value (or off);
- The env var `PI_QUOTA_AUTO_REFRESH_MINUTES` still works as the initial value (values above 30 are clamped to 30).

### `/aq10` examples

```text
minimax-cn last 2 rounds 5h 23% / 7d 11%
opencode-go last 5 rounds 5h 15% / 7d 10% / mo 5%
openrouter last 5 rounds $0.69
```

## Migrate Cache from Older Versions (For Existing Users)

Since v0.1.2, cache file has moved from `~/.pi/agent/pi-check-agent-quota.json` to `~/.pi/agent/pi-check-agent-quota/quota-cache.json`.

**No migration required** — the plugin will start fresh at the new location, only `/aq10` history will be cleared.

To keep history, move the file manually:

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

After confirming the new location is readable/writable, the old file can be removed (the `mv` above already does it).

## Privacy

- Only the corresponding provider's credential (API key or OAuth access token — the latter is managed and refreshed by pi) is sent to its quota endpoint; the token is never persisted or logged by this extension;
- No prompt, reply, file or conversation content is read or uploaded; no API key or full response is stored; no telemetry;
- Local cache is at `~/.pi/agent/pi-check-agent-quota/quota-cache.json`, readable/writable only by current user;
- Custom `baseUrl` allows only HTTPS (HTTP allowed for loopback), requests do not follow redirects;
- By default the extension only fetches on user-visible events (session start, model switch, round settlement, `/checkaq`). If you enable auto refresh via `/aqauto`, idle background fetches are sent on that interval while pi is open.

## License

MIT
