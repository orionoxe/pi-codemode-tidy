import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Resolve the host packages installed as devDependencies; subpath exports are not public,
// so reach the internals Pi itself uses through the resolved package root.
const agentDist = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { loadExtensions } = await import(new URL("core/extensions/loader.js", agentDist));
const { initTheme, theme } = await import(new URL("modes/interactive/theme/theme.js", agentDist));
const { codemodeRenderers } = await import(new URL("extensions/codemode/renderer.js", agentDist));
const { visibleWidth } = await import(import.meta.resolve("@earendil-works/pi-tui"));

const EXT = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const renderText = (component, width = 80) => component.render(width).map(strip).join("\n");
const ctx = (extra = {}) => ({
	args: {},
	toolCallId: "t1",
	invalidate() {},
	lastComponent: undefined,
	state: {},
	cwd: process.cwd(),
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
	durationMs: 12,
	outputPad: 1,
	...extra,
});
const assertFits = (component) => {
	for (const width of [40, 80, 140]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	}
};

initTheme("dark", false);

const calls = [
	{ id: "1", name: "fffind", args: '{"pattern":"business","limit":12}', status: "ok", durationMs: 4 },
	{ id: "2", name: "fffind", args: '{"pattern":"","path":"contracts/source/**","limit":8}', status: "ok", durationMs: 2 },
	{ id: "3", name: "read", args: '{"path":"docs/agents/workflow.md","offset":1,"limit":80}', status: "ok", durationMs: 5 },
	{ id: "4", name: "bash", args: '{"command":"printf \\"display-check\\n\\""}', status: "ok", durationMs: 3 },
];
// \n in the first value is a JSON escape (real newline); \\n in the second is a literal backslash+n.
const outputText =
	'==> text 1/2 <==\n{"check":0,"value":"alpha\\nbeta","reason":"kept\\\\nraw"}\n' + "==> text 2/2 <==\ndone";
const fixture = {
	content: [
		{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
		{ type: "text", text: outputText },
	],
	details: { calls },
	isError: false,
};

const { extensions, errors } = await loadExtensions([EXT], process.cwd());
assert.deepEqual(errors, [], "extension must load");
const ext = extensions[0];
assert.equal(ext.toolRenderers?.length, 1, "registers one renderer resolver");
assert.equal(ext.tools.size, 0, "display only: registers no tools");
assert.equal(ext.commands.size, 0, "display only: registers no commands");
const resolver = ext.toolRenderers[0];

// --- resolver wiring -------------------------------------------------------
let baseCalls = 0;
const base = {
	renderShell: "self",
	renderCall: () => (baseCalls++, { render: () => ["BASE_CALL"] }),
	renderResult: () => (baseCalls++, { render: () => ["BASE_RESULT"] }),
};
const renderers = resolver("codemode", () => base);
assert.equal(renderers.renderShell, "self", "renderShell passes through");
assert.equal(resolver("web_search", () => base), base, "other tools untouched");
assert.equal(resolver("codemode", () => undefined), undefined, "no base renderer -> bail");
const partial = { renderCall: base.renderCall };
assert.equal(resolver("codemode", () => partial), partial, "incomplete base -> bail unchanged");

// --- collapsed call -------------------------------------------------------
const callArgs = { code: "SECRET_CALL_MARKER = 1\nawait tools.read({ path: 'x' })" };
const callComp = renderers.renderCall(callArgs, theme, ctx());
const callText = renderText(callComp);
assert.match(callText, /codemode/);
assert.match(callText, /2 lines/);
assert.match(callText, /to expand/);
assert.ok(!callText.includes("SECRET_CALL_MARKER"), "script hidden when collapsed");
assert.equal(renderText(callComp, 80).split("\n").length, 1, "call view is one line");
assertFits(callComp);
assert.equal(renderText(renderers.renderCall({ code: "" }, theme, ctx())).trimEnd(), "codemode [invalid arg]");
assert.match(renderText(renderers.renderCall({ code: "x" }, theme, ctx())), /1 line\b/);
assert.equal(baseCalls, 0, "collapsed rendering never touches the original renderer");

// --- collapsed result -----------------------------------------------------
const before = JSON.stringify(fixture);
const resultComp = renderers.renderResult(fixture, { expanded: false, isPartial: false }, theme, ctx());
const resultText = renderText(resultComp);
assert.equal(JSON.stringify(fixture), before, "display only: result untouched");
assert.ok(!resultText.includes('{"pattern"'), "raw argument JSON is summarized");
assert.match(resultText, /business/);
assert.match(resultText, /contracts\/source\/\*\*/);
assert.match(resultText, /limit=12/);
assert.match(resultText, /offset=1/);
assert.equal((resultText.match(/✓/g) ?? []).length, 4, "one row per nested call");
assert.match(resultText, /4ms/);
assert.ok(!resultText.includes("Script completed"), "header stripped");
const longArgFixture = {
	...fixture,
	details: {
		calls: [
			{ ...calls[0], args: JSON.stringify({ path: "node_modules/@earendil-works", pattern: "function truncateToVisualLines" }) },
			{ ...calls[0], args: JSON.stringify({ path: "long-path/".repeat(20) }) },
		],
	},
};
const longArgLines = renderers
	.renderResult(longArgFixture, { expanded: false, isPartial: false }, theme, ctx())
	.render(200);
assert.ok(
	longArgLines.every((line) => !line.includes("\x1b[0m")),
	"argument truncation must not reset the tool shell background",
);
const lines = resultText.split("\n");
const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
const betaIdx = lines.findIndex((l) => l.includes("beta"));
assert.ok(alphaIdx >= 0 && betaIdx >= 0 && alphaIdx !== betaIdx, "escaped newline becomes a real line break");
assert.ok(resultText.includes("kept\\nraw"), "literal backslash-n stays on one line");
assert.ok(!resultText.includes("kept\nraw"), "literal backslash-n is not split");
assert.match(resultText, /==> text 1\/2 <==/, "non-JSON lines pass through");
assertFits(resultComp);

// partial results show calls but no output yet
const partialText = renderText(
	renderers.renderResult(fixture, { expanded: false, isPartial: true }, theme, ctx({ isPartial: true })),
);
assert.ok(partialText.includes("fffind"));
assert.ok(!partialText.includes("done"));

// long outputs get a hint plus the saved full-output path
const longFixture = {
	content: [
		{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text", text: "x\n".repeat(200) },
	],
	details: { calls: [], fullOutputPath: "/tmp/pi-codemode-full.txt" },
	isError: false,
};
const longText = renderText(renderers.renderResult(longFixture, { expanded: false, isPartial: false }, theme, ctx()));
assert.match(longText, /more lines/);
assert.match(longText, /Full output: \/tmp\/pi-codemode-full\.txt/);
assert.ok(longText.split("\n").length <= 12, "preview stays bounded");

// more than 8 calls collapse from the front
const manyCalls = {
	...fixture,
	details: { calls: Array.from({ length: 12 }, (_, i) => ({ ...calls[0], id: String(i) })) },
};
assert.match(
	renderText(renderers.renderResult(manyCalls, { expanded: false, isPartial: false }, theme, ctx())),
	/4 earlier calls/,
);

// --- errors stay visible above the preview --------------------------------
const badFixture = {
	content: [
		{ type: "text", text: "Script failed\nWall time 2.0 seconds\nOutput:\n" },
		{ type: "text", text: "noise\n".repeat(200) },
		{ type: "text", text: "Script error:\nBoom: missing module 'bun:ffi'" },
	],
	details: { calls: [{ id: "1", name: "bash", args: '{"command":"x"}', status: "error", error: "Boom", durationMs: 3 }] },
	isError: true,
};
const badLines = renderText(
	renderers.renderResult(badFixture, { expanded: false, isPartial: false }, theme, ctx({ isError: true })),
).split("\n");
assert.match(badLines.slice(0, 2).join("\n"), /Script error/);
assert.ok(badLines.slice(0, 3).some((l) => l.includes("missing module")), "error message visible at the top");
assert.ok(badLines.some((l) => l.includes("noise")), "output preview still shown");
assert.ok(badLines.some((l) => l.includes("✗")), "failed call row is visible");
assert.ok(badLines.some((l) => l.includes("Boom")), "failed call error is visible");
assertFits(renderers.renderResult(badFixture, { expanded: false, isPartial: false }, theme, ctx({ isError: true })));

// An early failure must survive the call-row budget and long argument summaries.
const earlyFailure = {
	...fixture,
	details: { calls: [{ ...calls[0], status: "error", args: JSON.stringify({ path: "长路径/".repeat(80) }), error: "EARLY_FAILURE\nDETAIL_AT_END" }, ...manyCalls.details.calls] },
};
const earlyComponent = renderers.renderResult(earlyFailure, { expanded: false, isPartial: false }, theme, ctx());
assert.match(renderText(earlyComponent), /EARLY_FAILURE/);
assert.match(renderText(earlyComponent), /DETAIL_AT_END/);
assertFits(earlyComponent);
const longError = {
	...badFixture,
	content: [{ type: "text", text: "Script error:\n" + "stack frame\n".repeat(20) + "FINAL_ERROR_REASON" }],
};
assert.match(renderText(renderers.renderResult(longError, { expanded: false, isPartial: false }, theme, ctx({ isError: true }))), /FINAL_ERROR_REASON/);
const ordinaryMarker = { ...fixture, content: [{ type: "text", text: "Script error:\nordinary output" }] };
assert.ok(!renderText(renderers.renderResult(ordinaryMarker, { expanded: false, isPartial: false }, theme, ctx())).includes("Script error\n"), "successful output is not misclassified as a script error");

// --- expanded delegates to Pi's original renderer -------------------------
const withNative = resolver("codemode", () => codemodeRenderers);
let c = renderers.renderCall(callArgs, theme, ctx());
c = withNative.renderCall(callArgs, theme, ctx({ lastComponent: c, expanded: true }));
assert.match(renderText(c, 100), /SECRET_CALL_MARKER/, "expanded shows the full script");
assert.equal(baseCalls, 0);
c = withNative.renderCall(callArgs, theme, ctx({ lastComponent: c, expanded: false }));
assert.ok(!renderText(c, 100).includes("SECRET_CALL_MARKER"), "collapsing again re-hides the script");
assertFits(c);

let r = withNative.renderResult(fixture, { expanded: true, isPartial: false }, theme, ctx({ expanded: true }));
const rawResult = renderText(r, 140);
assert.ok(rawResult.includes("alpha\\nbeta"), "expanded keeps raw output for debugging");
assert.ok(rawResult.includes('{"pattern":"business","limit":12}'), "expanded keeps raw call arguments");
r = withNative.renderResult(fixture, { expanded: false, isPartial: false }, theme, ctx({ lastComponent: r, expanded: false }));
assert.ok(!renderText(r, 140).includes('{"pattern"'), "collapsing again summarizes calls");
assertFits(r);

console.log("PASS: resolver wiring, compact call/result rendering, error visibility, width bounds, expanded delegation");
