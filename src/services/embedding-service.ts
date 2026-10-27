import OpenAI from "openai";
import { loadConfig } from "../config.js";

/** The width of the `vector(1536)` embedding columns. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Local OpenAI-compatible embeddings (LM Studio, llama.cpp `llama-server
 * --embedding`, …), selected by EMBEDDING_BASE_URL. Unset means the upstream
 * behaviour: OpenAI's text-embedding-3-small with OPENAI_API_KEY.
 */
interface LocalEmbeddingConfig {
  baseURL: string;
  model: string;
  apiKey: string;
}

function localEmbeddingConfig(): LocalEmbeddingConfig | null {
  const baseURL = process.env.EMBEDDING_BASE_URL?.trim();
  if (!baseURL) return null;
  const model = process.env.EMBEDDING_MODEL?.trim();
  if (!model) {
    throw new Error(
      "EMBEDDING_BASE_URL is set but EMBEDDING_MODEL is not: name the " +
        "embedding model your local server serves."
    );
  }
  return {
    baseURL,
    model,
    // Local servers ignore the key, but the SDK insists on one.
    apiKey: process.env.EMBEDDING_API_KEY?.trim() || "local-no-key",
  };
}

let _client: OpenAI | null = null;
let _clientKey: string | null = null;

function getClient(local: LocalEmbeddingConfig | null): OpenAI {
  const key = local ? `${local.baseURL}\n${local.apiKey}` : "openai";
  if (_client && _clientKey === key) return _client;
  _client = new OpenAI({
    apiKey: local ? local.apiKey : loadConfig().openaiApiKey,
    ...(local ? { baseURL: local.baseURL } : {}),
    // The SDK's bundled HTTP client (node-fetch) fails with "Premature close"
    // against api.openai.com in some environments (observed on ECS Fargate /
    // Node 22) — every embeddings call errors. Native fetch works reliably
    // there (verified raw fetch + this override both succeed), so force the
    // SDK to use it.
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  _clientKey = key;
  return _client;
}

/**
 * Fit a local model's vector into the 1536-wide column: zero-pad a shorter one
 * (cosine similarity and inner product are unchanged by trailing zeros), and
 * refuse a longer one rather than truncate it, which would change distances.
 */
export function fitEmbeddingDimensions(vector: number[], model: string): number[] {
  if (vector.length === EMBEDDING_DIMENSIONS) return vector;
  if (vector.length > EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding model "${model}" returned ${vector.length} dimensions; the ` +
        `database column holds ${EMBEDDING_DIMENSIONS}. Use a model with at ` +
        `most ${EMBEDDING_DIMENSIONS} dimensions.`
    );
  }
  return vector.concat(new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0));
}

async function localEmbeddings(
  local: LocalEmbeddingConfig,
  input: string | string[]
): Promise<number[][]> {
  const response = await getClient(local).embeddings.create({
    model: local.model,
    input,
    // Floats, not the SDK's default base64: not every local server
    // implements base64 encoding.
    encoding_format: "float",
  });
  return [...response.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => fitEmbeddingDimensions(d.embedding, local.model));
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const local = localEmbeddingConfig();
  if (local) return (await localEmbeddings(local, text))[0]!;
  const client = getClient(null);
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });
  return response.data[0]!.embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const local = localEmbeddingConfig();
  if (local) return localEmbeddings(local, texts);
  const client = getClient(null);
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
    dimensions: 1536,
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
