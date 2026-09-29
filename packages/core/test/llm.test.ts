import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlm, type Generate, LlmError } from "../src/llm.ts";

const Reply = z.object({
  text: z.string().describe("The reply"),
  citedIds: z.array(z.string()),
});

const base = { system: "sys", prompt: "hi", schema: Reply, timeoutMs: 1000 };

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof LlmError) return err.kind;
    throw err;
  }
  throw new Error("expected a rejection");
};

describe("llm.json", () => {
  it("returns validated output and sends the schema as JSON Schema", async () => {
    const generate = vi.fn<Generate>(async () => JSON.stringify({ text: "ok", citedIds: ["a"] }));
    const result = await createLlm(generate).json(base);

    expect(result).toEqual({ text: "ok", citedIds: ["a"] });
    const req = generate.mock.calls[0]?.[0];
    expect(req?.system).toBe("sys");
    expect(req?.prompt).toBe("hi");
    expect(req?.temperature).toBe(0);
    expect(req?.jsonSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", description: "The reply" } },
      required: ["text", "citedIds"],
    });
  });

  it("throws invalid_json on non-JSON text", async () => {
    const llm = createLlm(async () => "Sure! Here you go");
    expect(await kindOf(llm.json(base))).toBe("invalid_json");
  });

  it("throws invalid_output when the reply doesn't match the schema", async () => {
    const llm = createLlm(async () => JSON.stringify({ text: 5 }));
    expect(await kindOf(llm.json(base))).toBe("invalid_output");
  });

  it("throws provider when the call fails", async () => {
    const llm = createLlm(async () => {
      throw new Error("503 UNAVAILABLE");
    });
    const err = await llm.json(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("provider");
    expect((err as LlmError).message).toContain("503");
  });

  it("times out even if the call ignores its signal", async () => {
    const llm = createLlm(() => new Promise<string>(() => {}));
    expect(await kindOf(llm.json({ ...base, timeoutMs: 20 }))).toBe("timeout");
  });

  it("aborts the underlying call on timeout", async () => {
    let seen: AbortSignal | undefined;
    const llm = createLlm(({ signal }) => {
      seen = signal;
      return new Promise<string>(() => {});
    });
    await kindOf(llm.json({ ...base, timeoutMs: 20 }));
    expect(seen?.aborted).toBe(true);
  });

  it("stops when the caller's signal aborts", async () => {
    const caller = new AbortController();
    const llm = createLlm(() => new Promise<string>(() => {}));
    const pending = kindOf(llm.json({ ...base, signal: caller.signal }));
    caller.abort();
    expect(await pending).toBe("aborted");
  });

  it("does not call the model if the caller already aborted", async () => {
    const generate = vi.fn<Generate>(async () => "{}");
    expect(await kindOf(createLlm(generate).json({ ...base, signal: AbortSignal.abort() }))).toBe(
      "aborted",
    );
    expect(generate).not.toHaveBeenCalled();
  });
});
