/**
 * Compile-check every TypeScript code sample in the docs.
 *
 * Extracts each ```ts fenced block from README.md and the docs site pages into
 * .samples-check/, then typechecks them against the real src/ entry points
 * (via tsconfig paths), so a sample that drifts from the actual API fails.
 *
 * Skip a block that is deliberately non-compiling with ```ts no-check.
 *
 * Run: npm run docs:check-samples
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, ".samples-check");

const pages = [
  "README.md",
  ...fs
    .globSync("docs/**/*.md", { cwd: root })
    // Planning documents and VitePress internals are not site pages.
    .filter((p) => !/[A-Z_]+\.md$/.test(p) && !p.includes(".vitepress")),
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);

const fence = /^```(\S+)([^\n]*)\n([\s\S]*?)^```/gm;
let count = 0;
for (const page of pages) {
  const text = fs.readFileSync(path.join(root, page), "utf8");
  for (const [, lang, meta, body] of text.matchAll(fence)) {
    if (!["ts", "typescript"].includes(lang) || meta.includes("no-check")) continue;
    count += 1;
    const name = `${String(count).padStart(2, "0")}-${page.replace(/[/.]/g, "-")}.ts`;
    // `export {}` forces module scope so samples can't collide with each other.
    fs.writeFileSync(
      path.join(outDir, name),
      `// from ${page}\n${body}\nexport {};\n`,
    );
  }
}

fs.writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify(
    {
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: true,
        rootDir: "..",
        baseUrl: "..",
        // Resolve the published entry points to the real source.
        paths: {
          "flue-guard": ["src/index.ts"],
          "flue-guard/audit": ["src/audit.ts"],
          "flue-guard/adapters": ["src/adapters.ts"],
          "flue-guard/d1": ["src/d1.ts"],
          "flue-guard/testing": ["src/testing.ts"],
        },
      },
      include: ["./**/*.ts"],
    },
    null,
    2,
  ),
);

try {
  execFileSync("npx", ["tsc", "-p", path.join(outDir, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
  });
} catch {
  console.error(`\ndocs samples failed to typecheck (${count} blocks from ${pages.length} pages)`);
  process.exit(1);
}
console.log(`ok: ${count} TypeScript samples from ${pages.length} pages typecheck`);
