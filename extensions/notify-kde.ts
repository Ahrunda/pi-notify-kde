/**
 * notify-kde — tell me when pi needs me: a KDE desktop notification, plus a push to my phone
 * over KDE Connect.
 *
 * Two triggers, both of them "pi is stuck and it is your turn now":
 *   1. `agent_settled`   — the whole run really finished (after retries / auto-compaction /
 *                          queued follow-ups), so the ball is in your court again.
 *   2. `ui_prompt_start` — pi opened a blocking prompt (quiz / confirm / select) and is waiting.
 *
 * Quiet by default:
 *   - non-interactive runs (`pi -p`, `--mode json`, subagent child processes) never notify;
 *   - a run shorter than `minDurationMs` (default 30 s) never notifies, so asking one quick
 *     question does not buzz your phone;
 *   - a run you aborted with Esc is not announced (`suppressWhenAborted`) — you are obviously
 *     already at the keyboard;
 *   - a UI prompt is announced only after `uiPromptDelayMs` (default 8 s), so answering quickly
 *     stays silent.
 *
 * Phone delivery is best-effort and *reported*: KDE Connect has no "push an arbitrary
 * notification" API; the equivalent is `--ping-msg` (a notification plus a vibration on the
 * phone). It needs the phone to be reachable right now. When it is not, the desktop notification
 * body gains a "phone not reached" line, and a bounded refresh-and-poll retry runs in the
 * background. See docs/measurements.md for why that retry has to *poll*.
 *
 * Config:  ~/.pi/agent/notify-kde.json   (created on first run; missing keys are backfilled,
 *                                         the previous file is copied to .bak first)
 * Command: /notify-kde            show the effective config and the last phone delivery result
 *          /notify-kde test       send a test notification right now
 *          /notify-kde on|off     flip the master switch (writes the config, backing up .bak)
 * Log:     ~/.cache/pi/notify-kde.log
 * Uninstall: delete this file. The config file and the log are yours to keep or remove.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ============================================================================
// Configuration shape and defaults
// ============================================================================

export type Locale = "en" | "zh";
export type Urgency = "low" | "normal" | "critical";

export interface Cfg {
	enabled: boolean;
	locale: Locale;
	minDurationMs: number;
	desktop: boolean;
	desktopTimeoutMs: number;
	urgency: Urgency;
	icon: string;
	coalesce: boolean;
	dismissOnReturn: boolean;
	kdeconnect: boolean;
	kdeconnectDevices: string[];
	kdeconnectTimeoutMs: number;
	kdeconnectRefreshWhenOffline: boolean;
	kdeconnectRefreshTimeoutMs: number;
	annotatePhoneFailure: boolean;
	notifyOnDone: boolean;
	notifyOnUiPrompt: boolean;
	uiPromptDelayMs: number;
	includeSnippet: boolean;
	snippetChars: number;
	suppressWhenAborted: boolean;
	titlePrefix: string;
}

export const URGENCIES: readonly Urgency[] = ["low", "normal", "critical"];
export const LOCALES: readonly Locale[] = ["en", "zh"];

export const DEFAULTS: Cfg = {
	enabled: true,
	locale: "en",
	minDurationMs: 30000,
	desktop: true,
	desktopTimeoutMs: 8000,
	urgency: "normal",
	icon: "utilities-terminal",
	coalesce: true,
	dismissOnReturn: true,
	kdeconnect: true,
	kdeconnectDevices: [],
	kdeconnectTimeoutMs: 5000,
	kdeconnectRefreshWhenOffline: true,
	kdeconnectRefreshTimeoutMs: 8000,
	annotatePhoneFailure: true,
	notifyOnDone: true,
	notifyOnUiPrompt: true,
	uiPromptDelayMs: 8000,
	includeSnippet: true,
	snippetChars: 140,
	suppressWhenAborted: true,
	titlePrefix: "pi",
};

export const CONFIG_HELP: Record<keyof Cfg, string> = {
	enabled: "Master switch. false = never notify (deleting the file restores defaults too).",
	locale: "Language of the notification text and of /notify-kde: en | zh.",
	minDurationMs: "Only notify when the run took at least this many ms. 0 = always notify.",
	desktop: "Whether to send the KDE desktop notification.",
	desktopTimeoutMs:
		"How long the desktop notification stays, in ms. 0 = let the notification server decide; a positive value = auto-dismiss after that long (default 8000).",
	urgency: "Desktop urgency: low | normal | critical (critical ignores Do-Not-Disturb).",
	icon: "Desktop icon name, e.g. utilities-terminal, dialog-information, face-smile. Empty string = no icon.",
	coalesce: "Replace the previous pi notification instead of stacking a new one on every event.",
	dismissOnReturn: "Withdraw the desktop notification as soon as you type again (you are back).",
	kdeconnect: "Push to the phone via kdeconnect-cli (requires the phone to be reachable).",
	kdeconnectDevices:
		"Device id allow-list (kdeconnect-cli -l --id-only). Empty [] = every paired, reachable device.",
	kdeconnectTimeoutMs: "Timeout for a single kdeconnect-cli invocation, in ms.",
	kdeconnectRefreshWhenOffline:
		"When no device is reachable, ask kdeconnectd to rescan the network and retry. Runs after the desktop notification, so it never delays the alert.",
	kdeconnectRefreshTimeoutMs: "Budget for that rescan-and-poll retry, in ms.",
	annotatePhoneFailure:
		"Add a 'phone not reached' line to the desktop notification when the push failed, instead of failing silently.",
	notifyOnDone: "Notify when a run finishes.",
	notifyOnUiPrompt: "Notify when pi opens a blocking prompt (quiz / confirm / select).",
	uiPromptDelayMs: "Only announce a prompt after it has been waiting this long, in ms. 0 = immediately.",
	includeSnippet: "Include a one-line summary of the last assistant message in the notification.",
	snippetChars: "Maximum length of that summary.",
	suppressWhenAborted: "Do not notify for a run you aborted with Esc (you are at the keyboard).",
	titlePrefix: "Notification title prefix. Titles become 'prefix · project · session'.",
};

// ============================================================================
// Pure helpers (exported for the unit tests; no I/O, no pi dependency)
// ============================================================================

/** First non-empty line, collapsed to one line and truncated. */
export function brief(text: string, max = 100): string {
	const line = (text.split("\n").find((item) => item.trim()) ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function fmtDuration(ms: number, locale: Locale = "en"): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const zh = locale === "zh";
	const sec = zh ? "秒" : "s";
	const min = zh ? "分" : "m";
	const hour = zh ? "小时" : "h";
	if (total < 60) return `${total}${sec}`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	if (m < 60) return s ? `${m}${min} ${s}${sec}` : `${m}${min}`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}${hour} ${rm}${min}` : `${h}${hour}`;
}

/** Collapse a markdown reply into a single short line suitable for a notification body. */
export function snippet(text: string, max: number): string {
	if (!text) return "";
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " [code] ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s*/gm, "")
		.replace(/^\s{0,3}[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	return cleaned.length > max ? `${cleaned.slice(0, Math.max(1, max - 1))}…` : cleaned;
}

/** Flatten an agent message into its plain text (string content, or text parts). */
export function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const p = part as { type?: unknown; text?: unknown };
			return p?.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Pick a notification language from $LANG, so a zh_CN machine gets Chinese by default. */
export function localeFromEnv(lang: string | undefined): Locale {
	return lang && /^zh/i.test(lang) ? "zh" : "en";
}

/**
 * Validate a parsed config object against DEFAULTS: unknown keys are ignored, wrong types fall
 * back to the default, out-of-range numbers are clamped, and `[]` is still an array of strings.
 */
export function coerceConfig(src: unknown): { cfg: Cfg; error?: string } {
	if (src === undefined) return { cfg: { ...DEFAULTS } };
	if (typeof src !== "object" || src === null || Array.isArray(src)) {
		return { cfg: { ...DEFAULTS }, error: "config is not a JSON object; using defaults" };
	}
	const raw = src as Record<string, unknown>;
	const cfg = { ...DEFAULTS } as unknown as Record<string, unknown>;
	for (const key of Object.keys(DEFAULTS) as (keyof Cfg)[]) {
		const value = raw[key];
		if (value === undefined) continue;
		const expected = DEFAULTS[key];
		if (typeof expected === "number" && typeof value === "number" && Number.isFinite(value)) cfg[key] = value;
		else if (typeof expected === "boolean" && typeof value === "boolean") cfg[key] = value;
		else if (typeof expected === "string" && typeof value === "string") cfg[key] = value;
		else if (Array.isArray(expected) && Array.isArray(value)) {
			cfg[key] = value.filter((item): item is string => typeof item === "string" && item.length > 0);
		}
	}
	const out = cfg as unknown as Cfg;
	if (!URGENCIES.includes(out.urgency)) out.urgency = DEFAULTS.urgency;
	if (!LOCALES.includes(out.locale)) out.locale = DEFAULTS.locale;
	out.minDurationMs = clamp(out.minDurationMs, 0, Number.MAX_SAFE_INTEGER);
	out.uiPromptDelayMs = clamp(out.uiPromptDelayMs, 0, Number.MAX_SAFE_INTEGER);
	out.desktopTimeoutMs = clamp(out.desktopTimeoutMs, 0, Number.MAX_SAFE_INTEGER);
	out.snippetChars = clamp(out.snippetChars, 20, 2000);
	out.kdeconnectTimeoutMs = clamp(out.kdeconnectTimeoutMs, 500, 60000);
	out.kdeconnectRefreshTimeoutMs = clamp(out.kdeconnectRefreshTimeoutMs, 500, 120000);
	return { cfg: out };
}

/**
 * argv for notify-send.
 *
 * The `--` is load-bearing: without it notify-send parses a title or body that starts with `-`
 * as an option of its own (`-wait ...` becomes `-w`, and the whole notification fails with
 * "Error parsing option"). `execFile` passing an array does not protect against that, because it
 * is notify-send's own argument parser that misreads it. Regression-tested in test/pure.test.ts.
 */
export function buildNotifyArgs(cfg: Cfg, title: string, body: string, replaceId?: number): string[] {
	const args = ["-a", APP_NAME, "-u", cfg.urgency, "-t", String(cfg.desktopTimeoutMs), "-p"];
	if (replaceId !== undefined) args.push("-r", String(replaceId));
	if (cfg.icon) args.push("-i", cfg.icon);
	args.push("--", title, body);
	return args;
}

/** argv to withdraw a notification we sent earlier. */
export function buildCloseArgs(id: number): string[] {
	return [
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.CloseNotification",
		String(id),
	];
}

export function buildPingArgs(deviceId: string, text: string): string[] {
	return ["--ping-msg", text, "-d", deviceId];
}

/**
 * Delays between polls of `kdeconnect-cli -a`, growing geometrically and capped.
 *
 * This is the fix for the original retry bug: `kdeconnect-cli --refresh` returns in ~5 ms because
 * it only *asks* kdeconnectd to rescan; the device shows up a few seconds later. Listing once
 * immediately after the refresh therefore always read the pre-refresh cache. Measured, see
 * docs/measurements.md.
 */
export function pollDelays(timeoutMs: number, start = 250, factor = 1.6, cap = 1000): number[] {
	const out: number[] = [];
	let delay = start;
	let total = 0;
	while (total + delay <= timeoutMs) {
		out.push(Math.round(delay));
		total += delay;
		delay = Math.min(delay * factor, cap);
	}
	return out;
}

/** Keep the phone-side text within a length a notification can actually show. */
export function truncatePhone(text: string, max = 300): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ============================================================================
// Localized strings
// ============================================================================

interface Strings {
	done: (duration: string) => string;
	failed: (duration: string) => string;
	phoneNotReached: (detail: string) => string;
	noDevice: string;
	pingFailed: (detail: string) => string;
	sentToOne: string;
	sentToMany: (count: number) => string;
	waiting: (what: string) => string;
	testBody: string;
	testHead: string;
	promptKinds: Record<string, string>;
	waitingForAnswer: string;
	viaTool: (tool: string) => string;
	enabled: string;
	disabled: string;
	threshold: (ms: number) => string;
	desktopLabel: (on: boolean) => string;
	phoneLabel: (on: boolean) => string;
	promptDelay: (ms: number) => string;
	noDbus: string;
	lastDeliveryNever: string;
	lastDeliveryAt: (clock: string, ok: boolean, detail: string) => string;
	delivered: string;
	testSent: (desktop: boolean, phone: boolean) => string;
	switched: (on: boolean) => string;
}

const STRINGS: Record<Locale, Strings> = {
	en: {
		done: (d) => `✅ Done · ${d}`,
		failed: (d) => `⚠️ Failed · ${d}`,
		phoneNotReached: (detail) => `⚠️ Phone not reached (${detail})`,
		noDevice: "no paired device is reachable",
		pingFailed: (detail) => `ping failed: ${detail}`,
		sentToOne: "sent to the phone",
		sentToMany: (n) => `sent to ${n} devices`,
		waiting: (what) => `⏳ pi is waiting for you · ${what}`,
		testBody: "🔔 Test notification — if you can see this, the chain works",
		testHead: "🔔 Test notification",
		promptKinds: {
			select: "pick one",
			confirm: "confirm",
			input: "type something",
			editor: "edit something",
			custom: "waiting for an answer",
		},
		waitingForAnswer: "waiting for an answer",
		viaTool: (tool) => `via the ${tool} tool`,
		enabled: "enabled",
		disabled: "disabled",
		threshold: (ms) => `threshold ${ms}ms`,
		desktopLabel: (on) => `desktop ${on ? "on" : "off"}`,
		phoneLabel: (on) => `phone ${on ? "on" : "off"}`,
		promptDelay: (ms) => `prompt delay ${ms}ms`,
		noDbus: "⚠️ no session DBus (notifications cannot be sent)",
		lastDeliveryNever: "last phone delivery: none yet in this session",
		lastDeliveryAt: (clock, ok, detail) => `last phone delivery: ${clock} ${ok ? "✅ delivered" : `❌ ${detail}`}`,
		delivered: "delivered",
		testSent: (desktop, phone) => `test notification sent (desktop ${desktop ? "on" : "off"}, phone ${phone ? "on" : "off"})`,
		switched: (on) => `notifications ${on ? "enabled" : "disabled"}`,
	},
	zh: {
		done: (d) => `✅ 跑完了 · ${d}`,
		failed: (d) => `⚠️ 出错了 · ${d}`,
		phoneNotReached: (detail) => `⚠️ 手机未送达（${detail}）`,
		noDevice: "无在线且已配对的设备",
		pingFailed: (detail) => `ping 失败：${detail}`,
		sentToOne: "已推送到手机",
		sentToMany: (n) => `已推送到 ${n} 台设备`,
		waiting: (what) => `⏳ pi 挂着等你 · ${what}`,
		testBody: "🔔 这是一条测试通知，看到就说明链路通了",
		testHead: "🔔 测试通知",
		promptKinds: {
			select: "要你选一个",
			confirm: "要你确认",
			input: "要你输入",
			editor: "要你编辑",
			custom: "在等你回答",
		},
		waitingForAnswer: "在等你回答",
		viaTool: (tool) => `（${tool} 工具）`,
		enabled: "启用",
		disabled: "停用",
		threshold: (ms) => `阈值 ${ms}ms`,
		desktopLabel: (on) => `桌面${on ? "开" : "关"}`,
		phoneLabel: (on) => `手机${on ? "开" : "关"}`,
		promptDelay: (ms) => `提问延迟 ${ms}ms`,
		noDbus: "⚠️ 无 DBus（提醒不会发）",
		lastDeliveryNever: "上次手机投递：本次会话还没有发过",
		lastDeliveryAt: (clock, ok, detail) => `上次手机投递：${clock} ${ok ? "✅ 已送达" : `❌ ${detail}`}`,
		delivered: "已送达",
		testSent: (desktop, phone) => `测试通知已发（桌面 ${desktop ? "开" : "关"} / 手机 ${phone ? "开" : "关"}）`,
		switched: (on) => `pi 通知已${on ? "开启" : "停用"}`,
	},
};

function str(cfg: Cfg): Strings {
	return STRINGS[cfg.locale] ?? STRINGS.en;
}

// ============================================================================
// Paths and I/O
// ============================================================================

const CONFIG_PATH = process.env.PI_NOTIFY_KDE_CONFIG ?? join(homedir(), ".pi", "agent", "notify-kde.json");
const LOG_PATH =
	process.env.PI_NOTIFY_KDE_LOG ??
	join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi", "notify-kde.log");
const APP_NAME = "pi";

const MAX_LOG_BYTES = 256 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
/** Upper bound on the pre-flight "is the phone reachable" probe, so the desktop alert is not held up. */
const QUICK_PROBE_MS = 3000;

/** Re-create the log from its own tail instead of truncating it to nothing. */
function rotateLog(): void {
	try {
		const size = statSync(LOG_PATH).size;
		if (size <= MAX_LOG_BYTES) return;
		const start = Math.max(0, size - LOG_TAIL_BYTES);
		const fd = openSync(LOG_PATH, "r");
		try {
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString("utf8");
			const newline = text.indexOf("\n");
			writeFileSync(LOG_PATH, newline >= 0 ? text.slice(newline + 1) : text);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* the log is best-effort; never let it break pi */
	}
}

function log(msg: string): void {
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		rotateLog();
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* never let logging break pi */
	}
}

/**
 * pi can run from tmux or a non-login shell where the desktop session's DBus address was never
 * exported. Rebuild it the way the session manager would.
 */
function hydrateEnv(): void {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (!process.env.XDG_RUNTIME_DIR && uid !== undefined && existsSync(`/run/user/${uid}`)) {
		process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
	}
	if (!process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_RUNTIME_DIR) {
		const socket = join(process.env.XDG_RUNTIME_DIR, "bus");
		if (existsSync(socket)) process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socket}`;
	}
}

interface RunResult {
	ok: boolean;
	out: string;
	err: string;
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
			// Deliberately never fall back to error.message: it embeds the full command line, which
			// for a phone ping contains the notification text (and possibly a snippet of your reply).
			const reason = error
				? String(stderr ?? "").trim() || `exit ${(error as { code?: unknown }).code ?? "failure"}`
				: "";
			resolve({ ok: !error, out: String(stdout ?? ""), err: reason });
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Config file
// ============================================================================

function readRawObject(): { present: boolean; value?: Record<string, unknown>; broken?: boolean } {
	if (!existsSync(CONFIG_PATH)) return { present: false };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return { present: true, value: parsed as Record<string, unknown> };
		}
		return { present: true, broken: true };
	} catch {
		return { present: true, broken: true };
	}
}

function annotatedDefaults(): Record<string, unknown> {
	const out: Record<string, unknown> = {
		_about: "notify-kde config. Re-read on every notification, so edits take effect immediately (no /reload).",
		_keys: CONFIG_HELP,
		_reset: "Delete this file to restore defaults, or run /notify-kde on|off.",
	};
	for (const [key, value] of Object.entries(DEFAULTS)) out[key] = value;
	return out;
}

function backupConfig(): void {
	try {
		if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
	} catch (error) {
		log(`config backup failed: ${String(error)}`);
	}
}

function writeConfig(values: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...annotatedDefaults(), ...values }, null, 2)}\n`, {
			mode: 0o644,
		});
	} catch (error) {
		log(`writing the config failed: ${String(error)}`);
	}
}

/** Create the config on first run, and backfill keys added by newer versions. */
function ensureConfigFile(): void {
	const raw = readRawObject();
	if (!raw.present) {
		writeConfig({ locale: localeFromEnv(process.env.LANG) });
		log(`created default config ${CONFIG_PATH}`);
		return;
	}
	if (raw.broken || !raw.value) return; // loadConfig will fall back to defaults; leave the file alone
	const missing = (Object.keys(DEFAULTS) as (keyof Cfg)[]).filter((key) => raw.value?.[key] === undefined);
	if (missing.length === 0) return;
	backupConfig();
	// A brand-new `locale` key follows the machine's language instead of hard-coding english.
	const seed: Record<string, unknown> = { ...raw.value };
	if (missing.includes("locale")) seed.locale = localeFromEnv(process.env.LANG);
	writeConfig(seed);
	log(`backfilled config keys ${missing.join(", ")} (previous file saved as .bak)`);
}

function loadConfig(): { cfg: Cfg; error?: string } {
	const raw = readRawObject();
	if (!raw.present) return { cfg: { ...DEFAULTS } };
	if (raw.broken) return { cfg: { ...DEFAULTS }, error: `${CONFIG_PATH} is not a JSON object; using defaults` };
	return coerceConfig(raw.value);
}

function persistEnabled(enabled: boolean): void {
	backupConfig();
	writeConfig({ ...(readRawObject().value ?? {}), enabled });
}

function fmtClock(at: number, locale: Locale): string {
	return new Date(at).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

// ============================================================================
// Notification delivery
// ============================================================================

interface PhoneOutcome {
	ok: boolean;
	detail: string;
	/** Ids that were probed, when this was an automatic (non-pinned) attempt. `[]` = none reachable. */
	probed?: string[];
}

interface PhoneStatus extends PhoneOutcome {
	at: number;
}

let lastPhone: PhoneStatus | undefined;
/** Notification id returned by the last notify-send, used to coalesce and to withdraw. */
let desktopNoticeId: number | undefined;

function desktopNotify(cfg: Cfg, title: string, body: string): Promise<void> {
	const replaceId = cfg.coalesce ? desktopNoticeId : undefined;
	const args = buildNotifyArgs(cfg, title, body, replaceId);
	return new Promise((resolve) => {
		execFile("notify-send", args, { timeout: 15000 }, (error, stdout, stderr) => {
			if (error) {
				log(`notify-send failed: ${String(stderr ?? "").trim() || (error as { code?: unknown }).code}`);
			} else {
				const id = Number.parseInt(String(stdout ?? "").trim(), 10);
				if (Number.isInteger(id)) desktopNoticeId = id;
			}
			resolve();
		});
	});
}

function closeDesktopNotice(id: number): Promise<void> {
	return runCmd("gdbus", buildCloseArgs(id), 3000).then((result) => {
		if (!result.ok) log(`could not withdraw notification ${id}: ${brief(result.err)}`);
	});
}

async function listReachable(cfg: Cfg, timeoutMs = cfg.kdeconnectTimeoutMs): Promise<string[]> {
	const listed = await runCmd("kdeconnect-cli", ["-a", "--id-only"], timeoutMs);
	if (!listed.ok && !listed.out.trim()) log(`kdeconnect-cli could not list devices: ${brief(listed.err)}`);
	return listed.out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function pingIds(cfg: Cfg, ids: string[], text: string): Promise<{ ok: boolean; detail: string }> {
	const s = str(cfg);
	if (ids.length === 0) return { ok: false, detail: s.noDevice };
	const results = await Promise.all(
		ids.map((id) => runCmd("kdeconnect-cli", buildPingArgs(id, text), cfg.kdeconnectTimeoutMs)),
	);
	const failed = results.filter((r) => !r.ok).map((r) => brief(r.err || r.out));
	if (failed.length > 0) return { ok: false, detail: s.pingFailed(failed.join("; ")) };
	return { ok: true, detail: ids.length > 1 ? s.sentToMany(ids.length) : s.sentToOne };
}

/** First attempt at the phone, before the desktop notification goes out. */
async function tryPhone(cfg: Cfg, text: string): Promise<PhoneOutcome> {
	if (cfg.kdeconnectDevices.length > 0) {
		const result = await pingIds(cfg, cfg.kdeconnectDevices, text);
		return { ...result, probed: undefined };
	}
	const ids = await listReachable(cfg, Math.min(cfg.kdeconnectTimeoutMs, QUICK_PROBE_MS));
	if (ids.length === 0) return { ok: false, detail: str(cfg).noDevice, probed: [] };
	const result = await pingIds(cfg, ids, text);
	return { ...result, probed: ids };
}

/**
 * Ask kdeconnectd to rescan, then *poll* until a device shows up or the budget runs out.
 *
 * Polling is the whole point: `--refresh` returns in ~5 ms and the device appears seconds later,
 * so a single list right after the refresh reads a stale cache and always finds nothing.
 */
async function refreshAndRetry(cfg: Cfg, text: string): Promise<PhoneOutcome | undefined> {
	await runCmd("kdeconnect-cli", ["--refresh"], cfg.kdeconnectRefreshTimeoutMs);
	for (const delay of pollDelays(cfg.kdeconnectRefreshTimeoutMs)) {
		await sleep(delay);
		const ids = await listReachable(cfg);
		if (ids.length > 0) {
			const result = await pingIds(cfg, ids, text);
			return { ...result, probed: ids };
		}
	}
	return undefined;
}

/**
 * Send one alert. The phone attempt and its failure note are resolved *before* the desktop
 * notification so the alert can carry the "phone not reached" line; the slow rescan-and-poll
 * retry runs afterwards, so it never delays the alert itself.
 */
async function dispatch(cfg: Cfg, title: string, body: string, phoneText: string): Promise<void> {
	const s = str(cfg);
	const ping = truncatePhone(phoneText);
	let phone: PhoneOutcome | undefined;

	if (cfg.kdeconnect) {
		phone = await tryPhone(cfg, ping);
		lastPhone = { ...phone, at: Date.now() };
		if (phone.ok) log(`phone: ${phone.detail}`);
		else log(`phone not reached: ${phone.detail}`);
	}

	const annotate = cfg.annotatePhoneFailure && phone !== undefined && !phone.ok;
	if (cfg.desktop) {
		await desktopNotify(cfg, title, annotate && phone ? `${body}\n${s.phoneNotReached(phone.detail)}` : body);
	}
	// Remember which notification carries the warning line: if it is still current when the retry
	// succeeds we replace it, and if the user already dismissed it (or typed again) we do not.
	const noticeId = desktopNoticeId;

	const noneReachable = phone?.probed !== undefined && phone.probed.length === 0;
	if (cfg.kdeconnect && cfg.kdeconnectRefreshWhenOffline && noneReachable) {
		// Deliberately not awaited: the desktop alert is already on screen, and this can take the
		// whole kdeconnectRefreshTimeoutMs budget. Holding the settled/prompt path open for that
		// long would be paid on every notification while the phone is away.
		void recoverPhone(cfg, ping, { title, body, noticeId });
	}
}

/** Background half of `dispatch`: rescan, poll, push, and correct the alert if it succeeds. */
async function recoverPhone(
	cfg: Cfg,
	phoneText: string,
	alert: { title: string; body: string; noticeId: number | undefined },
): Promise<void> {
	try {
		const after = await refreshAndRetry(cfg, phoneText);
		if (!after) {
			log("phone still unreachable after refresh");
			return;
		}
		lastPhone = { ...after, at: Date.now() };
		log(after.ok ? `phone after refresh: ${after.detail}` : `phone still unreachable after refresh: ${after.detail}`);
		// Replace the stale "phone not reached" line, but only if that notification is still the
		// current one — the user may have dismissed it or typed again while we were polling.
		const stillCurrent = alert.noticeId !== undefined && desktopNoticeId === alert.noticeId;
		if (after.ok && stillCurrent) await desktopNotify(cfg, alert.title, alert.body);
	} catch (error) {
		log(`phone recovery failed: ${String(error)}`);
	}
}

// ============================================================================
// Extension
// ============================================================================

function isInteractive(ctx: ExtensionContext): boolean {
	try {
		// print / json mode (`pi -p`, subagent children) has no UI, so an alert would be pointless.
		return ctx.hasUI === true && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
	} catch {
		// after a session replacement / hot reload the ctx is stale and any property access throws
		return false;
	}
}

function projectLabel(pi: ExtensionAPI, ctx: ExtensionContext, prefix: string): string {
	let project = "pi";
	try {
		project = basename(ctx.cwd || process.cwd()) || "pi";
	} catch {
		project = basename(process.cwd()) || "pi";
	}
	let session: string | undefined;
	try {
		session = pi.getSessionName();
	} catch {
		session = undefined;
	}
	const tail = session && session !== project ? `${project} · ${session}` : project;
	return prefix ? `${prefix} · ${tail}` : tail;
}

type Handler = (event: any, ctx: ExtensionContext) => Promise<void> | void;

/**
 * Session replacement / hot reload can still deliver events to an obsolete extension runtime,
 * where touching ctx throws "This extension ctx is stale". Swallow exactly that, log the rest.
 */
function guarded(name: string, handler: Handler): Handler {
	return async (event, ctx) => {
		try {
			await handler(event, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/ctx is stale/i.test(message)) return;
			log(`handler ${name} threw: ${message}`);
		}
	};
}

export default function (pi: ExtensionAPI) {
	let runStartedAt = 0;
	let lastAssistantText = "";
	let lastStopReason: string | undefined;
	let uiPromptTimer: ReturnType<typeof setTimeout> | undefined;
	/** toolCallId -> toolName, in start order. Keyed by id so parallel calls of the same tool survive. */
	const runningTools = new Map<string, string>();

	const clearUiTimer = (): void => {
		if (uiPromptTimer) {
			clearTimeout(uiPromptTimer);
			uiPromptTimer = undefined;
		}
	};

	pi.on(
		"session_start",
		guarded("session_start", async () => {
			hydrateEnv();
			ensureConfigFile();
		}),
	);

	pi.on(
		"before_agent_start",
		guarded("before_agent_start", async () => {
			runStartedAt = Date.now();
			lastAssistantText = "";
			lastStopReason = undefined;
			runningTools.clear();
		}),
	);

	pi.on(
		"tool_execution_start",
		guarded("tool_execution_start", async (event) => {
			runningTools.set(event.toolCallId, event.toolName);
		}),
	);

	pi.on(
		"tool_execution_end",
		guarded("tool_execution_end", async (event) => {
			runningTools.delete(event.toolCallId);
		}),
	);

	pi.on(
		"message_end",
		guarded("message_end", async (event) => {
			const message = event.message as { role?: string; stopReason?: string } | null;
			if (message?.role !== "assistant") return;
			const text = textOf(message);
			if (text) lastAssistantText = text;
			lastStopReason = message.stopReason;
		}),
	);

	pi.on(
		"agent_settled",
		guarded("agent_settled", async (_event, ctx) => {
			if (!isInteractive(ctx)) return;
			const { cfg, error } = loadConfig();
			if (error) log(error);
			if (!cfg.enabled || !cfg.notifyOnDone) return;
			if (cfg.suppressWhenAborted && lastStopReason === "aborted") return;

			const elapsed = runStartedAt ? Date.now() - runStartedAt : 0;
			if (elapsed < cfg.minDurationMs) return;

			const s = str(cfg);
			const failed = lastStopReason === "error";
			const title = projectLabel(pi, ctx, cfg.titlePrefix);
			const head = failed ? s.failed(fmtDuration(elapsed, cfg.locale)) : s.done(fmtDuration(elapsed, cfg.locale));
			const summary = cfg.includeSnippet ? snippet(lastAssistantText, cfg.snippetChars) : "";
			const body = summary ? `${head}\n${summary}` : head;
			await dispatch(cfg, title, body, `${title}: ${head}${summary ? ` · ${summary}` : ""}`);
		}),
	);

	pi.on(
		"ui_prompt_start",
		guarded("ui_prompt_start", async (event, ctx) => {
			if (!isInteractive(ctx)) return;
			const { cfg } = loadConfig();
			if (!cfg.enabled || !cfg.notifyOnUiPrompt) return;

			const s = str(cfg);
			const kind = s.promptKinds[event.kind] ?? s.waitingForAnswer;
			const tool = [...runningTools.values()].pop();
			const what = event.title ? `${kind}: ${event.title}` : tool ? `${kind} ${s.viaTool(tool)}` : kind;
			// Title and body are computed now: the timer callback must not touch ctx, which may be
			// stale by the time it fires.
			const title = projectLabel(pi, ctx, cfg.titlePrefix);
			const body = s.waiting(what);
			const phoneText = `${title}: ⏳ ${what}`;

			const fire = async (): Promise<void> => {
				uiPromptTimer = undefined;
				try {
					await dispatch(cfg, title, body, phoneText);
				} catch (error) {
					log(`prompt notification failed: ${String(error)}`);
				}
			};

			clearUiTimer();
			if (cfg.uiPromptDelayMs === 0) await fire();
			else uiPromptTimer = setTimeout(() => void fire(), cfg.uiPromptDelayMs);
		}),
	);

	pi.on(
		"ui_prompt_end",
		guarded("ui_prompt_end", async () => clearUiTimer()),
	);

	// The user typed something: they are back, so the alert on screen has served its purpose.
	pi.on(
		"input",
		guarded("input", async (event) => {
			if (event.source === "extension") return;
			const { cfg } = loadConfig();
			if (!cfg.dismissOnReturn) return;
			if (desktopNoticeId === undefined) return;
			const id = desktopNoticeId;
			desktopNoticeId = undefined;
			await closeDesktopNotice(id);
		}),
	);

	pi.on(
		"session_shutdown",
		guarded("session_shutdown", async () => {
			clearUiTimer();
			desktopNoticeId = undefined;
		}),
	);

	pi.registerCommand("notify-kde", {
		description: "notify-kde: show config, send a test, toggle (on | off | test)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				persistEnabled(enabled);
				const { cfg } = loadConfig();
				ctx.ui.notify(`${str(cfg).switched(enabled)} · ${CONFIG_PATH}`, "info");
				return;
			}

			if (sub === "test") {
				const { cfg } = loadConfig();
				const s = str(cfg);
				const title = projectLabel(pi, ctx, cfg.titlePrefix);
				const body = `${s.testBody}\n${new Date().toLocaleString()}`;
				await dispatch(cfg, `${title} · ${s.testHead}`, body, `${title}: ${s.testBody}`);
				const phone = lastPhone
					? lastPhone.ok
						? s.delivered
						: `${lastPhone.detail}`
					: s.lastDeliveryNever;
				ctx.ui.notify(
					`${s.testSent(cfg.desktop, cfg.kdeconnect)} · ${s.phoneLabel(true)}: ${phone}`,
					lastPhone && !lastPhone.ok ? "warning" : "info",
				);
				return;
			}

			const { cfg, error } = loadConfig();
			const s = str(cfg);
			const parts = [
				cfg.enabled ? s.enabled : s.disabled,
				s.threshold(cfg.minDurationMs),
				s.desktopLabel(cfg.desktop),
				s.phoneLabel(cfg.kdeconnect),
				s.promptDelay(cfg.uiPromptDelayMs),
			];
			if (!process.env.DBUS_SESSION_BUS_ADDRESS) parts.push(s.noDbus);
			if (error) parts.push(`⚠️ ${error}`);
			const phone = lastPhone
				? s.lastDeliveryAt(fmtClock(lastPhone.at, cfg.locale), lastPhone.ok, lastPhone.detail)
				: s.lastDeliveryNever;
			ctx.ui.notify(
				`${parts.join(" · ")}\n${phone}\nconfig: ${CONFIG_PATH}\nlog: ${LOG_PATH}`,
				error || (lastPhone && !lastPhone.ok) ? "warning" : "info",
			);
		},
	});
}
