import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadStartParams, buildTurnStartParams } from "./app-server.js";

test("buildThreadStartParams requests full-access sandbox", () => {
  assert.deepEqual(buildThreadStartParams("/tmp/project"), {
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" }
  });
});

test("buildTurnStartParams inherits full-access sandbox settings", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "edit files"
    }),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "edit files" }],
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" }
    }
  );
});
