# AGENTS.md — pi-notify-kde

Project facts, hard constraints and measured gotchas. Read this before changing anything here.

## What this is

A single-file pi extension, distributed three ways: as a pi package (`extensions/` is discovered
conventionally, see `package.json` `pi.extensions`), as `./install.sh` (copies the one file to
`~/.pi/agent/extensions/notify-kde.ts`), and as a manual copy.

## Hard constraints

1. **`extensions/notify-kde.ts` must stay a single, self-contained file.** `install.sh` copies
   exactly that one file into the user's extensions directory. A relative import would break the
   install (and the tests, which import the file directly).
2. **The only import from `@earendil-works/pi-coding-agent` must be `import type`.** It is a
   `peerDependency` supplied by the host; and `test/pure.test.ts` imports the extension with Node's
   type stripping, which only erases type-only imports. A value import would make the test try to
   resolve the package.
3. **Keep `--` in `buildNotifyArgs()`.** Without it `notify-send` parses a title or body starting
   with `-` as its own options and the notification silently fails (measured; `docs/measurements.md`
   §2). There is a regression test — do not delete it.
4. **Never log `error.message` from a spawned command.** It embeds the full command line, which for
   a phone ping contains the notification text (and therefore a snippet of the user's reply). Log
   stderr, or the exit code.
5. **Poll, do not sleep once, after `kdeconnect-cli --refresh`.** `--refresh` returns in ~4 ms and
   the device appears seconds later, so a single list right after it reads a stale cache. See
   `docs/measurements.md` §1.
6. **Do not let the config machinery touch the real config path from a test.** `ensureConfigFile()`
   writes, and `persistEnabled()` writes, to `~/.pi/agent/notify-kde.json` (or
   `PI_NOTIFY_KDE_CONFIG`). Tests must only exercise the pure functions.

## Measured facts you should not re-derive

Full data with raw numbers and what each measurement does *not* show: `docs/measurements.md`.

- `kdeconnect-cli --refresh` → ~4 ms; the device appears ~3 s later. It is fire-and-forget.
- Refreshing in the first ~200 ms after a `kdeconnectd` restart can wedge discovery (>90 s in two
  runs, but it also succeeded once at 0.35 s — it is a race, not a rule).
- `notify-send '-x' body` → `Error parsing option`, exit 1; with `--` → exit 0.
- Notification capabilities here include `body`, `icon-static`, `actions`, `persistence`,
  `inline-reply` — and **not** `action-icons`.
- `notify-send -p` prints the id; `-r <id>` replaces; `gdbus … CloseNotification <id>` works.
- The KDE Connect phone push is `--ping-msg`; there is no arbitrary-notification API.
- Most real "phone not reached" failures are the phone being off the network (Android battery
  management kills KDE Connect when locked), lasting 3–67 minutes. No PC-side retry fixes those.
- **The absence of "recovered after refresh" lines in the log is NOT evidence that the retry never
  ran.** When the phone is genuinely gone, the refresh cannot find it either. An earlier version of
  this project's reasoning got that wrong; the retry bug was established by timing, not by the log.

## Testing

```sh
npm test          # node --test test/
npm run typecheck # tsc --noEmit, against the real pi 1.0.2 types
```

`node_modules/` is gitignored; `npm install` is needed once.

Discipline: every fixed bug keeps a **discriminating** assertion — one that would pass only if the
behaviour is correct, and that fails if the bug returns. A test that cannot go red is not a test.
The style used throughout: a positive case, a negative case, and a discriminating case.

`npm run typecheck` is not optional decoration: it checks the handler signatures and event names
against the real `ExtensionAPI`/`ExtensionContext` declarations. It caught nothing on the last pass,
which is the point — it must keep passing.
