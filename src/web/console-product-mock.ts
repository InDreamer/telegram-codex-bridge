import type { ConsoleProductAppModel } from "./console-product-model.js";

export function createConsoleProductMock(): ConsoleProductAppModel {
  return {
    title: "Codex Console",
    currentProject: "acme/web",
    currentSession: "Refactor auth middleware",
    currentModel: "GPT-5.5 xhigh",
    currentMode: "Auto",
    status: "online",
    commands: ["/code", "/review", "/test", "/deploy", "/explain"],
    modelOptions: ["GPT-5.5 xhigh", "GPT-5.5 high", "GPT-5.4"],
    modeOptions: ["Auto", "Ask", "Review only"],
    projects: [
      {
        name: "acme/web",
        branch: "main",
        hint: "apps:web",
        expanded: true,
        sessions: [
          { title: "Refactor auth middleware", age: "2h ago", active: true },
          { title: "Fix CI flaky test", age: "Yesterday" },
          { title: "Add UI prototype", age: "May 21" }
        ]
      },
      {
        name: "acme/api",
        branch: "main",
        hint: "services:api",
        expanded: false,
        sessions: [{ title: "Optimize rate limiter", age: "May 20" }]
      },
      {
        name: "acme/infra",
        branch: "main",
        hint: "infra",
        expanded: false,
        sessions: [{ title: "Bump Docker images", age: "May 18" }]
      }
    ],
    timeline: [
      {
        role: "user",
        body: "Refactor the auth middleware to use async/await and improve error handling.",
        time: "10:32 AM"
      },
      {
        role: "assistant",
        body: "I’ll refactor the auth middleware to use async/await, add better error handling, and keep behavior identical.",
        time: "10:32 AM"
      }
    ],
    runCard: {
      title: "Refactoring auth middleware",
      status: "Running",
      progressLabel: "2/5 steps",
      progressPercent: 42,
      cancelLabel: "Cancel",
      steps: [
        { label: "Analyze current middleware", state: "done" },
        { label: "Refactor to async/await", state: "active" },
        { label: "Improve error handling", state: "pending" },
        { label: "Run type check", state: "pending" },
        { label: "Run tests", state: "pending" }
      ]
    },
    diffCard: {
      filename: "src/web/App.tsx",
      added: 23,
      removed: 17,
      lines: [
        { number: "78", kind: "remove", text: "- const user = getUser(req);" },
        { number: "79", kind: "remove", text: "- if (!user) {" },
        { number: "79", kind: "add", text: "+ const user = await getUser(req);" },
        { number: "80", kind: "add", text: "+ if (!user) {" },
        { number: "…", kind: "context", text: "…" }
      ],
      actions: ["Review diff", "Open files"]
    },
    approvalCard: {
      title: "Approval required",
      pendingCount: 2,
      items: [
        { title: "Run tests", detail: "Will run 128 tests" },
        { title: "Modify config", detail: "Update .env.example" }
      ],
      actions: ["Review", "Approve", "Approve all"]
    },
    contextCard: {
      title: "Project context",
      summary: "Using selected files and the current project summary before editing.",
      chips: ["src/web/App.tsx", "src/web/auth.ts", "README.md", "Project notes"],
      actionLabel: "Change context"
    },
    artifactCard: {
      title: "Files & artifacts",
      summary: "3 changed files and 1 generated summary are ready for review.",
      files: [
        { name: "src/web/App.tsx", status: "modified" },
        { name: "src/web/auth.ts", status: "modified" },
        { name: "run-summary.md", status: "generated" }
      ],
      actionLabel: "Open files"
    },
    emptyState: {
      title: "Start a new session",
      body: "New session will be created under acme/web with the same project context. Ask Codex what to change first.",
      ctaLabel: "+ New session"
    },
    degradedState: {
      title: "Connection needs attention",
      body: "Codex can keep showing this workspace, but live updates may be delayed.",
      ownerAction: "Workspace owner: check the bridge service before starting a long run."
    },
    composer: {
      placeholder: "Message Codex or type /",
      controls: ["Attach", "Command", "Mic", "Send"]
    }
  };
}
