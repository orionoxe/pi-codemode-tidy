/**
 * Compact display for the built-in `codemode` tool.
 *
 * Collapsed (default): the script becomes one line, every nested tool call becomes one summary
 * row, and output is previewed as readable lines — compact JSON is split at escaped newlines so
 * long payloads stop wrapping as one blob. Script errors stay above the preview. Expanded
 * (Ctrl+O) delegates to Pi's original renderer for full fidelity.
 *
 * Display only: tool results and model-facing content are never modified.
 */
import type { CodemodeToolDetails, ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TruncatedText, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type Theme = Parameters<RenderCall>[1];
type Color = Parameters<Theme["fg"]>[0];
type Call = CodemodeToolDetails["calls"][number];

const PREVIEW_LINES = 6;
const CALL_ROWS = 8;
const ARG_COLS = 60;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const SCRIPT_ERROR = "\nScript error:\n";

const STATUS: Record<Call["status"], [string, Color]> = {
	running: ["…", "warning"],
	ok: ["✓", "success"],
	error: ["✗", "error"],
	cancelled: ["⊘", "muted"],
};
const MAIN_ARGS = ["path", "file_path", "pattern", "command", "query", "url", "name", "source", "target"];

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function expandHint(theme: Theme, hidden: number, noun: string): string {
	return moreHint(theme, `... (${hidden} more ${noun}`);
}

function moreHint(theme: Theme, lead: string): string {
	return `${theme.fg("muted", `${lead},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** JSON.stringify escapes real newlines; hide escaped backslashes first so literal "\n" survives. */
function displayString(value: string): string {
	return JSON.stringify(value)
		.replace(/\\\\/g, "\u0000")
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "  ")
		.replace(/\u0000/g, "\\");
}

function formatJson(value: unknown, depth = 0): string {
	if (typeof value === "string") return displayString(value);
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	const list = Array.isArray(value);
	const entries: [string | undefined, unknown][] = list
		? (value as unknown[]).map((item) => [undefined, item])
		: Object.entries(value);
	if (entries.length === 0) return list ? "[]" : "{}";
	const pad = "  ".repeat(depth + 1);
	const body = entries
		.map(([key, item]) => `${pad}${key === undefined ? "" : `${JSON.stringify(key)}: `}${formatJson(item, depth + 1)}`)
		.join(",\n");
	return `${list ? "[" : "{"}\n${body}\n${"  ".repeat(depth)}${list ? "]" : "}"}`;
}

/** Split compact JSON output lines into readable form; other lines pass through untouched. */
function formatOutput(raw: string): string {
	return raw
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (!/^[[{].*[\]}]$/.test(trimmed)) return line;
			try {
				return formatJson(JSON.parse(trimmed) as unknown);
			} catch {
				return line;
			}
		})
		.join("\n");
}

/** `{"pattern":"business","limit":12}` -> `business · limit=12` instead of raw argument JSON. */
function summarizeArgs(raw: string): string {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return raw;
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) return raw;
	const parts: string[] = [];
	for (const key of MAIN_ARGS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			parts.push(truncateToWidth(value.trim().replace(/\s+/g, " "), ARG_COLS));
			delete args[key];
			break;
		}
	}
	for (const [key, value] of Object.entries(args)) {
		if (parts.length >= 3) break;
		if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${value}`);
		else if (typeof value === "string" && value.trim() && key !== "content") {
			parts.push(`${key}=${truncateToWidth(value.trim(), 16)}`);
		} else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`);
		else if (value && typeof value === "object") parts.push(`${key}{…}`);
	}
	return parts.join(" · ");
}

function callRow(call: Call, theme: Theme): string {
	const [icon, color] = STATUS[call.status] ?? ["?", "muted"];
	const args = summarizeArgs(call.args);
	const parts = [theme.fg(color, icon), theme.fg("toolTitle", call.name)];
	if (args) parts.push(theme.fg("muted", args));
	if (call.durationMs !== undefined) parts.push(theme.fg("dim", formatDuration(call.durationMs)));
	if (call.cost !== undefined) parts.push(theme.fg("dim", formatCost(call.cost)));
	return parts.join(" ");
}

/** Text preview limited to N wrapped lines; one line is reserved for the "more" hint. */
class Preview implements Component {
	private text: string;
	private maxLines: number;
	private hint: (hidden: number) => string;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(text: string, maxLines: number, hint: (hidden: number) => string) {
		this.text = text;
		this.maxLines = maxLines;
		this.hint = hint;
	}

	render(width: number): string[] {
		if (this.cache?.width !== width) {
			const { visualLines, skippedCount } = truncateToVisualLines(this.text, this.maxLines, width, 0, "start");
			this.cache = {
				width,
				lines:
					skippedCount > 0 ? [...visualLines, truncateToWidth(this.hint(skippedCount), width, "...")] : visualLines,
			};
		}
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

function styledLines(raw: string, color: Color, theme: Theme): string {
	return formatOutput(raw)
		.split("\n")
		.map((line) => theme.fg(color, line))
		.join("\n");
}

function compactCall(args: unknown, theme: Theme): Component {
	const code = (args as { code?: unknown } | undefined)?.code;
	const title = theme.fg("toolTitle", theme.bold("codemode"));
	const component = new Container();
	if (typeof code !== "string" || !code.trim()) {
		component.addChild(new TruncatedText(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
		return component;
	}
	const lines = code.replace(/\r/g, "").trimEnd().split("\n").length;
	component.addChild(
		new TruncatedText(
			`${title}  ${theme.fg("muted", `${lines} line${lines === 1 ? "" : "s"}`)}  ${keyHint("app.tools.expand", "to expand")}`,
			0,
			0,
		),
	);
	return component;
}

function compactResult(
	result: Parameters<RenderResult>[0],
	options: Parameters<RenderResult>[1],
	theme: Theme,
	context: Parameters<RenderResult>[3],
): Component {
	const component = new Container();
	const details = result.details as CodemodeToolDetails | undefined;
	const calls = details?.calls ?? [];

	// codemode appends "Script error:\n..." to the output text; keep it above the preview.
	const texts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
	const body = (SCRIPT_HEADER.test(texts[0] ?? "") ? texts.slice(1) : texts).join("\n");
	const normalized = `\n${body}`;
	const at = context.isError ? normalized.lastIndexOf(SCRIPT_ERROR) : -1;
	const errorText = at >= 0 ? normalized.slice(at + SCRIPT_ERROR.length) : "";
	const output = at >= 0 ? normalized.slice(1, at) : body;
	const children: Component[] = [];

	if (errorText) {
		children.push(new TruncatedText(theme.fg("error", theme.bold("Script error")), 0, 0));
		children.push(new Text(styledLines(errorText, "error", theme), 0, 0));
	}
	if (calls.length > 0) {
		const shown = calls.filter((call, index) => call.status !== "ok" || index >= calls.length - CALL_ROWS);
		if (shown.length < calls.length) {
			children.push(new TruncatedText(moreHint(theme, `... (${calls.length - shown.length} earlier calls`), 0, 0));
		}
		for (const call of shown) {
			children.push(new TruncatedText(callRow(call, theme), 0, 0));
			if (call.error) children.push(new Text(styledLines(call.error, "error", theme), 0, 0));
		}
		const priced = calls.filter((call) => call.cost !== undefined);
		if (priced.length > 1) {
			const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
			children.push(new TruncatedText(theme.fg("muted", `Model calls: ${formatCost(total)}`), 0, 0));
		}
	}
	if (!options.isPartial && output) {
		children.push(
			new Preview(styledLines(output, context.isError ? "error" : "toolOutput", theme), PREVIEW_LINES, (n) =>
				expandHint(theme, n, "lines"),
			),
		);
		if (details?.fullOutputPath) {
			children.push(new TruncatedText(theme.fg("muted", `Full output: ${details.fullOutputPath}`), 0, 0));
		}
	}
	if (children.length > 0) {
		component.addChild(new Spacer(1));
		for (const child of children) component.addChild(child);
	}
	return component;
}

export default function codemodeTidy(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "codemode") return next();
		const base = next();
		// Without Pi's own codemode renderers the expand hint would be a lie; fall back as-is.
		if (!base?.renderCall || !base.renderResult) return base;
		const { renderCall, renderResult } = base;
		return {
			...base,
			renderCall: (args, theme, context) =>
				context.expanded ? renderCall(args, theme, context) : compactCall(args, theme),
			renderResult: (result, options, theme, context) =>
				options.expanded ? renderResult(result, options, theme, context) : compactResult(result, options, theme, context),
		};
	});
}
