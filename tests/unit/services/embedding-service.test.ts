import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the transport, not the SDK: every request goes through global fetch.
const fetchMock = vi.fn();

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ openaiApiKey: "sk-test-openai" }),
}));

const ENV = ["EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_API_KEY"];
const saved: Record<string, string | undefined> = {};

function respondWith(vectors: number[][]): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          object: "list",
          model: "m",
          data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
}

function sent(call = 0): { url: string; body: Record<string, unknown>; auth: string | null } {
  const [url, init] = fetchMock.mock.calls[call]! as [string, { body: string; headers: unknown }];
  const h = init.headers;
  const auth =
    h instanceof Headers
      ? h.get("authorization")
      : ((h as Record<string, string>).authorization ?? (h as Record<string, string>).Authorization ?? null);
  return { url: String(url), body: JSON.parse(init.body), auth };
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("embedding-service — local OpenAI-compatible server", () => {
  it("uses EMBEDDING_BASE_URL/EMBEDDING_MODEL with a dummy key and zero-pads to 1536", async () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:1234/v1";
    process.env.EMBEDDING_MODEL = "nomic-embed-text-v1.5";
    respondWith([[0.1, 0.2, 0.3]]);
    const { generateEmbedding } = await import("../../../src/services/embedding-service.js");
    const v = await generateEmbedding("hello");
    expect(v).toHaveLength(1536);
    expect(v.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(v.slice(3).every((x) => x === 0)).toBe(true);
    const req = sent();
    expect(req.url).toBe("http://localhost:1234/v1/embeddings");
    expect(req.body.model).toBe("nomic-embed-text-v1.5");
    expect(req.body.encoding_format).toBe("float");
    expect(req.body).not.toHaveProperty("dimensions");
    expect(req.auth).toBe("Bearer local-no-key");
  });

  it("pads every vector of a batch, in index order, and honours EMBEDDING_API_KEY", async () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:8080/v1";
    process.env.EMBEDDING_MODEL = "bge-m3";
    process.env.EMBEDDING_API_KEY = "whatever";
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { object: "embedding", index: 1, embedding: [2] },
              { object: "embedding", index: 0, embedding: [1] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const { generateEmbeddings } = await import("../../../src/services/embedding-service.js");
    const vs = await generateEmbeddings(["a", "b"]);
    expect(vs.map((v) => v.length)).toEqual([1536, 1536]);
    expect(vs.map((v) => v[0])).toEqual([1, 2]);
    expect(sent().auth).toBe("Bearer whatever");
  });

  it("refuses vectors wider than the 1536 column", async () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:1234/v1";
    process.env.EMBEDDING_MODEL = "too-wide";
    respondWith([new Array(2048).fill(0.5)]);
    const { generateEmbedding } = await import("../../../src/services/embedding-service.js");
    await expect(generateEmbedding("x")).rejects.toThrow(/2048 dimensions.*1536/);
  });

  it("requires EMBEDDING_MODEL alongside EMBEDDING_BASE_URL", async () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:1234/v1";
    const { generateEmbedding } = await import("../../../src/services/embedding-service.js");
    await expect(generateEmbedding("x")).rejects.toThrow(/EMBEDDING_MODEL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("embedding-service — upstream behaviour when EMBEDDING_BASE_URL is unset", () => {
  it("calls OpenAI text-embedding-3-small at 1536 dims with OPENAI_API_KEY", async () => {
    // (The SDK asks OpenAI for base64 by default and decodes it, so only the
    // request is asserted here: nothing about it may change.)
    respondWith([new Array(1536).fill(0.01)]);
    const { generateEmbedding } = await import("../../../src/services/embedding-service.js");
    await generateEmbedding("hello");
    const req = sent();
    expect(req.url).toBe("https://api.openai.com/v1/embeddings");
    expect(req.body.model).toBe("text-embedding-3-small");
    expect(req.body.dimensions).toBe(1536);
    expect(req.auth).toBe("Bearer sk-test-openai");
  });
});
