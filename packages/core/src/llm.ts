import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

/** One raw model call. Returns the model's text, which should be JSON. */
export type Generate = (req: {
  system: string;
  prompt: string;
  jsonSchema: unknown;
  temperature: number;
  signal: AbortSignal;
}) => Promise<string>;

export type LlmJsonRequest<S extends z.ZodType> = {
  system: string;
  prompt: string;
  /** The reply must match this. Its `.describe()` text is part of the prompt. */
  schema: S;
  timeoutMs: number;
  temperature?: number;
  /** Aborts the call early, e.g. the calling skill's own signal. */
  signal?: AbortSignal;
};

export interface Llm {
  /** Calls the model in JSON mode and validates the reply. Throws LlmError on any failure. */
  json<S extends z.ZodType>(req: LlmJsonRequest<S>): Promise<z.output<S>>;
}

export type LlmErrorKind = "timeout" | "aborted" | "provider" | "invalid_json" | "invalid_output";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.kind = kind;
  }
}

export function createLlm(generate: Generate): Llm {
  return {
    async json({ system, prompt, schema, timeoutMs, temperature = 0, signal }) {
      if (signal?.aborted) throw new LlmError("aborted", "aborted before the call started");

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

      let text: string;
      try {
        text = await untilAborted(
          generate({
            system,
            prompt,
            jsonSchema: jsonSchemaFor(schema),
            temperature,
            signal: combined,
          }),
          combined,
        );
      } catch (err) {
        if (timeout.signal.aborted)
          throw new LlmError("timeout", `no reply within ${timeoutMs} ms`, { cause: err });
        if (signal?.aborted) throw new LlmError("aborted", "aborted by caller", { cause: err });
        throw new LlmError("provider", `model call failed: ${errorMessage(err)}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }

      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        throw new LlmError("invalid_json", "model reply is not JSON", { cause: err });
      }

      const result = schema.safeParse(value);
      if (!result.success) {
        throw new LlmError(
          "invalid_output",
          `model reply does not match schema:\n${z.prettifyError(result.error)}`,
          {
            cause: result.error,
          },
        );
      }
      return result.data;
    },
  };
}

/** The real Gemini call. Tests pass a fake `Generate` to `createLlm` instead. */
export function geminiGenerate(opts: { apiKey: string; model: string }): Generate {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  return async ({ system, prompt, jsonSchema, temperature, signal }) => {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: prompt,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
        temperature,
        abortSignal: signal,
      },
    });
    const text = res.text;
    if (!text)
      throw new Error(
        `empty reply (finish reason: ${res.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
    return text;
  };
}

// Converting a schema is pure, so do it once per schema object.
const schemaCache = new WeakMap<z.ZodType, unknown>();
function jsonSchemaFor(schema: z.ZodType): unknown {
  let json = schemaCache.get(schema);
  if (json === undefined) {
    // "input" describes what the model must send, before any transforms or defaults.
    json = z.toJSONSchema(schema, { io: "input" });
    schemaCache.set(schema, json);
  }
  return json;
}

// Rejects as soon as `signal` aborts, even if `promise` ignores the signal.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (err) => {
        done();
        reject(err);
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
