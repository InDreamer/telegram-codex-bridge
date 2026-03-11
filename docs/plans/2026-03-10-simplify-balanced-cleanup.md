# Balanced Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the highest-value cleanup debt in the new bridge project without widening scope beyond hot-path waste and obvious duplicated selection logic.

**Architecture:** Keep behavior stable and make only three focused internal changes: batch Telegram offset persistence, memoized log-directory initialization, and one shared project-selection success path in the service layer. Each slice must follow TDD and stay independently verifiable.

**Tech Stack:** TypeScript, Node.js built-in test runner, tsx, npm, SQLite-backed state store.

---

### Task 1: Cache log-directory setup

**Files:**
- Modify: `package.json`
- Create: `src/logger.test.ts`
- Modify: `src/logger.ts`
- Test: `src/logger.test.ts`

**Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "./logger.js";

test("createLogger reuses directory setup across log writes", async () => {
  const ensured: string[] = [];
  const appended: string[] = [];
  const logger = createLogger("bridge", "/tmp/ctb/bridge.log", {
    ensureDir: async (dir) => {
      ensured.push(dir);
    },
    append: async (_filePath, line) => {
      appended.push(line);
    }
  });

  await logger.info("one");
  await logger.warn("two");

  assert.equal(ensured.length, 1);
  assert.equal(appended.length, 2);
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/logger.test.ts`
Expected: FAIL because the logger does not yet use the injected directory/appender hooks or reuse one ensured directory across both writes.

**Step 3: Write minimal implementation**

```ts
interface LoggerDeps {
  ensureDir(dirPath: string): Promise<void>;
  append(filePath: string, line: string): Promise<void>;
}

const defaultLoggerDeps: LoggerDeps = {
  ensureDir: async (dirPath) => mkdir(dirPath, { recursive: true }),
  append: async (filePath, line) => appendFile(filePath, line, "utf8")
};

const ensuredDirectories = new Map<string, Promise<void>>();

async function ensureDirectoryOnce(filePath: string, deps: LoggerDeps): Promise<void> {
  const dirPath = dirname(filePath);
  let pending = ensuredDirectories.get(dirPath);
  if (!pending) {
    pending = deps.ensureDir(dirPath);
    ensuredDirectories.set(dirPath, pending);
  }
  await pending;
}
```

Also update `createLogger(...)` to accept an optional third `deps` argument and update `package.json` so `npm test` includes `src/logger.test.ts`.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/logger.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json src/logger.ts src/logger.test.ts
git commit -m "refactor: cache logger directory setup"
```

### Task 2: Persist Telegram offset once per batch

**Files:**
- Modify: `src/telegram/poller.ts`
- Modify: `src/telegram/poller.test.ts`
- Test: `src/telegram/poller.test.ts`

**Step 1: Write the failing test**

```ts
test("TelegramPoller persists the newest offset once per update batch", async () => {
  const persisted: number[] = [];
  let poller!: TelegramPoller;

  const api = {
    getUpdates: async () => {
      poller.stop();
      return [{ update_id: 10 }, { update_id: 11 }];
    }
  } as unknown as ConstructorParameters<typeof TelegramPoller>[0];

  poller = new TelegramPoller(api, config, paths, logger, async () => {}, async (_paths, offset) => {
    persisted.push(offset);
  });

  await poller.run();

  assert.deepEqual(persisted, [12]);
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/telegram/poller.test.ts`
Expected: FAIL because the poller still persists after each update instead of once after the batch.

**Step 3: Write minimal implementation**

```ts
export class TelegramPoller {
  constructor(
    private readonly api: TelegramApi,
    private readonly config: BridgeConfig,
    private readonly paths: BridgePaths,
    private readonly logger: Logger,
    private readonly onUpdate: (update: TelegramUpdate) => Promise<void>,
    private readonly persistOffset: (paths: BridgePaths, offset: number) => Promise<void> = writeOffset
  ) {}

  async run(): Promise<void> {
    this.running = true;
    let offset = await readOffset(this.paths, this.logger);

    while (this.running) {
      const updates = await this.api.getUpdates(offset, this.config.telegramPollTimeoutSeconds);
      let nextOffset = offset;

      for (const update of updates) {
        await this.onUpdate(update);
        nextOffset = update.update_id + 1;
      }

      if (nextOffset !== offset) {
        offset = nextOffset;
        await this.persistOffset(this.paths, offset);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/telegram/poller.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/poller.ts src/telegram/poller.test.ts
git commit -m "refactor: batch Telegram offset persistence"
```

### Task 3: Clear picker state after normal project selection

**Files:**
- Modify: `src/service.test.ts`
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

```ts
test("handleProjectPick clears picker state after a successful selection", async () => {
  const { service, store, cleanup } = await createServiceContext();

  try {
    const candidate = {
      projectKey: "project-1",
      projectPath: "/tmp/project-one",
      projectName: "Project One",
      score: 100,
      pinned: false,
      hasExistingSession: false,
      lastUsedAt: null,
      lastSuccessAt: null,
      accessible: true,
      fromScan: true,
      detectedMarkers: [".git"]
    };

    (service as any).pickerStates.set("chat-1", {
      picker: {
        title: "选择项目",
        emptyText: null,
        primary: candidate,
        frequent: [],
        partial: false,
        allRootsFailed: false,
        projectMap: new Map([[candidate.projectKey, candidate]])
      },
      awaitingManualProjectPath: false,
      resolved: false
    });

    (service as any).api = { sendMessage: async () => {} };
    await (service as any).handleProjectPick("chat-1", candidate.projectKey);

    assert.equal((service as any).pickerStates.has("chat-1"), false);
    assert.equal(store.listSessions("chat-1").length, 1);
  } finally {
    await cleanup();
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/service.test.ts`
Expected: FAIL because successful selection leaves the picker state behind.

**Step 3: Write minimal implementation**

```ts
private async finalizeProjectSelection(chatId: string, candidate: ProjectCandidate): Promise<void> {
  if (!this.store) {
    return;
  }

  const activeSession = this.store.getActiveSession(chatId);
  if (activeSession?.status === "running") {
    await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
    return;
  }

  this.store.createSession({
    telegramChatId: chatId,
    projectName: candidate.projectName,
    projectPath: candidate.projectPath
  });

  this.pickerStates.delete(chatId);
  await this.safeSendMessage(chatId, buildProjectSelectedText(candidate.projectName));
}
```

Then call this helper from `handleProjectPick` after candidate validation.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "refactor: clear picker state after project selection"
```

### Task 4: Reuse the same selection flow for manual-path confirmation

**Files:**
- Modify: `src/service.test.ts`
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

```ts
test("confirmManualProject uses the shared selection flow and clears picker state", async () => {
  const { service, store, cleanup } = await createServiceContext();

  try {
    const candidate = {
      projectKey: "manual-1",
      projectPath: "/tmp/manual-project",
      projectName: "Manual Project",
      score: 0,
      pinned: false,
      hasExistingSession: false,
      lastUsedAt: null,
      lastSuccessAt: null,
      accessible: true,
      fromScan: false,
      detectedMarkers: ["package.json"]
    };

    (service as any).pickerStates.set("chat-1", {
      picker: {
        title: "选择项目",
        emptyText: null,
        primary: null,
        frequent: [],
        partial: false,
        allRootsFailed: false,
        projectMap: new Map([[candidate.projectKey, candidate]])
      },
      awaitingManualProjectPath: true,
      resolved: false
    });

    (service as any).api = { sendMessage: async () => {} };
    await (service as any).confirmManualProject("chat-1", candidate.projectKey);

    assert.equal((service as any).pickerStates.has("chat-1"), false);
    assert.equal(store.listSessions("chat-1")[0]?.projectName, "Manual Project");
  } finally {
    await cleanup();
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/service.test.ts`
Expected: FAIL because manual confirmation still owns its own duplicated success path.

**Step 3: Write minimal implementation**

```ts
private async resolveProjectCandidate(chatId: string, projectKey: string): Promise<ProjectCandidate | null> {
  const pickerState = this.pickerStates.get(chatId);
  if (!pickerState || pickerState.resolved) {
    await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
    return null;
  }

  const candidate = pickerState.picker.projectMap.get(projectKey);
  if (!candidate) {
    await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
    return null;
  }

  pickerState.resolved = true;
  return candidate;
}
```

Route both `handleProjectPick` and `confirmManualProject` through the same resolver + `finalizeProjectSelection(...)` helper.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "refactor: share manual and picker project selection flow"
```

### Task 5: Run the full verification pass

**Files:**
- Modify: none expected
- Test: `src/logger.test.ts`, `src/telegram/poller.test.ts`, `src/service.test.ts`, full project suite

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS with all tests green.

**Step 2: Run type checking**

Run: `npm run check`
Expected: PASS with no TypeScript errors.

**Step 3: Inspect the final diff**

Run: `git diff -- package.json src/logger.ts src/logger.test.ts src/telegram/poller.ts src/telegram/poller.test.ts src/service.ts src/service.test.ts docs/plans/2026-03-10-simplify-balanced-cleanup-design.md docs/plans/2026-03-10-simplify-balanced-cleanup.md`
Expected: Only the planned cleanup files changed.

**Step 4: Commit the finished cleanup**

```bash
git add package.json src/logger.ts src/logger.test.ts src/telegram/poller.ts src/telegram/poller.test.ts src/service.ts src/service.test.ts docs/plans/2026-03-10-simplify-balanced-cleanup-design.md docs/plans/2026-03-10-simplify-balanced-cleanup.md
git commit -m "refactor: simplify bridge hot paths and selection flow"
```
