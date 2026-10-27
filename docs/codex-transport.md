# Key-free transport: Codex CLI + local embeddings

Minerval can run with no API keys at all: every model call goes through the
locally installed, logged-in [Codex CLI](https://github.com/openai/codex) (a
ChatGPT/Codex subscription), and embeddings come from a local
OpenAI-compatible server. Nothing changes unless you opt in with the model IDs
and env vars below.

## Model IDs

Any `*_MODEL` variable accepts `codex:<model>`, for example
`codex:gpt-5.6-sol`. The `codex:` prefix routes the call to the Codex adapter
(`src/llm/providers/codex.ts`); it is checked before every other shape rule,
so `codex:openai/gpt-5` is a Codex model, not an OpenRouter one. The part after
the prefix is passed to `codex exec -m` and may only contain letters, digits,
`.`, `_` and `-`.

A fully key-free setup sets every model variable the run touches, including
the extractor fallback (otherwise it defaults to a Claude model):

```sh
MATCHER_MODEL=codex:gpt-5.6-sol
STEWARD_MODEL=codex:gpt-5.6-sol
CURATOR_MODEL=codex:gpt-5.6-sol
EXTRACTOR_MODEL=codex:gpt-5.6-sol
EXTRACTOR_FALLBACK_MODEL=codex:gpt-5.6-sol
GOVERNANCE_MODEL=codex:gpt-5.6-sol
AUDIT_MODEL=codex:gpt-5.6-sol
ARBITRATION_MODEL=codex:gpt-5.6-sol
EXTENSION_MODEL=codex:gpt-5.6-sol
GRANTMAKER_MODEL=codex:gpt-5.6-sol
JUDGE_MODEL=codex:gpt-5.6-sol
EMBEDDING_BASE_URL=http://localhost:1234/v1
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OPENROUTER_API_KEY` can then stay
unset: the keys are only checked when a call is actually routed to their
provider.

## Codex environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | The executable. On Windows the npm `.cmd` shim is resolved to the `codex.js` behind it and run with node, so no shell is involved. A `.js`/`.mjs`/`.cjs` path is run with the current node. |
| `CODEX_REASONING_EFFORT` | `medium` | Passed as `-c model_reasoning_effort=<effort>`. |
| `CODEX_TIMEOUT_MS` | `600000` | Per-call timeout; on expiry the whole process tree is killed and the call fails. |

Each call runs

```
codex exec -m <model> -c model_reasoning_effort=<effort> -s read-only \
  --skip-git-repo-check --json --output-schema <schema> -o <reply> -
```

with the prompt on stdin (never on the command line), in a fresh, empty
temporary directory that is deleted afterwards. Codex still loads your
`~/.codex/config.toml` and global instructions.

## Limits and behaviour

- **Size:** a rendered prompt over 1,000,000 characters is refused with an
  error before anything is spawned.
- **Every reply is JSON** constrained by `--output-schema`. Structured-output
  schemas are made OpenAI-strict automatically: objects are closed, every
  property is required, and properties the caller left optional become
  nullable. A `null` for such a property is removed again before the result is
  returned.
- **`maxTokens` and `temperature` are ignored**, because `codex exec` has no
  flags for them.
- **Cost:** `codex:` models are priced at 0 in `src/llm/pricing.ts`, since the
  subscription is flat-rate, so cost-based budgets never block them. Token
  counts come from the `turn.completed` events of the `--json` stream (zeros if
  absent) and still feed the token and call counters of the budget tracker.
- **Tool use is emulated.** Codex has no client-tool protocol here, so the
  system prompt, the whole conversation (earlier tool calls and tool results
  included) and the tool definitions are rendered as text. The model answers
  `{text, tool_calls: [{name, input_json}]}`, and each call becomes a normal
  `tool_use` block with a generated id, so `toolUseLoop` runs unchanged. If a
  call names an unknown tool or has unparseable `input_json`, Codex is asked
  once more with the problems listed. Calls that are still invalid are dropped,
  with a note in the turn's text. A turn with no valid calls ends the loop
  (`end_turn`).
- **Anthropic server tools** (the Steward's `web_search`) cannot be emulated.
  They are removed from the tool list and the model is told they are
  unavailable. Containers are not supported.
- Codex never reports a refusal as `LlmRefusalError`, so the extractor's
  refusal fallback does not fire on this transport.

## Local embeddings

| Variable | Meaning |
| --- | --- |
| `EMBEDDING_BASE_URL` | OpenAI-compatible base URL, e.g. LM Studio `http://localhost:1234/v1` or llama.cpp `llama-server --embedding` at `http://localhost:8080/v1`. Unset: upstream behaviour (OpenAI `text-embedding-3-small` with `OPENAI_API_KEY`). |
| `EMBEDDING_MODEL` | Required when `EMBEDDING_BASE_URL` is set. |
| `EMBEDDING_API_KEY` | Optional; defaults to a dummy string, since local servers ignore it. |

The database column is `vector(1536)`. Shorter vectors are zero-padded to 1536,
which leaves cosine similarity and inner product unchanged. Longer vectors are
refused. Do not mix embedding models in one database: vectors from different
models are not comparable, so re-embed after switching.
