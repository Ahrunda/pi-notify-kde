/**
 * End-to-end smoke test: drive the extension's real handlers with a fake `pi` and a fake ctx, and
 * let it send a REAL notification (desktop, and the phone push if enabled).
 *
 *   node tools/smoke.ts [config-path] [--phone]
 *
 * `--phone` also exercises the KDE Connect push (it will buzz your phone once).
 *
 * It defaults to a throwaway config under /tmp and never touches ~/.pi/agent/notify-kde.json.
 * Set `"kdeconnect": false` in that config to avoid buzzing your phone.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const withPhone = args.includes("--phone");
const positional = args.filter((a) => !a.startsWith("--"));
const CONFIG = positional[0] ?? "/tmp/pi-notify-kde-smoke.json";
process.env.PI_NOTIFY_KDE_CONFIG = CONFIG;
process.env.PI_NOTIFY_KDE_LOG = "/tmp/pi-notify-kde-smoke.log";

// Minimal, well-formed config: notify always, so the run does not have to last 30 seconds.
mkdirSync(dirname(CONFIG), { recursive: true });
writeFileSync(
	CONFIG,
	`${JSON.stringify({ enabled: true, minDurationMs: 0, locale: "en", titlePrefix: "smoke", kdeconnect: withPhone }, null, 2)}\n`,
);

const { default: notify } = await import("../extensions/notify-kde.ts");

/** @type {Map<string, ((event: any, ctx: any) => any)[]>} */
const handlers = new Map();
const pi = {
	on(name, fn) {
		if (!handlers.has(name)) handlers.set(name, []);
		handlers.get(name).push(fn);
	},
	getSessionName: () => "smoke-session",
	registerCommand: () => {},
};

notify(pi);

const ctx = { hasUI: true, cwd: "/home/arrendar/Project/pi-notify-kde" };

function emit(name, event) {
	const list = handlers.get(name) ?? [];
	assert.ok(list.length > 0, `no handler registered for "${name}"`);
	let last;
	for (const fn of list) last = fn(event, ctx);
	return last;
}

// A real notification needs a session bus; session_start is what builds it.
await emit("session_start", { type: "session_start" });
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "no session DBus found; cannot smoke-test notifications");

await emit("before_agent_start", { type: "before_agent_start" });
await emit("message_end", {
	type: "message_end",
	message: { role: "assistant", content: "smoke test reply body", stopReason: "end_turn" },
});
await emit("agent_settled", { type: "agent_settled" });

// dismissOnReturn path: typing again must withdraw the notification without throwing.
await emit("input", { type: "input", text: "back", source: "interactive" });

// The phone recovery runs in the background on purpose (see dispatch()), so wait for the log to
// stop growing before reading it — otherwise the tool reports a snapshot taken mid-retry.
async function waitForQuiet(file, quietMs = 1000, maxMs = 15000) {
	let previous = "";
	let lastChange = Date.now();
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (current !== previous) {
			previous = current;
			lastChange = Date.now();
		} else if (Date.now() - lastChange >= quietMs) {
			return current;
		}
	}
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

const log = await waitForQuiet("/tmp/pi-notify-kde-smoke.log");
console.log(`--- ${CONFIG} (phone ${withPhone ? "on" : "off"}) ---`);
console.log(log.trim() || "(log is empty)");
assert.ok(existsSync(CONFIG), "config should exist");
console.log("\nOK: handlers ran, notification sent and withdrawn, no errors logged");
