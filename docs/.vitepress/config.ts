import { defineConfig } from "vitepress";

export default defineConfig({
  title: "flue-guard",
  description:
    "Governance layer for Flue tools: in-process authorization, idempotency, and tamper-evident audit.",
  base: "/flue-guard/",
  lastUpdated: true,
  // Planning documents live in docs/ but are not site pages.
  srcExclude: [
    "**/BUSINESS_REQUIREMENTS.md",
    "**/FUNCTIONAL_REQUIREMENTS.md",
    "**/MANIFEST_SPEC.md",
    "**/TASK_SPECS.md",
    "**/TECH_ARCHITECTURE.md",
  ],
  themeConfig: {
    nav: [
      { text: "Tutorial", link: "/tutorial" },
      { text: "Guides", link: "/guides/authorize-vs-scope" },
      { text: "Reference", link: "/reference/entry-points" },
      {
        text: "v0.1.0",
        items: [
          { text: "npm", link: "https://www.npmjs.com/package/flue-guard" },
          { text: "Changelog", link: "https://github.com/Kirylka/flue-guard/releases" },
        ],
      },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Why flue-guard exists", link: "/explanation/why-flue-guard" },
          { text: "Tutorial: your first governed tool", link: "/tutorial" },
        ],
      },
      {
        text: "How-to guides",
        items: [
          { text: "Choose authorize vs scope", link: "/guides/authorize-vs-scope" },
          { text: "Require human approval", link: "/guides/require-approval" },
          { text: "Make retries safe", link: "/guides/safe-retries" },
          { text: "Verify & protect the audit log", link: "/guides/protect-the-audit-log" },
          { text: "Run on Cloudflare Workers", link: "/guides/cloudflare-workers" },
          { text: "Shape what the model sees", link: "/guides/shape-model-output" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Entry points", link: "/reference/entry-points" },
          { text: "govern() & the toolkit", link: "/reference/toolkit" },
          { text: "Tool spec", link: "/reference/tool-spec" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Adapters", link: "/reference/adapters" },
          { text: "Audit log", link: "/reference/audit-log" },
        ],
      },
      {
        text: "Explanation",
        items: [
          { text: "Why flue-guard exists", link: "/explanation/why-flue-guard" },
          { text: "The pipeline", link: "/explanation/pipeline" },
          { text: "The trust model", link: "/explanation/trust-model" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/Kirylka/flue-guard" },
      { icon: "npm", link: "https://www.npmjs.com/package/flue-guard" },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    editLink: {
      pattern: "https://github.com/Kirylka/flue-guard/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
