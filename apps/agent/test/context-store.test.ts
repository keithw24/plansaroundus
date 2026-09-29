import { silentLogger } from "@aroundus/core";
import { describe, expect, it } from "vitest";
import {
  type ContextStore,
  chatKey,
  createMemoryContextStore,
  createPgContextStore,
} from "../src/context-store.ts";
import { migrate } from "../src/migrate.ts";
import { createPgQuery } from "../src/pg.ts";
import { pin } from "./fakes.ts";

function contract(
  name: string,
  make: () => Promise<{ store: ContextStore; done?: () => Promise<void> }>,
) {
  describe(name, () => {
    it("starts empty, remembers the last location and the last 6 lines", async () => {
      const { store, done } = await make();
      const space = `test-${crypto.randomUUID()}`;
      try {
        expect(await store.get(space)).toEqual({ lastLocation: null, recent: [] });
        await store.setLocation(space, pin);
        await store.appendLines(space, [{ role: "user", text: "hi" }]);
        for (let i = 0; i < 4; i++) {
          await store.appendLines(space, [
            { role: "user", text: `q${i}` },
            { role: "agent", text: `a${i}` },
          ]);
        }
        const context = await store.get(space);
        expect(context.lastLocation).toEqual(pin);
        expect(context.recent.map((l) => l.text)).toEqual(["q1", "a1", "q2", "a2", "q3", "a3"]);
        expect((await store.get(`${space}-other`)).lastLocation).toBeNull();
      } finally {
        await done?.();
      }
    });
  });
}

contract("memory context store", async () => ({ store: createMemoryContextStore() }));

// Runs against a real database only when one is provided.
const testDb = process.env.TEST_DATABASE_URL;
if (testDb) {
  contract("pg context store", async () => {
    await migrate(testDb, () => {});
    const db = createPgQuery(testDb, silentLogger);
    return { store: createPgContextStore(db.query, "k".repeat(32)), done: db.close };
  });
} else {
  describe.skip("pg context store (set TEST_DATABASE_URL to run)", () => {
    it("skipped", () => {});
  });
}

describe("chatKey", () => {
  it("keys chat ids with a secret so phone numbers can't be recovered", () => {
    const key = chatKey("a".repeat(32), "iMessage;-;+19175550142");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("9175550142");
    expect(chatKey("b".repeat(32), "iMessage;-;+19175550142")).not.toBe(key);
  });
});
