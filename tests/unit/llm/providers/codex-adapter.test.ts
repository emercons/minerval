import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

// No network, no real codex: CODEX_BIN points at a node script that plays
// `codex exec` (fixtures/fake-codex.mjs), and the meters are mocked.
const meterLlmUsage = vi.fn();
const recordUsage = vi.fn();

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterLlmUsage: (...args: unknown[]) => meterLlmUsage(...args),
}));

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: (...args: unknown[]) => recordUsage(...args),
}));

import {
  CODEX_MAX_PROMPT_CHARS,
  codexAdapter,
  codexModelName,
  parseCodexEvents,
  parseNpmCmdShim,
  planSpawn,
  quoteForCmd,
  stripOptionalNulls,
  toCodexStrictSchema,
} from "../../../../src/llm/providers/codex.js";
import { toolUseLoop } from "../../../../src/llm/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-codex.mjs");
const MODEL = "codex:gpt-5.6-sol";

let dir: string;
const savedEnv = { ...process.env };

function scenario(s: Record<string, unknown>): void {
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(s));
}

function call(n = 0): {
  argv: string[];
  stdin: string;
  cwd: string;
  cwdEntries: string[];
  env: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(dir, `call-${n}.json`), "utf8"));
}

function callCount(): number {
  const f = join(dir, "count.txt");
  return existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-codex-test-"));
  process.env.CODEX_BIN = FAKE;
  process.env.CODEX_FAKE_DIR = dir;
  delete process.env.CODEX_REASONING_EFFORT;
  delete process.env.CODEX_TIMEOUT_MS;
  meterLlmUsage.mockReset();
  recordUsage.mockReset();
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

const tools: Anthropic.Tool[] = [
  {
    name: "search",
    description: "Search the graph",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "submit",
    description: "Submit the decision",
    input_schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    },
  },
];

describe("codexAdapter — the process contract", () => {
  it("spawns codex exec with the documented flags, prompt on stdin, empty cwd", async () => {
    scenario({ replies: [JSON.stringify({ text: "hello" })] });
    process.env.CODEX_REASONING_EFFORT = "high";
    const result = await codexAdapter.complete({
      model: MODEL,
      maxTokens: 100,
      system: "Be brief.",
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(result.content).toBe("hello");
    expect(result.stopReason).toBe("end_turn");

    const c = call();
    expect(c.argv.slice(0, 8)).toEqual([
      "exec",
      "-m",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "-s",
      "read-only",
      "--skip-git-repo-check",
    ]);
    expect(c.argv).toContain("--json");
    expect(c.argv).toContain("--output-schema");
    expect(c.argv.at(-1)).toBe("-");
    // The prompt is never on the command line.
    expect(c.argv.join(" ")).not.toContain("Say hello");
    expect(c.stdin).toContain("Say hello");
    expect(c.stdin).toContain("Be brief.");
    expect(c.cwdEntries).toEqual([]);
    // The schema handed to codex is the {text} schema.
    const schemaPath = c.argv[c.argv.indexOf("--output-schema") + 1]!;
    expect(schemaPath).toBeTruthy();
    // The temp dir (cwd and schema) is deleted afterwards.
    expect(existsSync(c.cwd)).toBe(false);
    expect(existsSync(schemaPath)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "runs a non-npm .cmd CODEX_BIN through cmd.exe with quoted arguments",
    async () => {
      scenario({ replies: [JSON.stringify({ text: "via cmd" })] });
      const wrapper = join(dir, "wrap.cmd");
      writeFileSync(wrapper, `@"${process.execPath}" "${FAKE}" %*\r\n`);
      process.env.CODEX_BIN = wrapper;
      expect(planSpawn(wrapper, ["exec"]).windowsVerbatimArguments).toBe(true);
      const r = await codexAdapter.complete({
        model: MODEL,
        maxTokens: 10,
        messages: [{ role: "user", content: 'stdin with "quotes" & ampersands' }],
      });
      expect(r.content).toBe("via cmd");
      expect(call().argv).toContain("model_reasoning_effort=medium");
      expect(call().stdin).toContain('stdin with "quotes" & ampersands');
    }
  );

  it("hands codex an allowlisted environment: no keys, tokens, secrets or DB URLs", async () => {
    scenario({ replies: [JSON.stringify({ text: "x" })] });
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "sk-ant-leak",
      OPENAI_API_KEY: "sk-openai-leak",
      OPENROUTER_API_KEY: "sk-or-leak",
      CODEX_API_KEY: "sk-codex-leak",
      DATABASE_URL: "postgresql://u:pw@db/x",
      CORPUS_DATABASE_URL: "postgresql://u:pw@db/corpus",
      GITHUB_TOKEN: "ghp_leak",
      STRIPE_SECRET: "leak",
      DB_PASSWORD: "leak",
      SOME_RANDOM_SETTING: "not needed",
      CODEX_HOME: join(dir, "codex-home"),
      LC_ALL: "C",
    });
    await codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] });
    const env = call().env;
    const names = Object.keys(env).map((k) => k.toUpperCase());
    for (const leaked of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "CODEX_API_KEY",
      "DATABASE_URL",
      "CORPUS_DATABASE_URL",
      "GITHUB_TOKEN",
      "STRIPE_SECRET",
      "DB_PASSWORD",
      "SOME_RANDOM_SETTING",
    ]) {
      expect(names).not.toContain(leaked);
    }
    expect(JSON.stringify(env)).not.toMatch(/leak|pw@db/);
    expect(names).toContain("PATH");
    expect(env.CODEX_HOME).toBe(join(dir, "codex-home"));
    expect(env.LC_ALL).toBe("C");
    // User config (MCP servers, plugins, notify hooks) is not loaded.
    expect(call().argv).toContain("--ignore-user-config");
  });

  it("defaults reasoning effort to medium", async () => {
    scenario({ replies: [JSON.stringify({ text: "x" })] });
    await codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(call().argv).toContain("model_reasoning_effort=medium");
  });

  it("meters usage from the --json event stream (cost table prices codex at 0)", async () => {
    scenario({ replies: [JSON.stringify({ text: "x" })] });
    const r = await codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(r.usage).toEqual({ inputTokens: 60, outputTokens: 20 });
    expect(meterLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", model: MODEL, inputTokens: 60, cacheReadTokens: 40 })
    );
  });

  it("reports zero usage, without throwing, when the stream has none", async () => {
    scenario({ replies: [JSON.stringify({ text: "x" })], noUsage: true });
    const r = await codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("surfaces a non-zero exit with stderr", async () => {
    scenario({ exitCode: 3, stderr: "not logged in" });
    await expect(
      codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/exited with code 3.*not logged in/);
  });

  it("times out, kills the process, and cleans up", async () => {
    scenario({ replies: [JSON.stringify({ text: "late" })], delayMs: 30_000 });
    process.env.CODEX_TIMEOUT_MS = "500";
    const started = Date.now();
    await expect(
      codexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/timed out after 500 ms/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(call().cwd)).toBe(false);
  }, 20_000);

  it("refuses an oversize request before spawning anything", async () => {
    scenario({ replies: [JSON.stringify({ text: "x" })] });
    await expect(
      codexAdapter.complete({
        model: MODEL,
        maxTokens: 10,
        messages: [{ role: "user", content: "a".repeat(CODEX_MAX_PROMPT_CHARS + 1) }],
      })
    ).rejects.toThrow(/over the 1,000,000-character limit/);
    expect(callCount()).toBe(0);
  });

  it("rejects model names that are unsafe to pass to the CLI", () => {
    expect(codexModelName("codex:gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(() => codexModelName("codex:gpt 5 & calc")).toThrow(/Invalid Codex model id/);
    expect(() => codexModelName("codex:")).toThrow(/Invalid Codex model id/);
  });
});

describe("codexAdapter.completeStructured", () => {
  it("sends a strict schema and parses the reply, dropping nulls for optional fields", async () => {
    scenario({ replies: [JSON.stringify({ verdict: "yes", note: null })] });
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" }, note: { type: "string" } },
      required: ["verdict"],
    };
    const result = await codexAdapter.completeStructured<{ verdict: string; note?: string }>({
      model: MODEL,
      maxTokens: 100,
      schema,
      schemaName: "Verdict",
      messages: [{ role: "user", content: "Judge it" }],
    });
    expect(result).toEqual({ verdict: "yes" });
    expect(call().stdin).toContain('"Verdict"');
  });

  it("throws on a reply that is not JSON", async () => {
    scenario({ replies: ["definitely not json"] });
    await expect(
      codexAdapter.completeStructured({
        model: MODEL,
        maxTokens: 100,
        schema: { type: "object", properties: {}, required: [], additionalProperties: false },
        schemaName: "X",
        messages: [{ role: "user", content: "x" }],
      })
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("toCodexStrictSchema", () => {
  it("closes objects, requires every property and makes optional ones nullable", () => {
    const strict = toCodexStrictSchema({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer", enum: [1, 2] },
        c: { type: "object", properties: { d: { type: "string" } } },
        e: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["a"],
    }) as Record<string, any>;
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["a", "b", "c", "e"]);
    expect(strict.properties.a).toEqual({ type: "string" });
    expect(strict.properties.b).toEqual({ type: ["integer", "null"], enum: [1, 2, null] });
    expect(strict.properties.c.type).toEqual(["object", "null"]);
    expect(strict.properties.c.additionalProperties).toBe(false);
    expect(strict.properties.c.properties.d.type).toEqual(["string", "null"]);
    expect(strict.properties.e.anyOf).toContainEqual({ type: "null" });
  });

  it("leaves an already-strict schema unchanged", () => {
    const s = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    };
    expect(toCodexStrictSchema(s)).toEqual(s);
  });

  it("stripOptionalNulls follows local $refs and anyOf branches", () => {
    const schema = {
      $defs: {
        Item: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
        },
      },
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/$defs/Item" } },
        either: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: { x: { type: "string" }, y: { type: "string" } }, required: ["x"] },
          ],
        },
      },
      required: ["items", "either"],
    };
    expect(
      stripOptionalNulls({ items: [{ a: "1", b: null }], either: { x: "x", y: null } }, schema)
    ).toEqual({ items: [{ a: "1" }], either: { x: "x" } });
  });

  it("stripOptionalNulls keeps required nulls and recurses into arrays", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: ["string", "null"] }, b: { type: "string" } },
            required: ["a"],
          },
        },
      },
      required: ["items"],
    };
    expect(stripOptionalNulls({ items: [{ a: null, b: null }] }, schema)).toEqual({
      items: [{ a: null }],
    });
  });
});

describe("codexAdapter.completeWithTools — emulated tool use", () => {
  it("turns tool_calls into tool_use blocks with stopReason tool_use", async () => {
    scenario({
      replies: [
        JSON.stringify({
          text: "Looking it up",
          tool_calls: [{ name: "search", input_json: '{"query":"vaccines"}' }],
        }),
      ],
    });
    const r = await codexAdapter.completeWithTools({
      model: MODEL,
      maxTokens: 100,
      tools,
      system: "You are the matcher.",
      messages: [{ role: "user", content: "Match this claim" }],
    });
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toBe("Looking it up");
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]!.name).toBe("search");
    expect(r.toolUses[0]!.input).toEqual({ query: "vaccines" });
    expect(r.toolUses[0]!.id).toMatch(/^toolu_codex_[0-9a-f]{32}$/);
    expect(r.rawContent).toEqual([
      { type: "text", text: "Looking it up", citations: null },
      { type: "tool_use", id: r.toolUses[0]!.id, name: "search", input: { query: "vaccines" } },
    ]);
    const stdin = call().stdin;
    expect(stdin).toContain("You are the matcher.");
    expect(stdin).toContain('"name": "search"');
    expect(stdin).toContain("Search the graph");
    expect(stdin).toMatch(/Do NOT run shell commands/);
  });

  it("returns end_turn when tool_calls is empty", async () => {
    scenario({ replies: [JSON.stringify({ text: "Done.", tool_calls: [] })] });
    const r = await codexAdapter.completeWithTools({
      model: MODEL,
      maxTokens: 100,
      tools,
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(r.toolUses).toEqual([]);
    expect(r.rawContent).toEqual([{ type: "text", text: "Done.", citations: null }]);
  });

  it("re-asks once on malformed input_json and uses the corrected answer", async () => {
    scenario({
      replies: [
        JSON.stringify({ text: "", tool_calls: [{ name: "search", input_json: "{query: oops" }] }),
        JSON.stringify({ text: "", tool_calls: [{ name: "search", input_json: '{"query":"ok"}' }] }),
      ],
    });
    const r = await codexAdapter.completeWithTools({
      model: MODEL,
      maxTokens: 100,
      tools,
      messages: [{ role: "user", content: "x" }],
    });
    expect(callCount()).toBe(2);
    expect(call(1).stdin).toMatch(/input_json is not valid JSON/);
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolUses[0]!.input).toEqual({ query: "ok" });
    // Usage of both runs is metered as one call.
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("drops calls still invalid after the retry (unknown tool, non-object input)", async () => {
    const bad = JSON.stringify({
      text: "hm",
      tool_calls: [
        { name: "rm_rf", input_json: "{}" },
        { name: "search", input_json: "[1,2]" },
      ],
    });
    scenario({ replies: [bad, bad] });
    const r = await codexAdapter.completeWithTools({
      model: MODEL,
      maxTokens: 100,
      tools,
      messages: [{ role: "user", content: "x" }],
    });
    expect(callCount()).toBe(2);
    expect(r.stopReason).toBe("end_turn");
    expect(r.toolUses).toEqual([]);
    expect(r.content).toMatch(/unknown tool "rm_rf"/);
    expect(r.content).toMatch(/must encode a JSON object/);
  });

  it("drops Anthropic server tools and tells the model", async () => {
    scenario({ replies: [JSON.stringify({ text: "ok", tool_calls: [] })] });
    await codexAdapter.completeWithTools({
      model: MODEL,
      maxTokens: 100,
      tools: [
        ...tools,
        { type: "web_search_20260209", name: "web_search", max_uses: 5 } as unknown as Anthropic.Tool,
      ],
      messages: [{ role: "user", content: "x" }],
    });
    expect(call().stdin).toMatch(/NOT available in this environment: web_search/);
  });

  it("runs a whole toolUseLoop: history with tool_use/tool_result is rendered back", async () => {
    scenario({
      replies: [
        JSON.stringify({ text: "", tool_calls: [{ name: "search", input_json: '{"query":"q1"}' }] }),
        JSON.stringify({ text: "", tool_calls: [{ name: "submit", input_json: '{"verdict":"new"}' }] }),
      ],
    });
    const executed: Array<[string, unknown]> = [];
    let final: unknown = null;
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "Match claim C" }],
      tools,
      model: MODEL,
      maxIterations: 5,
      executeTool: async (name, input) => {
        executed.push([name, input]);
        return name === "search" ? "RESULT: nothing similar" : "ok";
      },
      onFinalTool: (name, input) => {
        if (name === "submit") final = input;
        return name === "submit" ? input : null;
      },
    });
    expect(executed).toEqual([["search", { query: "q1" }]]);
    expect(final).toEqual({ verdict: "new" });
    const second = call(1).stdin;
    expect(second).toContain("Match claim C");
    expect(second).toMatch(/\[tool call id=toolu_codex_[0-9a-f]+\] search/);
    expect(second).toMatch(/\[tool result for id=toolu_codex_[0-9a-f]+ \(search\)\]\nRESULT: nothing similar/);
  });
});

describe("helpers", () => {
  it("parseCodexEvents sums turn.completed usage and collects errors", () => {
    const out = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}',
      "garbage",
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}',
      '{"type":"error","message":"rate limited"}',
    ].join("\n");
    const { usage, errors } = parseCodexEvents(out);
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 4, cacheReadTokens: 4, cacheCreationTokens: 0 });
    expect(errors).toEqual(["rate limited"]);
  });

  it("parseNpmCmdShim finds the JS entry behind an npm .cmd shim", () => {
    const shim =
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
    const script = parseNpmCmdShim(shim, join("C:", "npm", "codex.cmd"));
    expect(script).toBe(join("C:", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(parseNpmCmdShim("@echo off\nfoo.exe %*", "x.cmd")).toBeNull();
  });

  it("planSpawn runs a .js/.mjs CODEX_BIN with the current node", () => {
    expect(planSpawn("/x/fake.mjs", ["exec"])).toEqual({
      command: process.execPath,
      args: ["/x/fake.mjs", "exec"],
    });
  });

  it("quoteForCmd quotes and refuses cmd.exe metacharacters", () => {
    expect(quoteForCmd("C:\\Temp\\a b\\schema.json")).toBe('"C:\\Temp\\a b\\schema.json"');
    expect(() => quoteForCmd('a"b')).toThrow();
    expect(() => quoteForCmd("a&b")).toThrow();
    expect(() => quoteForCmd("%PATH%")).toThrow();
  });
});
