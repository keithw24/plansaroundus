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

/**
 * `invalid_request` is a caller bug (a schema with no JSON Schema form, a bad
 * timeout) and never reaches the model; the rest are runtime failures.
 */
export type LlmErrorKind =
  | "invalid_request"
  | "timeout"
  | "aborted"
  | "provider"
  | "invalid_json"
  | "invalid_output";

// setTimeout clamps anything above this to 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new LlmError(
          "invalid_request",
          `timeoutMs must be 1..${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
        );
      }
      let jsonSchema: unknown;
      try {
        jsonSchema = jsonSchemaFor(schema);
      } catch (err) {
        throw new LlmError(
          "invalid_request",
          `schema has no JSON Schema form: ${errorMessage(err)}`,
          {
            cause: err,
          },
        );
      }
      if (signal?.aborted) throw new LlmError("aborted", "aborted before the call started");

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

      let text: string;
      try {
        text = await untilAborted(
          generate({ system, prompt, jsonSchema, temperature, signal: combined }),
          combined,
        );
      } catch (err) {
        if (timeout.signal.aborted) {
          throw new LlmError("timeout", `no reply within ${timeoutMs} ms`, { cause: err });
        }
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

      // Async so async refinements work; caught so a throwing transform is still an LlmError.
      let result: z.ZodSafeParseResult<z.output<typeof schema>>;
      try {
        result = await schema.safeParseAsync(value);
      } catch (err) {
        throw new LlmError("invalid_output", `schema threw on the reply: ${errorMessage(err)}`, {
          cause: err,
        });
      }
      if (!result.success) {
        throw new LlmError(
          "invalid_output",
          `model reply does not match schema:\n${z.prettifyError(result.error)}`,
          { cause: result.error },
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

// Converting a schema is pure, so do it once per schema object. Frozen because
// the same object is handed to every call.
const schemaCache = new WeakMap<z.ZodType, unknown>();
export function jsonSchemaFor(schema: z.ZodType): unknown {
  let json = schemaCache.get(schema);
  if (json === undefined) {
    // "input" describes what the model must send, before any transforms or defaults.
    json = deepFreeze(toGeminiSchema(z.toJSONSchema(schema, { io: "input" })));
    schemaCache.set(schema, json);
  }
  return json;
}

// The JSON Schema keywords Gemini's responseJsonSchema accepts (see @google/genai types).
const GEMINI_KEYWORDS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

/**
 * Rewrites zod's JSON Schema into the subset Gemini supports. Dropped keywords
 * (pattern, minLength, $schema...) only loosen what the model is told; zod
 * still validates the reply in full.
 */
export function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (node === null || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "const") {
      // A literal like kind: "event". Gemini only understands it as a one-value enum.
      if (typeof value === "string" || typeof value === "number") out.enum = [value];
    } else if (
      key === "exclusiveMinimum" &&
      typeof value === "number" &&
      src.minimum === undefined
    ) {
      out.minimum = value;
    } else if (
      key === "exclusiveMaximum" &&
      typeof value === "number" &&
      src.maximum === undefined
    ) {
      out.maximum = value;
    } else if (key === "properties" || key === "$defs") {
      // Keys here are property names, not keywords.
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (GEMINI_KEYWORDS.has(key)) {
      out[key] = toGeminiSchema(value);
    }
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
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
