/**
 * Codex CLI adapter — a key-free transport that runs every call through the
 * operator's locally installed, locally logged-in `codex` CLI (ChatGPT/Codex
 * subscription). No API key is read or needed.
 *
 * Model IDs look like "codex:gpt-5.6-sol"; the prefix selects this adapter
 * (routing.ts) and is stripped before the name is handed to `codex exec -m`.
 *
 * ONE CALL = ONE PROCESS
 * ----------------------
 * Every request spawns
 *
 *   codex exec -m <model> -c model_reasoning_effort=<effort> -s read-only
 *     --skip-git-repo-check --json --output-schema <schema> -o <reply> -
 *
 * with the whole prompt on STDIN (never on the command line), cwd set to a
 * fresh empty temp directory that is deleted afterwards, and the reply read
 * back from the `-o` file. The reply is always JSON constrained by
 * `--output-schema`, which wants OpenAI-strict schemas (every object closed,
 * every property required, optional = nullable).
 *
 * TOOL USE IS EMULATED
 * --------------------
 * `codex exec` has no client-tool protocol, so completeWithTools renders the
 * system prompt, the full message history (prior tool_use / tool_result blocks
 * included) and the tool definitions as text, and asks for
 *
 *   { text: string, tool_calls: [{ name: string, input_json: string }] }
 *
 * Each call becomes an Anthropic `tool_use` block with a generated id, so
 * toolUseLoop runs unchanged: it pushes our `rawContent` back as the assistant
 * turn, answers with `tool_result` blocks, and the next call renders both as
 * text again. Calls naming an unknown tool or carrying unparseable input_json
 * are NOT handed to the loop (agents' executeTool implementations differ in
 * how they treat unknown names, and some throw): the adapter re-asks Codex
 * once with the problems spelled out, and if the retry is still invalid, drops
 * the invalid calls (keeping a note of them in the turn's text). A turn left
 * with no valid calls ends with stopReason "end_turn".
 *
 * Anthropic SERVER tools (web_search) cannot be emulated and are dropped from
 * the tool list with a note in the prompt, so agents that always carry one
 * (the Steward) still run, without web search. Containers are never returned.
 *
 * Environment:
 *   CODEX_BIN               executable (default "codex"; a .js/.mjs/.cjs path
 *                           is run with the current node)
 *   CODEX_REASONING_EFFORT  passed as model_reasoning_effort (default "medium")
 *   CODEX_TIMEOUT_MS        per-call timeout, process tree killed (default 600000)
 *
 * `maxTokens` and `temperature` are not forwarded: `codex exec` has no flags
 * for them.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

import { isServerTool, toStrictJsonSchema, toolResultText } from "./openai-dialect.js";
import { logCacheUsage, recordCallUsage, type ProviderUsage } from "./metering.js";
import { CODEX_MODEL_PREFIX } from "./routing.js";
import type {
  CompleteRequest,
  CompletionResult,
  LlmContentBlock,
  LlmMessage,
  ProviderAdapter,
  StructuredRequest,
  ToolCompleteRequest,
  ToolCompletionResult,
  ToolUse,
} from "./types.js";

/** Hard ceiling on the rendered prompt, in characters. */
export const CODEX_MAX_PROMPT_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_EFFORT = "medium";
/** Keep only this much of stderr for error messages. */
const STDERR_TAIL_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Model id / env
// ---------------------------------------------------------------------------

/** "codex:gpt-5.6-sol" → "gpt-5.6-sol", validated to a safe charset. */
export function codexModelName(modelId: string): string {
  const id = modelId.trim();
  const name = id.startsWith(CODEX_MODEL_PREFIX)
    ? id.slice(CODEX_MODEL_PREFIX.length)
    : id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid Codex model id "${modelId}": expected "codex:<model>" where ` +
        `<model> uses only letters, digits, ".", "_" and "-".`
    );
  }
  return name;
}

function reasoningEffort(): string {
  const effort = (process.env.CODEX_REASONING_EFFORT ?? DEFAULT_EFFORT).trim();
  if (!/^[a-z]+$/.test(effort)) {
    throw new Error(
      `CODEX_REASONING_EFFORT="${effort}" is not a valid effort level ` +
        `(expected e.g. "minimal", "low", "medium", "high").`
    );
  }
  return effort;
}

function timeoutMs(): number {
  const raw = process.env.CODEX_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CODEX_TIMEOUT_MS="${raw}" must be a positive number of milliseconds.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Spawning (incl. the Windows npm .cmd shim)
// ---------------------------------------------------------------------------

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Set when the command line must be passed to cmd.exe verbatim. */
  windowsVerbatimArguments?: boolean;
}

/** Find `name` on PATH (honouring PATHEXT on Windows). */
function whichSync(name: string): string | null {
  const isWin = process.platform === "win32";
  // On Windows a bare name only runs with a PATHEXT extension; npm also drops
  // an extensionless POSIX sh script next to codex.cmd, which must NOT win.
  const exts =
    isWin && !extname(name)
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry: skip
      }
    }
  }
  return null;
}

/**
 * Extract the JS entry point from an npm-generated `.cmd` shim, e.g.
 * `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*` → an absolute path.
 */
export function parseNpmCmdShim(shimText: string, shimPath: string): string | null {
  const m = shimText.match(/"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i);
  if (!m) return null;
  return join(dirname(shimPath), m[1]!);
}

/** Quote one argument for `cmd.exe /d /s /c "..."`. Args are pre-validated. */
export function quoteForCmd(arg: string): string {
  if (/["%^&|<>!\r\n]/.test(arg)) {
    throw new Error(`Refusing to pass an argument with cmd.exe metacharacters: ${arg}`);
  }
  return `"${arg}"`;
}

/**
 * Decide how to start `bin` with `args`. Never places user content on the
 * command line — callers pass only the model name, effort, and temp paths.
 */
export function planSpawn(bin: string, args: string[]): SpawnPlan {
  const ext = extname(bin).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  if (process.platform !== "win32") return { command: bin, args };

  const resolved =
    isAbsolute(bin) || bin.includes("\\") || bin.includes("/") ? bin : whichSync(bin) ?? bin;
  const rext = extname(resolved).toLowerCase();
  if (rext !== ".cmd" && rext !== ".bat") return { command: resolved, args };

  // npm shim: run the JS behind it directly with node — no shell involved.
  try {
    const script = parseNpmCmdShim(readFileSync(resolved, "utf8"), resolved);
    if (script && existsSync(script)) {
      const bundledNode = join(dirname(resolved), "node.exe");
      const node = existsSync(bundledNode) ? bundledNode : process.execPath;
      return { command: node, args: [script, ...args] };
    }
  } catch {
    // fall through to cmd.exe
  }

  // Generic .cmd/.bat: go through cmd.exe with every argument quoted.
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => undefined);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/** Token usage pulled from the `--json` event stream; zeros when absent. */
export function parseCodexEvents(stdout: string): {
  usage: ProviderUsage;
  errors: string[];
} {
  let input = 0;
  let cached = 0;
  let output = 0;
  const errors: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof ev.type === "string" ? ev.type : "";
    const usage = ev.usage as Record<string, unknown> | undefined;
    if (type === "turn.completed" && usage && typeof usage === "object") {
      input += num(usage.input_tokens);
      cached += num(usage.cached_input_tokens);
      output += num(usage.output_tokens);
    }
    if (type === "error" || type === "turn.failed") {
      const msg =
        (typeof ev.message === "string" && ev.message) ||
        (ev.error && typeof (ev.error as { message?: unknown }).message === "string"
          ? (ev.error as { message: string }).message
          : "");
      if (msg) errors.push(msg);
    }
  }
  return {
    usage: {
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      cacheReadTokens: cached,
      cacheCreationTokens: 0,
    },
    errors,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Run one `codex exec` with `prompt` on stdin, constrained to `schema`.
 * Returns the parsed JSON reply. Always cleans up its temp directory.
 */
async function runCodex(
  modelId: string,
  prompt: string,
  schema: Record<string, unknown>
): Promise<{ reply: unknown; usage: ProviderUsage }> {
  if (prompt.length > CODEX_MAX_PROMPT_CHARS) {
    throw new Error(
      `Codex request for "${modelId}" is ${prompt.length.toLocaleString("en-US")} ` +
        `characters, over the ${CODEX_MAX_PROMPT_CHARS.toLocaleString("en-US")}-` +
        `character limit of the codex transport. Reduce the input size.`
    );
  }
  const model = codexModelName(modelId);
  const effort = reasoningEffort();
  const timeout = timeoutMs();
  const bin = process.env.CODEX_BIN?.trim() || "codex";

  const root = await mkdtemp(join(tmpdir(), "minerval-codex-"));
  try {
    // cwd stays EMPTY (no AGENTS.md, no repo); schema/reply live beside it.
    const work = join(root, "work");
    await mkdir(work);
    const schemaFile = join(root, "schema.json");
    const replyFile = join(root, "reply.json");
    await writeFile(schemaFile, JSON.stringify(schema), "utf8");

    const args = [
      "exec",
      "-m",
      model,
      "-c",
      `model_reasoning_effort=${effort}`,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      schemaFile,
      "-o",
      replyFile,
      "-",
    ];
    const plan = planSpawn(bin, args);

    const { code, stdout, stderrTail, timedOut } = await new Promise<{
      code: number | null;
      stdout: string;
      stderrTail: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, {
        cwd: work,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: process.platform !== "win32",
      });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeout);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        out += d;
      });
      child.stderr.on("data", (d: string) => {
        err = (err + d).slice(-STDERR_TAIL_CHARS);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Could not start the Codex CLI ("${bin}"): ${e.message}. Install it ` +
              `(npm i -g @openai/codex), log in, or set CODEX_BIN.`
          )
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: out, stderrTail: err, timedOut });
      });
      // The prompt goes over stdin only. Ignore EPIPE if codex exits early —
      // the exit code / stderr carry the real error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt, "utf8");
    });

    const events = parseCodexEvents(stdout);
    if (timedOut) {
      throw new Error(
        `Codex call for "${modelId}" timed out after ${timeout} ms ` +
          `(CODEX_TIMEOUT_MS); the process tree was killed.`
      );
    }
    if (code !== 0) {
      const detail = [...events.errors, stderrTail.trim()].filter(Boolean).join(" | ");
      throw new Error(
        `Codex CLI exited with code ${code} for "${modelId}"` +
          (detail ? `: ${detail.slice(-2000)}` : ".")
      );
    }
    let text: string;
    try {
      text = await readFile(replyFile, "utf8");
    } catch {
      throw new Error(
        `Codex CLI produced no reply file for "${modelId}"` +
          (events.errors.length ? `: ${events.errors.join(" | ")}` : ".")
      );
    }
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      throw new Error(
        `Codex reply for "${modelId}" was not valid JSON: ${text.slice(0, 500)}`
      );
    }
    return { reply, usage: events.usage };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined
    );
  }
}

// ---------------------------------------------------------------------------
// Strict schemas
// ---------------------------------------------------------------------------

/** Add "null" to a schema node's accepted types. */
function makeNullable(node: unknown): unknown {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const n = { ...(node as Record<string, unknown>) };
  if (typeof n.type === "string") {
    if (n.type !== "null") n.type = [n.type, "null"];
  } else if (Array.isArray(n.type)) {
    if (!n.type.includes("null")) n.type = [...n.type, "null"];
  } else if (Array.isArray(n.anyOf)) {
    n.anyOf = [...n.anyOf, { type: "null" }];
  } else {
    return { anyOf: [n, { type: "null" }] };
  }
  if (Array.isArray(n.enum) && !n.enum.includes(null)) n.enum = [...n.enum, null];
  return n;
}

/**
 * The OpenAI-strict form Codex's --output-schema needs: every object closed,
 * every property required, and properties the caller had left OPTIONAL turned
 * nullable (so "absent" is still expressible). Idempotent for schemas that are
 * already strict.
 */
export function toCodexStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toCodexStrictSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const node = { ...(schema as Record<string, unknown>) };
  if (node.properties && typeof node.properties === "object") {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties as Record<string, unknown>)) {
      const strict = toCodexStrictSchema(value);
      next[key] = required.has(key) ? strict : makeNullable(strict);
    }
    node.properties = next;
  }
  if (node.items !== undefined) node.items = toCodexStrictSchema(node.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map(toCodexStrictSchema);
  }
  for (const key of ["$defs", "definitions"] as const) {
    if (node[key] && typeof node[key] === "object") {
      node[key] = Object.fromEntries(
        Object.entries(node[key] as Record<string, unknown>).map(([k, v]) => [
          k,
          toCodexStrictSchema(v),
        ])
      );
    }
  }
  // Closes objects and fills `required` (shared with the OpenAI path).
  return toStrictJsonSchema(node);
}

/**
 * Undo the nullable-for-optional transform on a reply: drop `null` values for
 * properties the ORIGINAL schema did not require, so callers see them absent.
 */
export function stripOptionalNulls(value: unknown, schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return value;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(value)) {
    return s.items !== undefined ? value.map((v) => stripOptionalNulls(v, s.items)) : value;
  }
  if (value === null || typeof value !== "object" || !s.properties) return value;
  const props = s.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null && !required.has(k) && k in props) continue;
    out[k] = k in props ? stripOptionalNulls(v, props[k]) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

const PREAMBLE =
  "You are serving as a plain language model behind an API. Do NOT run shell " +
  "commands, read or write files, browse, or use any tool of your own; there " +
  "is nothing in your working directory. Answer ONLY with a JSON object that " +
  "matches the required output schema.";

function renderBlock(
  block: Anthropic.ContentBlockParam | LlmContentBlock,
  toolNames: Map<string, string>
): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use": {
      toolNames.set(block.id, block.name);
      return (
        `[tool call id=${block.id}] ${block.name}\n` +
        `input: ${JSON.stringify(block.input ?? {})}`
      );
    }
    case "tool_result": {
      const name = toolNames.get(block.tool_use_id);
      return (
        `[tool result for id=${block.tool_use_id}${name ? ` (${name})` : ""}` +
        `${block.is_error ? ", ERROR" : ""}]\n` +
        toolResultText(block.content)
      );
    }
    default:
      // Thinking, server-tool and other Anthropic-only blocks have no meaning
      // on this transport; keep a compact JSON trace rather than failing.
      return `[${block.type}] ${JSON.stringify(block).slice(0, 2000)}`;
  }
}

/** Render a conversation as text, oldest message first. */
export function renderConversation(messages: LlmMessage[]): string {
  const toolNames = new Map<string, string>();
  const parts: string[] = [];
  for (const m of messages) {
    const body =
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => renderBlock(b, toolNames)).join("\n\n");
    parts.push(`<<<${m.role.toUpperCase()}>>>\n${body}`);
  }
  return parts.join("\n\n");
}

function renderPrompt(opts: {
  system?: string;
  messages: LlmMessage[];
  extra?: string;
}): string {
  const sections = [PREAMBLE];
  if (opts.system) sections.push(`=== SYSTEM INSTRUCTIONS ===\n${opts.system}`);
  if (opts.extra) sections.push(opts.extra);
  sections.push(`=== CONVERSATION ===\n${renderConversation(opts.messages)}`);
  sections.push(
    "=== YOUR TURN ===\nWrite the next ASSISTANT turn now, as JSON matching the output schema."
  );
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool-use emulation
// ---------------------------------------------------------------------------

export const TOOL_TURN_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          input_json: { type: "string" },
        },
        required: ["name", "input_json"],
        additionalProperties: false,
      },
    },
  },
  required: ["text", "tool_calls"],
  additionalProperties: false,
} as const;

const TEXT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;

function renderTools(tools: Anthropic.Tool[], droppedServerTools: string[]): string {
  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.input_schema,
  }));
  let s =
    "=== TOOLS ===\n" +
    "You are the reasoning step of a tool-using agent. The tools below are " +
    "executed by the caller, not by you. To call tools, list them in " +
    '"tool_calls": "name" is the exact tool name and "input_json" is a ' +
    "JSON-encoded OBJECT (as a string) matching that tool's input_schema. You " +
    "may list several calls; they run in order and their results come back to " +
    "you in the next turn as [tool result ...] entries. Put any reasoning or " +
    'reply for the user in "text". When you need no further tools, return ' +
    '"tool_calls": [] and your final answer in "text".\n\n' +
    `Available tools (JSON):\n${JSON.stringify(defs, null, 2)}`;
  if (droppedServerTools.length > 0) {
    s +=
      `\n\nNote: the following tools are NOT available in this environment: ` +
      `${droppedServerTools.join(", ")}. Work without them.`;
  }
  return s;
}

interface ParsedToolTurn {
  text: string;
  toolUses: ToolUse[];
  problems: string[];
}

function parseToolTurn(reply: unknown, toolNames: Set<string>): ParsedToolTurn {
  const r = (reply ?? {}) as { text?: unknown; tool_calls?: unknown };
  const text = typeof r.text === "string" ? r.text : "";
  const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
  const toolUses: ToolUse[] = [];
  const problems: string[] = [];
  calls.forEach((c, i) => {
    const call = (c ?? {}) as { name?: unknown; input_json?: unknown };
    const name = typeof call.name === "string" ? call.name : "";
    if (!toolNames.has(name)) {
      problems.push(`tool_calls[${i}]: unknown tool "${name}"`);
      return;
    }
    const raw = typeof call.input_json === "string" ? call.input_json.trim() : "";
    let input: unknown;
    try {
      input = raw === "" ? {} : JSON.parse(raw);
    } catch {
      problems.push(`tool_calls[${i}] (${name}): input_json is not valid JSON`);
      return;
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      problems.push(`tool_calls[${i}] (${name}): input_json must encode a JSON object`);
      return;
    }
    toolUses.push({
      id: `toolu_codex_${randomUUID().replace(/-/g, "")}`,
      name,
      input: input as Record<string, unknown>,
    });
  });
  return { text, toolUses, problems };
}

function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: 0,
  };
}

function meter(model: string, usage: ProviderUsage): void {
  recordCallUsage("codex", model, usage);
  logCacheUsage("codex", usage);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const codexAdapter: ProviderAdapter = {
  name: "codex",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    const prompt = renderPrompt({ system: req.system, messages: req.messages });
    const { reply, usage } = await runCodex(req.model, prompt, TEXT_SCHEMA);
    meter(req.model, usage);
    const text = (reply as { text?: unknown })?.text;
    return {
      content: typeof text === "string" ? text : "",
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: "end_turn",
      container: null,
    };
  },

  async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
    const clientTools = req.tools.filter((t) => !isServerTool(t)) as Anthropic.Tool[];
    const dropped = req.tools
      .filter(isServerTool)
      .map((t) => (t as { name?: string; type?: string }).name ?? (t as { type: string }).type);
    const toolNames = new Set(clientTools.map((t) => t.name));
    const toolsText = renderTools(clientTools, dropped);

    let prompt = renderPrompt({ system: req.system, messages: req.messages, extra: toolsText });
    let first = await runCodex(req.model, prompt, TOOL_TURN_SCHEMA);
    let usage = first.usage;
    let turn = parseToolTurn(first.reply, toolNames);

    // One repair round for unknown tools / malformed input_json.
    if (turn.problems.length > 0) {
      prompt +=
        "\n\n=== CORRECTION ===\nYour previous answer was:\n" +
        JSON.stringify(first.reply) +
        "\nIt had these problems:\n- " +
        turn.problems.join("\n- ") +
        "\nAnswer again with the corrected JSON (only tools from the list, " +
        "input_json a JSON-encoded object).";
      const second = await runCodex(req.model, prompt, TOOL_TURN_SCHEMA);
      usage = addUsage(usage, second.usage);
      turn = parseToolTurn(second.reply, toolNames);
      if (turn.problems.length > 0) {
        turn.text +=
          (turn.text ? "\n\n" : "") +
          `[codex transport: dropped invalid tool calls — ${turn.problems.join("; ")}]`;
      }
    }
    meter(req.model, usage);

    const rawContent: LlmContentBlock[] = [];
    if (turn.text) {
      rawContent.push({ type: "text", text: turn.text, citations: null } as LlmContentBlock);
    }
    for (const tu of turn.toolUses) {
      rawContent.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
      } as unknown as LlmContentBlock);
    }

    return {
      content: turn.text,
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: turn.toolUses.length > 0 ? "tool_use" : "end_turn",
      toolUses: turn.toolUses,
      rawContent,
      container: null,
    };
  },

  async completeStructured<T>(req: StructuredRequest): Promise<T> {
    const prompt = renderPrompt({
      system: req.system,
      messages: req.messages,
      extra: `=== OUTPUT ===\nRespond with a "${req.schemaName}" object.`,
    });
    const strict = toCodexStrictSchema(req.schema) as Record<string, unknown>;
    const { reply, usage } = await runCodex(req.model, prompt, strict);
    meter(req.model, usage);
    return stripOptionalNulls(reply, req.schema) as T;
  },
};

/** Exposed for tests. */
export const __test = { renderPrompt, parseToolTurn };
