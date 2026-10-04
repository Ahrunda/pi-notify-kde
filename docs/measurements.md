# Measurements

Everything here was measured on the author's machine (Arch Linux, KDE Plasma, Wayland,
`kdeconnect-cli` 26.08.1, `notify-send` / libnotify, Xiaomi 14 on the same LAN). Numbers are raw,
and each section says what the measurement does and does not show.

The point of writing them down: two of the original implementation's behaviours were *plausible*
and wrong, and only measuring showed it.

---

## 1. `kdeconnect-cli --refresh` is asynchronous, so listing once after it is useless

This is the reason the retry loop in `refreshAndRetry()` polls instead of listing once.

### What it does not do

```console
$ time kdeconnect-cli --refresh
real    0m0.004s
```

Four milliseconds. A LAN scan cannot complete in 4 ms. `--refresh` only *asks* `kdeconnectd` to
rescan and re-establish connections; it returns immediately and the scan continues in the daemon.
(`--help` describes it as "Search for devices in the network and re-establish connections", which
reads like a blocking operation. It is not.)

### The consequence, measured end to end

Device currently unreachable; then `--refresh`; then poll `kdeconnect-cli -a --id-only`:

```
14:55:28.458  kdeconnect-cli -a --id-only   -> 0 devices found
14:55:28      kdeconnect-cli --refresh      -> returns in 4 ms
14:55:31      kdeconnect-cli -a --id-only   -> 3a0361c7334b4652817d275220cfa747   ← 3 s later
14:55:34      ... and reachable from then on
```

So: the device appears **about 3 seconds after** the refresh returns. The original code ran

```ts
await runCmd("kdeconnect-cli", ["--refresh"], timeout);   // 4 ms
const retried = await listReachable(cfg);                 // ~6 ms later: still the old cache
if (retried.length > 0) { /* never reached */ }
```

and gave up. The push was lost silently, and the retry's outcome was not even logged in the
"still nothing" case.

### Why polling and not just a longer sleep

The device did not appear at a fixed offset. Running the same sequence repeatedly produced
"visible after 0.35 s" and "not visible within 90 s" for *identical* inputs, so no constant delay
is correct. `pollDelays()` therefore polls with a growing interval (250 ms → capped at 1 s) until a
budget (`kdeconnectRefreshTimeoutMs`, default 8 s) runs out. A bounded budget also means a wedged
`kdeconnectd` cannot hang the handler.

### What this does *not* show

It does not show that `--refresh` is enough on its own. In the author's logs most "phone not
reached" events recovered after **3–67 minutes**, and one after ~24 hours. Those are not cache
staleness; they are the phone itself being unreachable (see §4). No PC-side retry can fix those,
and the code does not pretend to.

---

## 2. `notify-send` misparses a title or body that starts with `-`

```console
$ notify-send -a pi '-wait a moment' 'body'
Error parsing option -i
$ echo $?
1

$ notify-send -a pi -- '-wait a moment' 'body'
$ echo $?
0
```

Without `--`, `notify-send` parses the *message* as its own options: `-wait …` is read as `-w`,
`-a`, `-i`, `-t`. The notification is never sent. Passing arguments as an array through
`execFile` does not help, because it is `notify-send` that does the parsing.

A project directory named `-foo`, or a reply whose snippet starts with `-`, is enough to hit this.

Fix: `buildNotifyArgs()` always emits `--` before the title and body. Regression-tested
(`buildNotifyArgs: a title starting with '-' is not eaten by notify-send`).

---

## 3. What the notification server actually supports

```console
$ gdbus call --session --dest org.freedesktop.Notifications \
    --object-path /org/freedesktop/Notifications \
    --method org.freedesktop.Notifications.GetCapabilities
(['body', 'body-hyperlinks', 'body-markup', 'body-images', 'icon-static', 'actions',
  'persistence', 'inline-reply', 'sound', 'x-kde-urls', 'x-kde-origin-name',
  'x-kde-display-appname', 'inhibitions'],)
```

Used by this extension:

- `notify-send -p` prints the notification id, and `-r <id>` replaces an existing notification
  — so successive pi notifications coalesce instead of stacking (`coalesce`).
- `CloseNotification` works, so the alert can be **withdrawn the moment the user types again**
  (`dismissOnReturn`):

  ```console
  $ id=$(notify-send -p -a pi 'close test' 'body'); echo $id
  66
  $ gdbus call --session --dest org.freedesktop.Notifications \
      --object-path /org/freedesktop/Notifications \
      --method org.freedesktop.Notifications.CloseNotification 66
  ()
  ```

`actions` is present, so a clickable "focus the terminal" button is possible in principle, but
focusing the right terminal on Wayland is not something this extension can do portably. Not
implemented.

---

## 4. Reading the failure log correctly

The log (`~/.cache/pi/notify-kde.log`) over ~500 deliveries contained 24 "phone not reached"
events. Time from each failure to the next successful delivery:

```
31, 45, 42, 34, 29, 18, 17, 6, 3, 3, 5, 67, 49, 42, 41, 31, 13, 5,  1440, 1429, 1410, 25, 11, 6   (minutes)
```

**What this shows:** these failures are long-lived (minutes to hours). That is consistent with the
phone being genuinely off the network — on this phone (Xiaomi/HyperOS) aggressive background
battery management kills KDE Connect while the screen is locked, so the device disappears from
`kdeconnect-cli -a` until it wakes.

**What this does not show, and an earlier draft of this file got wrong:** the absence of
"recovered after refresh" lines in the log is *not* evidence that the refresh retry never ran or
never worked. When the phone is actually gone, the refresh cannot find it either, so those lines
would be absent regardless. The retry bug was established by §1 (timing), not by this log.

Practical consequence: enabling "unrestricted"/"no battery optimisation" for KDE Connect on the
phone is the fix for this class of failure. See `troubleshooting.md`.

---

## 5. Reproducing the measurements

```sh
# 1. refresh is fire-and-forget
time kdeconnect-cli --refresh

# 2. device appears seconds later, not immediately
kdeconnect-cli -a --id-only          # record
kdeconnect-cli --refresh
kdeconnect-cli -a --id-only          # still the old answer
sleep 3
kdeconnect-cli -a --id-only          # now it appears

# 3. the notify-send parsing bug
notify-send -a pi '-wait a moment' 'body'      # exit 1
notify-send -a pi -- '-wait a moment' 'body'   # exit 0

# 4. ids, replace and close
id=$(notify-send -p -a pi 'A' 'first'); notify-send -r "$id" -a pi 'B' 'replaced'
gdbus call --session --dest org.freedesktop.Notifications \
  --object-path /org/freedesktop/Notifications \
  --method org.freedesktop.Notifications.CloseNotification "$id"
```

To force the daemon to forget its devices (so the "appears a few seconds later" effect is
visible), restart it:

```sh
systemctl --user restart app-org.kde.kdeconnect.daemon@autostart.service
```

Note: calling `--refresh` in the first ~200 ms after that restart can wedge discovery for a long
time (observed: >90 s, twice; but the same sequence also succeeded at 0.35 s once, so it is a
race). It is not something this extension does — it only refreshes when a real notification finds
no device — but it is why the retry budget is bounded.
