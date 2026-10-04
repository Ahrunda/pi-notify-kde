/**
 * Tests for the pure helpers in the extension. Run with `npm test` (node --test).
 *
 * These import the extension module directly. That works because the only pi import in it is a
 * type-only import, which Node's type stripping erases, and because the module has no top-level
 * side effects: everything that touches the filesystem happens inside handlers.
 *
 * House style: every behaviour gets a positive assertion, a negative one, and — where a specific
 * bug was fixed — a discriminating assertion that would fail if that bug came back.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CONFIG_HELP,
	DEFAULTS,
	buildCloseArgs,
	buildNotifyArgs,
	buildPingArgs,
	brief,
	clamp,
	coerceConfig,
	fmtDuration,
	localeFromEnv,
	pollDelays,
	snippet,
	textOf,
	truncatePhone,
} from "../extensions/notify-kde.ts";

const cfg = { ...DEFAULTS };

// ---------------------------------------------------------------- buildNotifyArgs

test("buildNotifyArgs: separates options from the message with --", () => {
	const args = buildNotifyArgs(cfg, "pi · proj", "body");
	assert.ok(args.includes("--"), "must use -- so notify-send stops parsing its own options");
	assert.ok(args.indexOf("--") < args.indexOf("pi · proj"), "title must come after --");
	assert.ok(args.indexOf("--") < args.indexOf("body"), "body must come after --");
});

test("buildNotifyArgs: a title starting with '-' is not eaten by notify-send", () => {
	// Regression: `notify-send -a t '-wait a moment' body` exits 1 with
	// "Error parsing option" because notify-send parses the title as `-w` + `-a` + `-i`...
	// The fix is the `--`; this assertion fails if anyone removes it.
	const title = "-wait a moment";
	const args = buildNotifyArgs(cfg, title, "body");
	const dash = args.indexOf("--");
	assert.ok(dash >= 0, "-- present");
	assert.equal(args[dash + 1], title, "the dash-prefixed title sits immediately after --");
});

test("buildNotifyArgs: -i is omitted exactly when the icon is empty, and present otherwise", () => {
	const withIcon = buildNotifyArgs({ ...cfg, icon: "face-smile" }, "t", "b");
	assert.ok(withIcon.includes("-i"));
	assert.equal(withIcon[withIcon.indexOf("-i") + 1], "face-smile");
	const withoutIcon = buildNotifyArgs({ ...cfg, icon: "" }, "t", "b");
	assert.ok(!withoutIcon.includes("-i"));
	// discriminating: the two differ, so the assertion above is not vacuous
	assert.notDeepEqual(withIcon, withoutIcon);
});

test("buildNotifyArgs: -r is emitted only for an explicit replace id, and -p always", () => {
	const plain = buildNotifyArgs(cfg, "t", "b");
	assert.ok(plain.includes("-p"), "asks notify-send to print the id");
	assert.ok(!plain.includes("-r"));

	const replacing = buildNotifyArgs(cfg, "t", "b", 42);
	assert.equal(replacing[replacing.indexOf("-r") + 1], "42");

	// discriminating: replace id 0 must still be emitted (0 is a valid id, not "absent")
	const zero = buildNotifyArgs(cfg, "t", "b", 0);
	assert.equal(zero[zero.indexOf("-r") + 1], "0");
});

test("buildNotifyArgs: timeout 0 is passed through, not dropped", () => {
	const args = buildNotifyArgs({ ...cfg, desktopTimeoutMs: 0 }, "t", "b");
	assert.equal(args[args.indexOf("-t") + 1], "0");
});

test("buildNotifyArgs: carries urgency and app name", () => {
	const args = buildNotifyArgs({ ...cfg, urgency: "critical" }, "t", "b");
	assert.equal(args[args.indexOf("-u") + 1], "critical");
	assert.equal(args[args.indexOf("-a") + 1], "pi");
});

// ---------------------------------------------------------------- pollDelays

test("pollDelays: polls repeatedly instead of sleeping the whole budget once", () => {
	// Regression: refreshAndRetry used to refresh and then list exactly once, ~10 ms later.
	// A budget must therefore become *several* polls, never one long wait.
	const delays = pollDelays(5000);
	assert.ok(delays.length >= 2, `expected several polls, got ${delays.length}`);
	assert.ok(Math.max(...delays) < 5000, "no single delay may swallow the whole budget");
});

test("pollDelays: delays grow then cap, and never exceed the budget in total", () => {
	const delays = pollDelays(8000);
	assert.ok(delays.length > 0);
	for (let i = 1; i < delays.length; i += 1) {
		assert.ok(delays[i] >= delays[i - 1], "delays are non-decreasing");
	}
	assert.ok(Math.max(...delays) <= 1000, "delays are capped at 1000ms");
	const total = delays.reduce((a, b) => a + b, 0);
	assert.ok(total <= 8000, `total ${total} exceeds the budget`);
	assert.ok(total > 0, "does at least one poll worth of waiting");
});

test("pollDelays: zero (or tiny) budget yields no polling at all", () => {
	assert.deepEqual(pollDelays(0), []);
	assert.deepEqual(pollDelays(100, 250, 1.6, 1000), []);
});

// ---------------------------------------------------------------- coerceConfig

test("coerceConfig: a valid object survives unchanged", () => {
	const { cfg: out, error } = coerceConfig({ ...DEFAULTS, minDurationMs: 1000, locale: "zh", urgency: "low" });
	assert.equal(error, undefined);
	assert.equal(out.minDurationMs, 1000);
	assert.equal(out.locale, "zh");
	assert.equal(out.urgency, "low");
});

test("coerceConfig: wrong types fall back to the default, they do not throw or corrupt", () => {
	const { cfg: out } = coerceConfig({
		minDurationMs: "30000", // string where a number belongs
		desktop: "yes", // string where a boolean belongs
		titlePrefix: 7, // number where a string belongs
	});
	assert.equal(out.minDurationMs, DEFAULTS.minDurationMs);
	assert.equal(out.desktop, DEFAULTS.desktop);
	assert.equal(out.titlePrefix, DEFAULTS.titlePrefix);
});

test("coerceConfig: out-of-range numbers are clamped", () => {
	const { cfg: out } = coerceConfig({
		minDurationMs: -5,
		uiPromptDelayMs: -1,
		snippetChars: 1,
		kdeconnectTimeoutMs: 1,
		kdeconnectRefreshTimeoutMs: 99999999,
	});
	assert.equal(out.minDurationMs, 0);
	assert.equal(out.uiPromptDelayMs, 0);
	assert.equal(out.snippetChars, 20);
	assert.equal(out.kdeconnectTimeoutMs, 500);
	assert.equal(out.kdeconnectRefreshTimeoutMs, 120000);
});

test("coerceConfig: enum-ish fields reject unknown values", () => {
	const { cfg: out } = coerceConfig({ urgency: "URGENT", locale: "fr" });
	assert.equal(out.urgency, "normal");
	assert.equal(out.locale, "en");
});

test("coerceConfig: array entries are filtered to non-empty strings", () => {
	const { cfg: out } = coerceConfig({ kdeconnectDevices: ["a", 5, "", null, "b"] });
	assert.deepEqual(out.kdeconnectDevices, ["a", "b"]);
	// discriminating: an object where an array belongs must not crash and must not leak through
	const { cfg: other } = coerceConfig({ kdeconnectDevices: { nope: true } });
	assert.deepEqual(other.kdeconnectDevices, []);
});

test("coerceConfig: unknown keys are ignored, not merged", () => {
	const { cfg: out } = coerceConfig({ ...DEFAULTS, definitelyNotAKey: "x" });
	assert.ok(!("definitelyNotAKey" in out));
});

test("coerceConfig: a non-object (array, null, string) is an error and yields defaults", () => {
	for (const bad of [[], null, "nope", 3]) {
		const { cfg: out, error } = coerceConfig(bad);
		assert.ok(error, `expected an error for ${JSON.stringify(bad)}`);
		assert.deepEqual(out, DEFAULTS);
	}
	// discriminating: an absent value is NOT an error (a missing file is normal)
	const missing = coerceConfig(undefined);
	assert.equal(missing.error, undefined);
	assert.deepEqual(missing.cfg, DEFAULTS);
});

test("every config key has help text and every help entry is a real key", () => {
	// Guardrail against adding a key without documenting it, or documenting a key that vanished.
	assert.deepEqual(Object.keys(CONFIG_HELP).sort(), Object.keys(DEFAULTS).sort());
	for (const value of Object.values(CONFIG_HELP)) assert.ok(String(value).length > 10);
});

// ---------------------------------------------------------------- snippet / brief / textOf

test("snippet: collapses a markdown reply to one line", () => {
	const input = "# Heading\n\n- first item\n- second item\n\n`inline code`";
	assert.equal(snippet(input, 200), "Heading first item second item inline code");
});

test("snippet: replaces a fenced code block instead of leaking it into the notification", () => {
	const input = "before\n```js\nconst secret = 1;\n```\nafter";
	const out = snippet(input, 200);
	assert.ok(out.includes("[code]"));
	assert.ok(!out.includes("const secret"), "code body must not be copied into the notification");
	// discriminating: with the fence intact the assertion above would pass trivially only if the
	// block were stripped entirely; asserting the marker proves it was replaced, not dropped.
});

test("snippet: truncates at max and marks it, respecting the limit", () => {
	const out = snippet("x".repeat(500), 40);
	assert.equal(out.length, 40);
	assert.ok(out.endsWith("…"));
	// negative: a short input is returned untouched, with no ellipsis
	assert.equal(snippet("short", 40), "short");
	assert.ok(!snippet("short", 40).includes("…"));
});

test("snippet: empty and whitespace-only input yield an empty string", () => {
	assert.equal(snippet("", 40), "");
	assert.equal(snippet("   \n\n  ", 40), "");
});

test("textOf: reads plain string content and text parts, ignoring everything else", () => {
	assert.equal(textOf({ content: "hello" }), "hello");
	const parts = { content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }, { type: "text", text: "b" }] };
	assert.equal(textOf(parts), "a\nb");
	// negative / discriminating
	assert.equal(textOf({ content: [{ type: "image", data: "zz" }] }), "");
	assert.equal(textOf(null), "");
	assert.equal(textOf({}), "");
});

test("brief: takes the first non-empty line and clamps it", () => {
	assert.equal(brief("\n\n  first real line \n second"), "first real line");
	assert.equal(brief("a".repeat(50), 10).length, 10);
	assert.ok(brief("a".repeat(50), 10).endsWith("…"));
	assert.equal(brief("", 10), "");
});

test("truncatePhone: passes short text through and clamps long text", () => {
	assert.equal(truncatePhone("hello", 300), "hello");
	const long = truncatePhone("x".repeat(400), 300);
	assert.equal(long.length, 300);
	assert.ok(long.endsWith("…"));
});

// ---------------------------------------------------------------- misc

test("fmtDuration: english units", () => {
	assert.equal(fmtDuration(0, "en"), "0s");
	assert.equal(fmtDuration(59000, "en"), "59s");
	assert.equal(fmtDuration(60000, "en"), "1m");
	assert.equal(fmtDuration(90000, "en"), "1m 30s");
	assert.equal(fmtDuration(3600000, "en"), "1h");
	assert.equal(fmtDuration(5400000, "en"), "1h 30m");
});

test("fmtDuration: chinese units, and it really differs from english", () => {
	assert.equal(fmtDuration(90000, "zh"), "1分 30秒");
	assert.equal(fmtDuration(3600000, "zh"), "1小时");
	assert.equal(fmtDuration(5400000, "zh"), "1小时 30分");
	// discriminating: a locale-insensitive implementation would return the same string
	assert.notEqual(fmtDuration(90000, "zh"), fmtDuration(90000, "en"));
});

test("clamp: bounds both ends", () => {
	assert.equal(clamp(5, 0, 10), 5);
	assert.equal(clamp(-5, 0, 10), 0);
	assert.equal(clamp(50, 0, 10), 10);
});

test("localeFromEnv: follows $LANG, and an unset or unrelated LANG means english", () => {
	assert.equal(localeFromEnv("zh_CN.UTF-8"), "zh");
	assert.equal(localeFromEnv("zh_TW.UTF-8"), "zh");
	assert.equal(localeFromEnv("en_US.UTF-8"), "en");
	assert.equal(localeFromEnv("C.UTF-8"), "en");
	assert.equal(localeFromEnv(undefined), "en");
	// discriminating: the zh and en inputs must genuinely diverge
	assert.notEqual(localeFromEnv("zh_CN.UTF-8"), localeFromEnv("en_US.UTF-8"));
});

test("buildPingArgs: passes the message and the device id", () => {
	const args = buildPingArgs("abc123", "pi: done");
	assert.deepEqual(args, ["--ping-msg", "pi: done", "-d", "abc123"]);
});

test("buildCloseArgs: closes the exact notification id over the session bus", () => {
	const args = buildCloseArgs(17);
	assert.equal(args.at(-1), "17");
	assert.ok(args.includes("org.freedesktop.Notifications.CloseNotification"));
	assert.equal(args[args.indexOf("--method") + 1], "org.freedesktop.Notifications.CloseNotification");
	assert.ok(args.includes("org.freedesktop.Notifications"));
	assert.equal(args[0], "call");
	assert.ok(args.includes("--session"));
});
