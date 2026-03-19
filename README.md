# pi-phone

A phone-first remote UI for [Pi](https://pi.dev) that lets you drive a real Pi session from your phone.

> **Changes from upstream (`@malinamnam/pi-phone`):**
>
> - Replaced Tailscale Serve with Cloudflare quick tunnels (`cloudflared tunnel --url`) — no account or config needed
> - ANSI color codes from extensions now render as actual colors in the phone UI
> - Shows a loading message while the tunnel is starting

`pi-phone` starts a small local web server, launches a dedicated `pi --mode rpc` subprocess in your current project, and mirrors Pi's session state over WebSocket to a mobile web app.

## What it gives you

- Phone-friendly chat UI for Pi
- Uses a real Pi subprocess, not a fake wrapper
- Preserves much more of your Pi setup than a custom mini-backend would
- Works with extension commands, prompt templates, and skills exposed by Pi RPC
- Model switching and thinking-level switching from the phone UI
- Session browser, tree browser, fork flow, stats, compact, reload, and refresh actions
- Image upload from the phone UI
- Cloudflare tunnel for remote access from your phone (no account required)
- Single active-client mode for safety and simplicity

## Screenshot

![pi-phone mobile UI screenshot](https://raw.githubusercontent.com/MaliNamNam/pi-phone/master/docs/images/pi-phone-screenshot.png)

## Requirements

- Pi installed and working
- Tested with Pi `0.58.4`
- Node.js available for extension dependencies
- Optional but recommended: `cloudflared` installed if you want easy remote phone access (`brew install cloudflared`)

## Install

Install `pi-phone` from npm with Pi:

```bash
pi install npm:@malinamnam/pi-phone
```

Then either restart Pi or run:

```text
/reload
```

If you want to verify that the package is installed and enabled:

```bash
pi list
pi config
```

## Setup guide

### 1. Open Pi in the project you want to control from your phone

```bash
cd /path/to/project
pi
```

`pi-phone` launches a dedicated child Pi RPC session using the current Pi working directory, so start Pi in the repo you want to work on.

### 2. Start the phone server

Inside Pi:

```text
/phone-start
```

By default this:

- binds the web server to `127.0.0.1`
- uses port `8787`
- uses the current Pi working directory
- sets a `2 hour` idle auto-stop timeout
- auto-generates a token if you did not provide one
- starts a Cloudflare tunnel automatically if `cloudflared` is installed

### 3. Open the phone UI

Pi will show a Cloudflare tunnel URL like:

```text
https://random-words.trycloudflare.com
```

Open that URL on your phone. If `cloudflared` is not installed, the server still runs locally on `127.0.0.1:8787`.

### 4. Enter the token if prompted

If you did not explicitly disable the token, the extension requires the token shown by Pi.

You can view it again at any time with:

```text
/phone-token
```

## Command reference

### `/phone-start`

Examples:

```text
/phone-start
/phone-start 8787
/phone-start 8787 mytoken
/phone-start --port 8787 --token mytoken --host 127.0.0.1
/phone-start --cwd /path/to/project
/phone-start --idle-mins 20
/phone-start --idle-secs 90
```

Behavior:

- default host: `127.0.0.1`
- default port: `8787`
- default cwd: current Pi working directory
- default idle auto-stop: `2 hours`
- auto-generates a random token if you do not provide one
- starts a Cloudflare tunnel if `cloudflared` is available

Use `-` to explicitly disable the token:

```text
/phone-start 8787 -
```

### `/phone-stop`

```text
/phone-stop
```

Stops the phone server and Cloudflare tunnel.

### `/phone-status`

```text
/phone-status
```

Shows whether the phone server and Cloudflare tunnel are running.

### `/phone-token`

```text
/phone-token
```

Shows the current token, or tells you that token auth is disabled for the current phone server.

## Typical usage flow

1. Start Pi in your project
2. Run `/phone-start`
3. Open the Cloudflare tunnel URL on your phone
4. Enter the token once if prompted
5. Work from the phone UI
6. When done, run `/phone-stop`

## What the phone UI can do

The phone UI is built around Pi RPC plus a few local convenience actions. Depending on your current Pi setup, you can:

- send prompts
- attach images
- abort streaming
- compact the current session
- start a new session
- reload extensions, skills, prompts, and themes
- browse and switch models
- browse and switch thinking levels
- browse prompt templates, skills, and extension commands exposed through Pi RPC
- browse saved sessions
- browse the current session tree and open a branch path as a new active session
- view session stats and cost stats

Because the extension drives a real Pi subprocess, the phone UI preserves much more of your actual Pi environment than a custom standalone web app would.

## Security and runtime behavior

- The phone server binds to localhost by default.
- If you omit the token, Pi generates a random token for you.
- If you set the token to `-`, token auth is disabled.
- Only one active phone client is allowed at a time; a new client replaces the old one.
- The phone server auto-stops after the configured idle timeout.
- The Cloudflare tunnel process is killed on idle timeout, `/phone-stop`, and parent Pi shutdown.
- The spawned child Pi process sets `PI_PHONE_CHILD=1` so the extension does not recursively start nested phone servers.
- The phone browser stores the token in local storage for convenience.

## Notes on quota display

The UI includes a quota pill for supported `openai-codex` `gpt-*` models when local Pi auth data makes that information available. If that auth is missing, unsupported, or you are using a different provider, the phone UI still works; the quota pill simply stays hidden.

## Troubleshooting

### Port already in use

If Pi reports that the port is already in use:

```text
/phone-stop
/phone-start
```

### Cloudflare tunnel did not start

Make sure `cloudflared` is installed and on `PATH`:

```bash
cloudflared --version
```

If not installed: `brew install cloudflared` (macOS) or see [cloudflared docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

### Invalid token on phone

If the phone UI says the token is invalid, run:

```text
/phone-token
```

Then re-enter the latest token. If needed, restart the server with a fresh token:

```text
/phone-stop
/phone-start
```

### Extension not showing up in Pi

Try:

```text
/reload
```

Then verify the package is present and enabled:

```bash
pi list
pi config
```

## Repository contents

- `index.ts` — tiny package entry that registers the extension
- `phone-session-pool.ts` — tiny compatibility export for the session pool API
- `src/extension/` — backend modules for extension registration, server runtime, args, paths, quota, runtime control, sessions, static assets, cloudflare tunnel, and theme mapping
- `src/session-pool/` — focused session worker and session pool internals
- `public/` — mobile web app assets
- `public/app/` — focused frontend modules for state, UI, rendering, transport, commands, autocomplete, sheets, bindings, and attachments

## Package name

`pi-phone` is published on npm as:

```text
@malinamnam/pi-phone
```
