# Configuration

The config file is `~/.pi/agent/notify-kde.json` (override with `PI_NOTIFY_KDE_CONFIG`). It is
created on the first run. **It is re-read on every notification**, so edits take effect
immediately — no `/notify-kde` reload, no pi restart.

Keys added by a newer version are backfilled on startup; the previous file is copied to
`notify-kde.json.bak` first. `/notify-kde on|off` also backs up before writing.

Delete the file to restore every default.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. |
| `locale` | `en` \| `zh` | from `$LANG` | Language of the notification text and of `/notify-kde`. |
| `minDurationMs` | number | `30000` | Only notify when the run took at least this long. `0` = always. |
| `desktop` | bool | `true` | Send the desktop notification. |
| `desktopTimeoutMs` | number | `8000` | How long it stays, in ms. `0` = leave it to the notification server. |
| `urgency` | `low` \| `normal` \| `critical` | `normal` | Desktop urgency. `critical` ignores Do-Not-Disturb. |
| `icon` | string | `utilities-terminal` | Icon name. `""` = no icon. |
| `coalesce` | bool | `true` | Replace the previous pi notification instead of stacking. |
| `dismissOnReturn` | bool | `true` | Withdraw the notification as soon as you type again. |
| `kdeconnect` | bool | `true` | Push to the phone via `kdeconnect-cli`. |
| `kdeconnectDevices` | string[] | `[]` | Device id allow-list (`kdeconnect-cli -l --id-only`). `[]` = all paired, reachable devices. |
| `kdeconnectTimeoutMs` | number | `5000` | Timeout for one `kdeconnect-cli` call (min 500). |
| `kdeconnectRefreshWhenOffline` | bool | `true` | When no device is reachable, ask `kdeconnectd` to rescan and retry. |
| `kdeconnectRefreshTimeoutMs` | number | `8000` | Budget for that rescan-and-poll retry (min 500). |
| `annotatePhoneFailure` | bool | `true` | Add a "phone not reached" line instead of failing silently. |
| `notifyOnDone` | bool | `true` | Notify when a run finishes. |
| `notifyOnUiPrompt` | bool | `true` | Notify when pi opens a blocking prompt. |
| `uiPromptDelayMs` | number | `8000` | Only announce a prompt after it has waited this long. `0` = immediately. |
| `includeSnippet` | bool | `true` | Put a one-line summary of the last reply in the notification. |
| `snippetChars` | number | `140` | Maximum length of that summary (min 20). |
| `suppressWhenAborted` | bool | `true` | Do not notify for a run you aborted with Esc. |
| `titlePrefix` | string | `pi` | Title prefix; titles become `prefix · project · session`. |

Any key with the wrong type falls back to its default, and numbers outside their sensible range are
clamped, rather than failing — a typo in the config should not break notifications. This is covered
by `test/pure.test.ts`.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_NOTIFY_KDE_CONFIG` | Path to the config file. |
| `PI_NOTIFY_KDE_LOG` | Path to the log file (default `$XDG_CACHE_HOME/pi/notify-kde.log`). |
| `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` | Notifications need a session bus. If pi was started from a context that lacks it, the extension reconstructs it from `/run/user/<uid>`. |

## A note on snippets and privacy

With `includeSnippet: true`, the first line of the last assistant message is copied into the
desktop notification **and** sent to the phone through KDE Connect. If a reply is likely to contain
something you would not want on a lock screen, set `includeSnippet: false`.

The log never contains notification text: a failed command is logged by its stderr or its exit
code, never by `error.message` (which embeds the whole command line, including the message text).
