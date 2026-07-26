/**
 * Shared ACP provider gate for the Pi ACP extensions.
 *
 * Every ACP extension (cursor-acp, codex-app-server, claude-code-acp, rovo-acp)
 * discovers its models by spawning the underlying agent CLI, which is the bulk
 * of Pi's startup time. This module decides — before that work starts — whether
 * a provider should load at all, times the ones that do, and prints a single
 * summary once Pi's session comes up.
 *
 * Config file: <extensions dir>/acp-config.json (see resolveConfigPath()).
 * Env toggles: ENABLE_CURSOR_ACP / ENABLE_CODEX_ACP / ENABLE_CLAUDE_ACP /
 * ENABLE_ROVO_ACP — any value other than "0"/"false" force-enables that
 * provider even when the config file disabled it; "0"/"false" force-disables it.
 *
 * NOTE: this file lives in a subdirectory without an index.ts on purpose. Pi
 * only auto-loads `extensions/*.ts` and `extensions/<dir>/index.ts`, so keeping
 * it here stops Pi from trying to load it as an extension of its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AcpProvider = "cursor" | "codex" | "claude" | "rovo";

export const ACP_PROVIDERS: readonly AcpProvider[] = ["cursor", "codex", "claude", "rovo"];

/** Display names, matching the extension file each provider comes from. */
const PROVIDER_LABELS: Record<AcpProvider, string> = {
	cursor: "cursor-acp",
	codex: "codex-app-server",
	claude: "claude-code-acp",
	rovo: "rovo-acp",
};

/** Per-provider config keys. */
const PROVIDER_CONFIG_KEYS: Record<AcpProvider, string> = {
	cursor: "enable_cursor_acp_models",
	codex: "enable_codex_acp_models",
	claude: "enable_claude_acp_models",
	rovo: "enable_rovo_acp_models",
};

/** Per-provider environment overrides. */
const PROVIDER_ENV_KEYS: Record<AcpProvider, string> = {
	cursor: "ENABLE_CURSOR_ACP",
	codex: "ENABLE_CODEX_ACP",
	claude: "ENABLE_CLAUDE_ACP",
	rovo: "ENABLE_ROVO_ACP",
};

const CONFIG_FILE_NAME = "acp-config.json";
const MASTER_KEY = "enable_acp_models";
const ALL_KEY = "enable_all_acp_models";

export type AcpConfigFile = {
	/** Absolute path we looked at. */
	path: string;
	/** Whether the file exists and parsed. */
	found: boolean;
	/** Parse/read failure, if any. The gate falls back to "all enabled". */
	error: string | null;
	/** Raw config values, empty when the file is missing or broken. */
	values: Record<string, unknown>;
};

export type AcpDecision = {
	provider: AcpProvider;
	label: string;
	enabled: boolean;
	/** Human-readable explanation of which rule decided this. */
	reason: string;
};

type LoadRecord = AcpDecision & {
	/** Milliseconds spent loading (0 for skipped providers). */
	ms: number;
	/** Number of models registered. */
	models: number;
	error?: string;
};

type SharedState = {
	config: AcpConfigFile | null;
	records: Map<AcpProvider, LoadRecord>;
	/** Providers seen in the current load round; a repeat means Pi reloaded. */
	round: Set<AcpProvider>;
	announced: boolean;
	commandOwner: AcpProvider | null;
};

/**
 * Pi loads each extension through its own jiti instance with `moduleCache:
 * false`, so this module is re-evaluated per extension and module-level state
 * is NOT shared. globalThis is what all four copies actually have in common.
 */
const STATE_KEY = "__piAcpProviderGateState__";

function sharedState(): SharedState {
	const g = globalThis as Record<string, unknown>;
	let state = g[STATE_KEY] as SharedState | undefined;
	if (!state) {
		state = { config: null, records: new Map(), round: new Set(), announced: false, commandOwner: null };
		g[STATE_KEY] = state;
	}
	return state;
}

/**
 * The extensions directory this file was installed into, so the config is found
 * regardless of Pi's cwd.
 */
function resolveConfigPath(): string {
	const override = process.env.PI_ACP_CONFIG?.trim();
	if (override) return path.resolve(override);
	try {
		// acp-lib/config.ts -> acp-lib -> extensions
		return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), CONFIG_FILE_NAME);
	} catch {
		return path.join(os.homedir(), ".pi", "agent", "extensions", CONFIG_FILE_NAME);
	}
}

export function readAcpConfigFile(): AcpConfigFile {
	const state = sharedState();
	if (state.config) return state.config;

	const configPath = resolveConfigPath();
	let config: AcpConfigFile;
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			config = { path: configPath, found: true, error: "config root must be a JSON object", values: {} };
		} else {
			config = { path: configPath, found: true, error: null, values: parsed as Record<string, unknown> };
		}
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
		config = {
			path: configPath,
			found: false,
			error: missing ? null : error instanceof Error ? error.message : String(error),
			values: {},
		};
	}
	state.config = config;
	return config;
}

/** Allow line and block comments so the shipped config can document itself. */
function stripJsonComments(input: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && input[i + 1] === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (ch === "/" && input[i + 1] === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += ch;
	}
	return out;
}

function readBool(values: Record<string, unknown>, key: string): boolean | undefined {
	const value = values[key];
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "true") return true;
		if (v === "false") return false;
	}
	return undefined;
}

/**
 * `undefined` when the variable is unset or empty; otherwise true for anything
 * that is not "0" or "false".
 */
function readEnvToggle(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "") return undefined;
	return v !== "0" && v !== "false";
}

/**
 * Resolve whether one provider should load.
 *
 * Precedence, highest first:
 *   1. ENABLE_<PROVIDER>_ACP env var (force enable, or force disable on 0/false)
 *   2. enable_acp_models: false        -> nothing loads
 *   3. enable_all_acp_models: true     -> everything loads
 *   4. enable_<provider>_acp_models    -> that provider only
 *   5. no per-provider key set anywhere -> everything loads (back-compat)
 *      at least one per-provider key set -> unset providers stay off
 */
export function decideAcpProvider(provider: AcpProvider, config = readAcpConfigFile()): AcpDecision {
	const label = PROVIDER_LABELS[provider];
	const envKey = PROVIDER_ENV_KEYS[provider];
	const envValue = readEnvToggle(envKey);
	if (envValue !== undefined) {
		return { provider, label, enabled: envValue, reason: `${envKey}=${process.env[envKey]}` };
	}

	if (config.error) {
		return { provider, label, enabled: true, reason: `${CONFIG_FILE_NAME} unreadable (${config.error}); defaulting on` };
	}
	if (!config.found) {
		return { provider, label, enabled: true, reason: `no ${CONFIG_FILE_NAME}; defaulting on` };
	}

	if (readBool(config.values, MASTER_KEY) === false) {
		return { provider, label, enabled: false, reason: `${MASTER_KEY}=false` };
	}
	if (readBool(config.values, ALL_KEY) === true) {
		return { provider, label, enabled: true, reason: `${ALL_KEY}=true` };
	}

	const key = PROVIDER_CONFIG_KEYS[provider];
	const explicit = readBool(config.values, key);
	if (explicit !== undefined) {
		return { provider, label, enabled: explicit, reason: `${key}=${explicit}` };
	}

	const anyProviderKeySet = ACP_PROVIDERS.some((p) => readBool(config.values, PROVIDER_CONFIG_KEYS[p]) !== undefined);
	if (anyProviderKeySet) {
		return { provider, label, enabled: false, reason: `${key} not set` };
	}
	return { provider, label, enabled: true, reason: "no per-provider keys set; defaulting on" };
}

export type AcpGate = {
	/** False when the extension should return without discovering models. */
	enabled: boolean;
	reason: string;
	/** Record a successful load. Call right after registerProvider(). */
	loaded(modelCount: number): void;
	/** Record a load that blew up, so the summary can say so. */
	failed(error: unknown): void;
};

/**
 * Open the gate for one ACP provider.
 *
 * Call this as the very first statement of the extension's default export, and
 * return immediately when `enabled` is false — everything after it (spawning
 * the agent CLI to discover models) is what makes startup slow.
 */
export function acpProviderGate(pi: ExtensionAPI, provider: AcpProvider): AcpGate {
	const state = sharedState();

	// Seeing the same provider twice means Pi reloaded extensions: start a fresh
	// round so the summary reflects the new load rather than appending to the old.
	if (state.round.has(provider)) {
		state.round.clear();
		state.records.clear();
		state.announced = false;
		state.commandOwner = null;
		state.config = null;
	}
	state.round.add(provider);

	const decision = decideAcpProvider(provider);
	const startedAt = performance.now();
	let recorded = false;

	const record = (models: number, error?: string) => {
		if (recorded) return;
		recorded = true;
		state.records.set(provider, {
			...decision,
			ms: decision.enabled ? performance.now() - startedAt : 0,
			models,
			error,
		});
	};

	registerSummary(pi, provider, state);

	if (!decision.enabled) {
		record(0);
		return { enabled: false, reason: decision.reason, loaded: () => {}, failed: () => {} };
	}

	return {
		enabled: true,
		reason: decision.reason,
		loaded: (modelCount: number) => record(modelCount),
		failed: (error: unknown) => record(0, error instanceof Error ? error.message : String(error)),
	};
}

/**
 * Every extension registers this, but only the first handler to fire prints —
 * by the time any session_start runs, all extensions have finished loading.
 */
function registerSummary(pi: ExtensionAPI, provider: AcpProvider, state: SharedState): void {
	pi.on("session_start", async (_event, ctx) => {
		if (state.announced) return;
		state.announced = true;
		ctx.ui.notify(formatAcpSummary(state.records), "info");
	});

	if (state.commandOwner === null) {
		state.commandOwner = provider;
		pi.registerCommand("acp-config", {
			description: "Show which ACP model providers are enabled and how long they took to load",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatAcpConfigReport(state.records), "info");
			},
		});
	}
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

function modelCount(n: number): string {
	return `${n} model${n === 1 ? "" : "s"}`;
}

/** The two lines Pi shows at startup. */
export function formatAcpSummary(records: Map<AcpProvider, LoadRecord>): string {
	const ordered = ACP_PROVIDERS.map((p) => records.get(p)).filter((r): r is LoadRecord => r !== undefined);
	const loaded = ordered.filter((r) => r.enabled);
	const skipped = ordered.filter((r) => !r.enabled);
	const totalMs = loaded.reduce((sum, r) => sum + r.ms, 0);

	const lines: string[] = [];
	lines.push(
		`ACP model providers loaded: ${
			loaded.length === 0
				? "none"
				: loaded
						.map((r) => `${r.label} (${r.error ? `failed: ${r.error}` : modelCount(r.models)}, ${seconds(r.ms)})`)
						.join(", ")
		}`,
	);
	if (skipped.length > 0) {
		lines.push(`ACP model providers skipped: ${skipped.map((r) => `${r.label} (${r.reason})`).join(", ")}`);
	}
	lines.push(`Time taken for loading ACP models: ${seconds(totalMs)}`);
	return lines.join("\n");
}

/** The verbose /acp-config output. */
export function formatAcpConfigReport(records: Map<AcpProvider, LoadRecord>): string {
	const config = readAcpConfigFile();
	const lines: string[] = [];
	lines.push(`config: ${config.path}${config.found ? "" : " (not found; all providers default on)"}`);
	if (config.error) lines.push(`config error: ${config.error}`);
	for (const key of [MASTER_KEY, ALL_KEY, ...ACP_PROVIDERS.map((p) => PROVIDER_CONFIG_KEYS[p])]) {
		const value = readBool(config.values, key);
		lines.push(`  ${key}: ${value === undefined ? "(not set)" : value}`);
	}
	lines.push("providers:");
	for (const provider of ACP_PROVIDERS) {
		const record = records.get(provider);
		const label = PROVIDER_LABELS[provider];
		if (!record) {
			lines.push(`  ${label}: not installed`);
			continue;
		}
		const detail = record.enabled
			? `${record.error ? `failed: ${record.error}` : modelCount(record.models)}, ${seconds(record.ms)}`
			: "skipped";
		lines.push(`  ${label}: ${record.enabled ? "enabled" : "disabled"} — ${detail} [${record.reason}]`);
	}
	const totalMs = [...records.values()].reduce((sum, r) => sum + r.ms, 0);
	lines.push(`Time taken for loading ACP models: ${seconds(totalMs)}`);
	lines.push(
		`env overrides: ${ACP_PROVIDERS.map((p) => `${PROVIDER_ENV_KEYS[p]}=${process.env[PROVIDER_ENV_KEYS[p]] ?? "(unset)"}`).join(", ")}`,
	);
	return lines.join("\n");
}
