import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// README section 3: skills import only core and zod, the router reaches skills
// only through the registry type, and only apps/ read process.env.
// Runtime code only: test/ and each package's dev-only scripts/ are skipped.
const root = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return skipDir(dir, e.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

// Dev-only scripts/ are skipped only at a package root (next to package.json),
// so a src/scripts/ folder is still checked.
function skipDir(parent: string, name: string): boolean {
  if (name === "node_modules" || name === "test") return true;
  return name === "scripts" && existsSync(join(parent, "package.json"));
}

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map(
    (m) => m[1] ?? "",
  );
}

const rel = (file: string) => relative(root, file);

describe("dependency rules", () => {
  it("only apps/ read process.env", () => {
    const offenders = sourceFiles(join(root, "packages")).filter((f) =>
      /process\.env/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("skills import only core, zod and their own files", () => {
    const offenders = sourceFiles(join(root, "packages/skills")).flatMap((f) =>
      imports(f)
        .filter((spec) => !spec.startsWith(".") && spec !== "@aroundus/core" && spec !== "zod")
        .map((spec) => `${rel(f)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the router imports skill packages only as types", () => {
    const offenders = sourceFiles(join(root, "packages/router")).flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [...src.matchAll(/^import\s+(?!type\b)[^;]*?["'](@aroundus\/skill-[^"']+)["']/gm)].map(
        (m) => `${rel(f)} → ${m[1]}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("core imports no other workspace package", () => {
    const offenders = sourceFiles(join(root, "packages/core")).flatMap((f) =>
      imports(f)
        .filter((spec) => spec.startsWith("@aroundus/"))
        .map((spec) => `${rel(f)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
