import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createResourceLoader } from "../agents/sessions/agent-session-loop-resource-loader.test-support.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeletedAgentDatabasePath } from "../infra/agent-database-readers.js";
import { retainSqliteDatabaseAdmissionLocation } from "../infra/sqlite-database-admission.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  assertAgentSessionWriteAdmission,
  sessionWorkAdmissionClosures,
} from "../sessions/session-agent-work-admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { useAgentDatabaseDirectories } from "../state/openclaw-agent-db-lifecycle.test-support.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../state/openclaw-agent-db-resources.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { listOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.test-support.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController } from "./chat-abort.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createRecoveryRestartMock } from "./config-reload.test-support.js";
import {
  createHotReloadHandlerTestParams,
  createTestCronState,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const directories = useAgentDatabaseDirectories();

function roster(agentIds: readonly string[], level: "info" | "debug" = "info"): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
    logging: { level },
  };
}

function installState(agentIds: readonly string[]) {
  const stateDir = fs.realpathSync(directories.make("departed-agent-db-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousSnapshot = getRuntimeConfigSnapshot();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const config = roster(agentIds);
  setRuntimeConfigSnapshot(config, config);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const opened = agentIds.map((agentId) => {
    const database = openOpenClawAgentDatabase({ agentId, env });
    const version = database.db.prepare("PRAGMA user_version").get();
    return { agentId, database, path: database.path, version };
  });
  onTestFinished(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousSnapshot) {
      setRuntimeConfigSnapshot(previousSnapshot);
    } else {
      clearRuntimeConfigSnapshot();
    }
  });
  return { env, opened, config };
}

function createHandlers() {
  const { requestRecoveryRestart } = createRecoveryRestartMock();
  const handlers = createGatewayReloadHandlers(
    createHotReloadHandlerTestParams({
      scheduler: createTestGatewayScheduler("fake-timers"),
      deps: {} as never,
      requestRecoveryRestart,
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        cronState: createTestCronState(),
      }),
    }),
  );
  onTestFinished(() => handlers.stopRestartRetries());
  return handlers;
}

async function commitRoster(
  handlers: ReturnType<typeof createHandlers>,
  next: OpenClawConfig,
  publish: (commit: () => Promise<void>) => Promise<void> = async (commit) => {
    setRuntimeConfigSnapshot(next, next);
    await commit();
  },
) {
  await handlers.applyHotReload(buildGatewayReloadPlan(["agents.entries"]), next, {
    sourceConfig: next,
    isCurrent: () => true,
    publish,
  });
}

function holderIds(): string[] {
  return listOpenClawAgentDatabasesForTest().map((database) => database.agentId);
}

function readOnlyIdentityDescriptors(pathname: string): string[] {
  if (process.platform !== "linux") {
    return [];
  }
  const wanted = fs.realpathSync(pathname);
  const found: string[] = [];
  for (const entry of fs.readdirSync("/proc/self/fd")) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join("/proc/self/fd", entry));
    } catch {
      continue;
    }
    if (target !== wanted) {
      continue;
    }
    const flags = Number.parseInt(
      fs
        .readFileSync(path.join("/proc/self/fdinfo", entry), "utf8")
        .match(/^flags:\s*(\S+)/m)?.[1] ?? "",
      8,
    );
    if ((flags & 3) === 0) {
      found.push(entry);
    }
  }
  return found;
}

it("closes a removed agent's database holders and leaves the other agent open", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  const main = opened.find((database) => database.agentId === "main");
  if (!worker || !main) {
    throw new Error("fixture did not open both agents");
  }
  await commitRoster(createHandlers(), roster(["main"]));

  expect(holderIds()).toEqual(["main"]);
  expect(hasOpenClawAgentDatabaseAsyncResources({ agentId: "worker", path: worker.path })).toBe(
    false,
  );
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  expect(fs.existsSync(worker.path)).toBe(true);
  expect(fs.statSync(worker.path).size).toBeGreaterThan(0);
  expect(main.database.db.isOpen).toBe(true);
  expect(main.database.db.prepare("PRAGMA user_version").get()).toEqual(main.version);
  retainSqliteDatabaseAdmissionLocation(worker.path);
  expect(readOnlyIdentityDescriptors(worker.path)).toEqual([]);
  expect(() => openOpenClawAgentDatabase({ agentId: "worker", env: process.env })).toThrow(
    /left the roster/,
  );
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env: process.env })).toThrow(
    /left the roster/,
  );
  expect(() =>
    assertAgentSessionWriteAdmission({ agentId: "main", env: process.env }),
  ).not.toThrow();
});

it("keeps both databases open when the committed roster still admits them", async () => {
  const { opened } = installState(["main", "worker"]);
  await commitRoster(createHandlers(), roster(["main", "worker"], "debug"));
  expect(holderIds()).toEqual(opened.map((database) => database.agentId).toSorted());
  expect(opened.every((database) => !isDeletedAgentDatabasePath(database.path))).toBe(true);
});

it("keeps the removed agent's database open when config publication fails", async () => {
  const { opened } = installState(["main", "worker"]);
  const handlers = createHandlers();
  await expect(
    commitRoster(handlers, roster(["main"]), async () => {
      throw new Error("config publication rejected");
    }),
  ).rejects.toThrow("config publication rejected");
  expect(holderIds()).toEqual(opened.map((database) => database.agentId).toSorted());
});

it("admits a re-added agent's retained database after reload closed it", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const handlers = createHandlers();
  await commitRoster(handlers, roster(["main"]));
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);

  await commitRoster(handlers, roster(["main", "worker"]));
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
  const reopened = openOpenClawAgentDatabase({ agentId: "worker", env });
  expect(reopened.db.isOpen).toBe(true);
  expect(reopened.path).toBe(worker.path);
  expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(worker.version);
});

it("follows the later committed roster when two reloads overlap", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const removalEntered = createDeferred();
  const releaseRemoval = createDeferred();
  const removal = commitRoster(createHandlers(), roster(["main"]), async (commit) => {
    removalEntered.resolve();
    await releaseRemoval.promise;
    const next = roster(["main"]);
    setRuntimeConfigSnapshot(next, next);
    await commit();
  });
  try {
    await removalEntered.promise;
    await commitRoster(createHandlers(), roster(["main", "worker"]));
    expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  } finally {
    releaseRemoval.resolve();
  }
  await removal;

  expect(holderIds()).not.toContain("worker");
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  expect(fs.existsSync(worker.path)).toBe(true);
  const survivorPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  expect(holderIds()).toContain("main");
  expect(path.resolve(survivorPath)).toBe(
    opened.find((database) => database.agentId === "main")?.path,
  );
});

it("leaves a journaled agents.delete cleanup in charge of the open database", async () => {
  const { env, opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  beginAgentDeletionJournal(
    {
      agentId: "worker",
      operationId: "worker-delete-journal",
      agentDir: path.dirname(worker.path),
      workspaceDir: path.dirname(worker.path),
      sessionsDir: path.dirname(worker.path),
      deleteFiles: false,
      phase: "retiring",
    },
    { env },
  );
  await commitRoster(createHandlers(), roster(["main"]));
  expect(worker.database.db.isOpen).toBe(true);
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(false);
  expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
});

it("settles an active turn before closing the removed agent's database", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const interrupted = createDeferred();
  let openWhenInterrupted = false;
  const turn = await beginSessionEffect({
    agentId: "worker",
    env: process.env,
    scope: worker.path,
    identities: ["agent:worker:live"],
    owner: Symbol("live-turn"),
    assertAllowed: () => {},
    onInterrupt: () => {
      openWhenInterrupted = worker.database.db.isOpen;
      interrupted.resolve();
      turn.release();
    },
  });
  const removal = commitRoster(createHandlers(), roster(["main"]));
  const winner = await Promise.race([
    interrupted.promise.then(() => "interrupted" as const),
    removal.then(() => "closed" as const),
  ]);
  expect(winner).toBe("interrupted");
  expect(openWhenInterrupted).toBe(true);
  await removal;
  expect(holderIds()).not.toContain("worker");
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
});

it("persists a held model turn's terminal session write before closing its database", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const terminalWrite = createDeferred<void>();
  let writeError: unknown;
  let openDuringWrite = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  registerChatAbortController({
    target: captureSessionTarget({
      storeScope: worker.path,
      sessionKey: "agent:worker:main",
      incarnation: "worker-session",
      agentId: "worker",
    }),
    runId: "worker-held-model",
    sessionId: "worker-session",
    sessionKey: "agent:worker:main",
    agentId: "worker",
    timeoutMs: 60_000,
    // The Gateway tracks this promise on the run source. It outlives effect release.
    sourceWork: terminalWrite.promise,
  });
  onTestFinished(() => {
    if (timer) {
      clearTimeout(timer);
    }
    terminalWrite.resolve();
    resetSessionControllerStateForTest();
  });
  const turn = await beginSessionEffect({
    agentId: "worker",
    env: process.env,
    scope: worker.path,
    identities: ["agent:worker:main"],
    owner: Symbol("held-model"),
    assertAllowed: () => {},
    onInterrupt: () => {
      // Abort releases the session effect before the held model call returns.
      turn.release();
      timer = setTimeout(() => {
        void (async () => {
          try {
            assertAgentSessionWriteAdmission({ agentId: "worker", env: process.env });
            openDuringWrite = worker.database.db.isOpen;
            worker.database.db.exec("PRAGMA user_version = 7");
          } catch (error) {
            writeError = error;
          } finally {
            terminalWrite.resolve();
          }
        })();
      }, 0);
    },
  });
  try {
    await commitRoster(createHandlers(), roster(["main"]));
    expect(writeError).toBeUndefined();
    expect(openDuringWrite).toBe(true);
    expect(holderIds()).not.toContain("worker");
    expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  } finally {
    turn.release();
  }
});

it("commits the aborted transcript before closing a database under a held provider stream", async () => {
  const { opened } = installState(["main", "worker"]);
  const worker = opened.find((database) => database.agentId === "worker");
  if (!worker) {
    throw new Error("fixture did not open worker");
  }
  const target = {
    agentId: "worker",
    sessionId: "worker-held-model",
    sessionKey: "agent:worker:main",
    storePath: worker.path,
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const held = createDeferred<void>();
  const model = makeProviderModelFixture({
    id: "held-model",
    provider: "held-provider",
    api: "openai-responses",
    baseUrl: "https://example.test",
  });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      held.resolve();
      const finish = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "aborted",
            errorMessage: "aborted",
            timestamp: 1,
            usage: createZeroUsageFixture(),
          },
        });
        stream.end();
      };
      if (options?.signal?.aborted) {
        finish();
      } else {
        options?.signal?.addEventListener("abort", finish, { once: true });
      }
      return stream;
    },
  });
  const { session } = await createAgentSession({
    cwd: path.dirname(worker.path),
    systemPrompt: "Test session prompt",
    model,
    thinkingLevel: "off",
    tools: [],
    sessionManager: SessionManager.open(target, path.dirname(worker.path)),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    modelRegistry,
    resourceLoader: await createResourceLoader(),
  });
  onTestFinished(() => {
    void session.abort().catch(() => undefined);
    void session.dispose();
  });
  const records: Array<{ kind: "assistant" | "turn-aborted"; open: boolean }> = [];
  session.subscribe((event) => {
    if (event.type !== "message_end") {
      return;
    }
    const message = event.message;
    const open = worker.database.db.isOpen;
    if (message.role === "assistant" && message.stopReason === "aborted") {
      records.push({ kind: "assistant", open });
    }
    if (message.role === "custom" && message.customType === "openclaw:turn-aborted") {
      records.push({ kind: "turn-aborted", open });
    }
  });
  const prompt = session.prompt("active-held-inspect");
  const promptSettled = prompt.then(
    () => "persisted" as const,
    () => "persisted" as const,
  );
  await held.promise;
  const removal = commitRoster(createHandlers(), roster(["main"]));
  const outcome = await Promise.race([promptSettled, removal.then(() => "closed" as const)]);
  await removal;
  expect(outcome).toBe("persisted");
  expect(records).toEqual([
    { kind: "assistant", open: true },
    { kind: "turn-aborted", open: true },
  ]);
  expect(holderIds()).not.toContain("worker");
  expect(isDeletedAgentDatabasePath(worker.path)).toBe(true);
  expect(fs.existsSync(worker.path)).toBe(true);
});

it("clears the session-write block when cleanup fails and the agent is re-added", async () => {
  const { env } = installState(["main", "worker"]);
  const memory = await import("../plugins/memory-runtime.js");
  const closeMemory = vi
    .spyOn(memory, "closeActiveMemorySearchManagerCore")
    .mockRejectedValueOnce(new Error("memory close failed"));
  try {
    await commitRoster(createHandlers(), roster(["main"]));
    const workerWriteBlocked = () =>
      [...sessionWorkAdmissionClosures].some(
        (closure) => closure.agent?.agentId === "worker" && closure.identities.length === 0,
      );
    expect(workerWriteBlocked()).toBe(true);
    await commitRoster(createHandlers(), roster(["main", "worker"]));
    expect(workerWriteBlocked()).toBe(false);
    expect(() => assertAgentSessionWriteAdmission({ agentId: "worker", env })).not.toThrow();
  } finally {
    closeMemory.mockRestore();
  }
});
