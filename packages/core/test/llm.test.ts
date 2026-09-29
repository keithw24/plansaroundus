import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlm, type Generate, jsonSchemaFor, LlmError, toGeminiSchema } from "../src/llm.ts";

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
    expect(req?.jsonSchema).not.toHaveProperty("$schema");
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

  it("wraps a throwing transform and an async refine as invalid_output", async () => {
    const llm = createLlm(async () => '{"a":"x"}');
    const throwing = z.object({
      a: z.string().transform(() => {
        throw new Error("boom");
      }),
    });
    expect(await kindOf(llm.json({ ...base, schema: throwing }))).toBe("invalid_output");

    const asyncOk = z.object({ a: z.string().refine(async (v) => v === "x") });
    expect(await llm.json({ ...base, schema: asyncOk })).toEqual({ a: "x" });
    const asyncBad = z.object({ a: z.string().refine(async (v) => v === "y") });
    expect(await kindOf(llm.json({ ...base, schema: asyncBad }))).toBe("invalid_output");
  });

  it("rejects a schema with no JSON Schema form before calling the model", async () => {
    const generate = vi.fn<Generate>(async () => "{}");
    const schema = z.object({ at: z.date() });
    expect(await kindOf(createLlm(generate).json({ ...base, schema }))).toBe("invalid_request");
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "rejects timeoutMs %s",
    async (timeoutMs) => {
      const llm = createLlm(async () => "{}");
      expect(await kindOf(llm.json({ ...base, timeoutMs }))).toBe("invalid_request");
    },
  );

  it("describes the input side of defaults and fills them in the output", async () => {
    const schema = z.object({
      when: z.string().default("now"),
      note: z.string().optional(),
      n: z.string().transform(Number),
    });
    const generate = vi.fn<Generate>(async () => '{"n":"3"}');
    expect(await createLlm(generate).json({ ...base, schema })).toEqual({ when: "now", n: 3 });
    const sent = generate.mock.calls[0]?.[0].jsonSchema as { required?: string[] };
    expect(sent.required).toEqual(["n"]);
  });

  it("clears its timer on success", async () => {
    let seen: AbortSignal | undefined;
    const llm = createLlm(async ({ signal }) => {
      seen = signal;
      return '{"text":"ok","citedIds":[]}';
    });
    await llm.json({ ...base, timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen?.aborted).toBe(false);
  });

  it("keeps the caller's abort reason as the cause", async () => {
    const caller = new AbortController();
    const llm = createLlm(() => new Promise<string>(() => {}));
    const pending = llm.json({ ...base, signal: caller.signal }).catch((e: unknown) => e);
    caller.abort(new Error("turn cancelled"));
    const err = (await pending) as LlmError;
    expect((err.cause as Error).message).toBe("turn cancelled");
  });
});

describe("toGeminiSchema", () => {
  it("keeps only keywords Gemini supports and turns const into a one-value enum", () => {
    const schema = z.object({
      kind: z.literal("event"),
      id: z
        .string()
        .min(1)
        .regex(/^[a-z]+:/),
      count: z.number().positive(),
      tags: z.array(z.string()).max(3),
    });
    expect(jsonSchemaFor(schema)).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["event"] },
        id: { type: "string" },
        count: { type: "number", minimum: 0 },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
      required: ["kind", "id", "count", "tags"],
    });
  });

  it("does not treat property names as keywords", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { pattern: { type: "string", pattern: "x" }, const: { type: "number" } },
    });
    expect(out).toEqual({
      type: "object",
      properties: { pattern: { type: "string" }, const: { type: "number" } },
    });
  });

  it("returns a frozen, cached object", () => {
    const a = jsonSchemaFor(z.object({ x: z.string() }));
    expect(Object.isFrozen(a)).toBe(true);
    const schema = z.object({ y: z.string() });
    expect(jsonSchemaFor(schema)).toBe(jsonSchemaFor(schema));
  });
});
