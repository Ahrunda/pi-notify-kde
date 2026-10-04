# Troubleshooting

Start here:

```
/notify-kde            # effective config, whether DBus is available, last phone delivery result
/notify-kde test       # send one right now and report what happened
tail -n 40 ~/.cache/pi/notify-kde.log
```

## Nothing appears at all

1. **Are you in an interactive session?** The extension stays silent in `pi -p`, `--mode json` and
   subagent child processes — there is no UI there, so an alert would be meaningless.
2. **Was the run shorter than `minDurationMs`?** Default 30 s. A quick question never notifies.
3. **Did you abort it with Esc?** `suppressWhenAborted` (default on) treats that as "the user is
   right here".
4. **Is there a session bus?** `/notify-kde` says `no session DBus` if not. The extension rebuilds
   `DBUS_SESSION_BUS_ADDRESS` from `/run/user/<uid>/bus`, but that only works if the file exists.
5. **Is `notify-send` installed?** It ships with libnotify (`libnotify` / `libnotify-bin`).
6. **Is the config valid JSON?** `/notify-kde` reports a parse error and falls back to defaults.

## The desktop notification appears but never goes away

`desktopTimeoutMs: 0` means "do not expire" in the Desktop Notifications specification, and some
notification servers treat it as "no opinion". Set a positive value (the default is `8000`, i.e.
8 s), or just rely on `dismissOnReturn`, which withdraws the notification as soon as you type.

## "Phone not reached"

The phone push is `kdeconnect-cli --ping-msg`: KDE Connect has no API for pushing an arbitrary
notification, so the equivalent is a ping (a notification plus a vibration). It requires the phone
to be **reachable at that moment**. Check the basics first:

```sh
kdeconnect-cli --list-devices          # paired? reachable?
kdeconnect-cli -a --id-only            # the list this extension actually uses
kdeconnect-cli --ping-msg hello -d <id>  # try it by hand
```

If the device is paired but not reachable, and returns within a few seconds of a manual
`kdeconnect-cli --refresh`, that is exactly the case the built-in retry handles — see
`measurements.md`. It polls for `kdeconnectRefreshTimeoutMs` and then reports the result instead of
failing silently.

### The common real cause: the phone sleeps and KDE Connect gets killed

On phones with aggressive background battery management (Xiaomi/HyperOS exhibits this, and several
other Android skins do too), **locking the screen kills KDE Connect**. The device then disappears
from `kdeconnect-cli -a` entirely, and no amount of refreshing on the PC side will bring it back;
it returns only when the phone wakes up. In the author's logs this lasted anywhere from 3 to 67
minutes, once about 24 hours.

Fix it on the phone, not on the PC:

- Android settings → Apps → KDE Connect → Battery → **Unrestricted** / "Don't optimise";
- and allow KDE Connect to **autostart** / run in the background.

See `measurements.md` §4 for the failure-duration data.

## A notification with the right content fails to send, and the log says "Error parsing option"

That was a real bug, fixed by putting `--` before the title and body: without it `notify-send`
parses a message that starts with `-` as its own options. If you see it in the log on your build,
your copy of `buildNotifyArgs()` is missing the `--`. See `measurements.md` §2.

## Only one pi notification is ever visible

That is `coalesce: true` (the default): a new notification replaces the previous pi one instead of
stacking. Set it to `false` if you would rather see the whole history pile up.

## Notifications vanish before I look at them

`dismissOnReturn: true` (default) withdraws the notification as soon as you type again. Set it to
`false` to keep them on screen until they expire or you dismiss them.
