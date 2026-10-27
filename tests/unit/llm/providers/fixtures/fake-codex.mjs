#!/usr/bin/env node
// A stand-in for `codex exec`, used via CODEX_BIN in codex-adapter.test.ts.
// Driven by $CODEX_FAKE_DIR/scenario.json:
//   { replies: string[], delayMs?: number, exitCode?: number,
//     stderr?: string, stdout?: string (with exitCode), noUsage?: boolean }
// Call N (0-based) writes replies[min(N, last)] verbatim to the -o file and
// logs { argv, stdin, cwd, cwdEntries, env } to $CODEX_FAKE_DIR/call-N.json.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CODEX_FAKE_DIR;
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const counterFile = join(dir, "count.txt");
const n = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
writeFileSync(counterFile, String(n + 1));

const argv = process.argv.slice(2);
const outPath = argv[argv.indexOf("-o") + 1];

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  writeFileSync(
    join(dir, `call-${n}.json`),
    JSON.stringify({ argv, stdin, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: process.env })
  );
  setTimeout(() => {
    if (scenario.exitCode) {
      // Flush both streams before exiting so the adapter sees the failure text.
      process.stdout.write(scenario.stdout ?? "", () =>
        process.stderr.write(scenario.stderr ?? "", () => process.exit(scenario.exitCode))
      );
      return;
    }
    if (scenario.stderr) process.stderr.write(scenario.stderr);
    const replies = scenario.replies ?? [];
    const reply = replies[Math.min(n, replies.length - 1)];
    if (reply !== undefined) writeFileSync(outPath, reply);
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n");
    process.stdout.write("not json noise\n");
    if (!scenario.noUsage) {
      process.stdout.write(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
        }) + "\n"
      );
    }
    process.exit(0);
  }, scenario.delayMs ?? 0);
});
