# pi-notify-kde

Get told when pi needs you: a **KDE desktop notification**, plus a push to your **phone over KDE
Connect**.

Pi has no desktop notification of its own. So when you start a long run, walk away, and come back
ten minutes later, you find out that pi finished in four seconds — or that it has been sitting on a
question since then.

> 中文文档: [README.zh.md](README.zh.md)

This extension watches the two moments where the ball is genuinely in your court:

- **the run settled** — after retries, auto-compaction and queued follow-ups are all done;
- **a blocking prompt opened** — a quiz, a confirm dialog, a selection, and pi is waiting on you.

## What it looks like

```
pi · pi-notify-kde · auth-refactor
✅ Done · 4m 12s
Rewrote the token refresh path and added tests for the expiry edge case.

pi · steward · nightly-audit
⏳ pi is waiting for you · confirm: apply 3 package upgrades?
```

On the phone, the same thing arrives as a KDE Connect ping (a notification plus a vibration).

## Quiet by default

Nobody wants a phone buzz for "what's the time complexity of this?":

- non-interactive runs (`pi -p`, `--mode json`, subagent child processes) never notify;
- a run shorter than `minDurationMs` (default **30 s**) never notifies;
- a run you aborted with Esc is not announced — you are obviously at the keyboard;
- a prompt is announced only after it has been waiting `uiPromptDelayMs` (default **8 s**);
- the notification is **withdrawn the moment you type again**, so nothing lingers once you are back.

## Requirements

| | |
|---|---|
| Shell out to | `notify-send` (libnotify) for the desktop notification |
| Shell out to | `kdeconnect-cli` for the phone push — only if `kdeconnect: true` |
| Session | a desktop session with a DBus session bus |
| pi | any version exposing `agent_settled` / `ui_prompt_start` / `input` |

The desktop part is any Linux desktop with libnotify; the phone part needs KDE Connect on the phone.
If `kdeconnect-cli` is absent the push is skipped (check the log); set `"kdeconnect": false` to stop
trying.

## Install

As a pi package:

```sh
pi install git:github.com/Ahrunda/pi-notify-kde
```

Or drop the single file in place:

```sh
git clone https://github.com/Ahrunda/pi-notify-kde
cd pi-notify-kde && ./install.sh
```

`install.sh` copies `extensions/notify-kde.ts` to `~/.pi/agent/extensions/notify-kde.ts`, backing up
any previous file to `.bak`. Undo with `rm ~/.pi/agent/extensions/notify-kde.ts`.

> **Pick one, not both.** `install.sh` installs a *personal extension file*; `pi install` registers a
> *package*. Pi loads both, so doing both runs the extension twice and you get every notification
> twice. Undo the package one with `pi remove git:github.com/Ahrunda/pi-notify-kde`.

Then, inside pi:

```
/notify-kde test
```

## Configuration

`~/.pi/agent/notify-kde.json` is created on first run, re-read on every notification, and backfilled
(backing up to `.bak`) when a newer version adds keys.

```json
{
  "locale": "en",
  "minDurationMs": 30000,
  "urgency": "normal",
  "coalesce": true,
  "dismissOnReturn": true,
  "kdeconnect": true,
  "kdeconnectDevices": [],
  "includeSnippet": true
}
```

Every key is documented in **[docs/configuration.md](docs/configuration.md)**.

## Commands

| Command | Effect |
|---|---|
| `/notify-kde` | Effective config, whether a session bus was found, the last phone delivery result |
| `/notify-kde test` | Send a test notification right now |
| `/notify-kde on` / `off` | Flip the master switch (writes the config, backing up first) |

## How the phone push works, and when it does not

KDE Connect has no "push an arbitrary notification" API; the equivalent is
`kdeconnect-cli --ping-msg`, which makes the phone show a notification and vibrate. It needs the
phone reachable right now.

When nothing is reachable, the extension asks `kdeconnectd` to rescan and **polls** for a few
seconds, then reports what happened in the desktop notification instead of failing silently. The
polling is deliberate: `--refresh` returns in ~4 ms and the device shows up seconds later, so a
single list right after the refresh reads a stale cache and always finds nothing. This and the
other measured behaviours are written up in **[docs/measurements.md](docs/measurements.md)**.

The most common genuine failure is not a cache problem at all: on phones with aggressive background
battery management (Xiaomi/HyperOS, and others), **locking the screen kills KDE Connect**, and the
phone is simply off the network until it wakes. That has to be fixed on the phone — see
**[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Limitations

- Linux/KDE only. It shells out to `notify-send` and `kdeconnect-cli`; the logic is not tied to KDE,
  but no other backend is implemented (a macOS/Windows backend would be a welcome pull request).
- No click-to-focus. The notification server advertises `actions`, but focusing the right terminal
  window portably on Wayland is out of scope.
- With `includeSnippet: true`, the first line of the last reply is copied into the notification and
  sent to the phone. Turn it off if that could put something sensitive on a lock screen.

## Development

```sh
npm install
npm test          # node --test, pure helpers only
npm run typecheck # tsc --noEmit against the real pi types
```

The tests in `test/pure.test.ts` import the extension module directly (its only pi import is
type-only) and assert, for each fixed bug, a discriminating case that fails if the bug returns.

## License

MIT — see [LICENSE](LICENSE).
