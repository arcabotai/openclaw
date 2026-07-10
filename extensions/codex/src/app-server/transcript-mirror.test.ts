// Codex tests cover transcript mirror plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachCodexMirrorIdentity,
  buildCodexUserPromptMessage,
  mirrorCodexAppServerTranscript,
  mirrorTranscriptBestEffort,
} from "./transcript-mirror.js";

const publishSessionTranscriptUpdateByIdentityMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishSessionTranscriptUpdateByIdentityMock,
  };
});

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

// Mirrors transcript-mirror.ts's content fingerprint exactly so test
// expectations stay in sync without exposing the helper publicly.
function expectedFingerprint(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  publishSessionTranscriptUpdateByIdentityMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("buildCodexUserPromptMessage", () => {
  it("uses the prepared user transcript message for app-server prompt mirrors", () => {
    const message = buildCodexUserPromptMessage({
      prompt: "[Mon 2026-05-25 19:14 GMT+1] What is in this image?",
      messageChannel: "webchat",
      userTurnTranscriptRecorder: {
        message: {
          role: "user",
          content: "What is in this image?",
          timestamp: 1779732875151,
          MediaPath: "/tmp/image.png",
          MediaPaths: ["/tmp/image.png"],
          MediaType: "image/png",
          MediaTypes: ["image/png"],
        },
      },
    } as unknown as Parameters<typeof buildCodexUserPromptMessage>[0]);

    expect(message).toMatchObject({
      role: "user",
      content: "What is in this image?",
      timestamp: 1779732875151,
      sourceChannel: "webchat",
      MediaPath: "/tmp/image.png",
      MediaPaths: ["/tmp/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });
});

function readEventMessages(events: unknown[]): Array<{ role?: string; text?: string }> {
  return events
    .map((event) =>
      event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
    )
    .filter((message): message is { role?: string; content?: unknown } =>
      Boolean(message && typeof message === "object"),
    )
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.find((part): part is { text: string } =>
            Boolean(part && typeof part === "object" && typeof part.text === "string"),
          )?.text
        : typeof message.content === "string"
          ? message.content
          : undefined;
      return { role: message.role, text: content };
    });
}

async function createSqliteMirrorTarget(prefix: string, options: { sessionId?: string } = {}) {
  const root = await makeRoot(prefix);
  const agentId = "main";
  const sessionId = options.sessionId ?? "session-1";
  const sessionKey = `agent:${agentId}:${sessionId}`;
  const storePath = path.join(root, "openclaw-agent.sqlite");
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
      sessionId,
      updatedAt: 1,
    },
  });
  return {
    agentId,
    sessionId,
    sessionKey,
    storePath,
    bogusSessionFile: path.join(root, "should-not-be-created.jsonl"),
  };
}

async function readMirrorEvents(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await readSessionTranscriptEvents(target);
}

async function readMirrorRaw(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<string> {
  return (await readMirrorEvents(target)).map((event) => JSON.stringify(event)).join("\n");
}

async function readMirrorMessages(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<{ role?: string; text?: string }>> {
  return readEventMessages(await readMirrorEvents(target));
}

describe("mirrorCodexAppServerTranscript", () => {
  it("mirrors user, assistant, and tool result messages by SQLite identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-basic-");
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });
    const toolResultMessage = castAgentMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "toolResult", toolCallId: "call-1", content: "read output" }],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"content":[{"type":"text","text":"hello"}]');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"hi there"}]');
    expect(raw).toContain('"role":"toolResult"');
    expect(raw).toContain('"toolCallId":"call-1"');
    expect(raw).toContain('"content":"read output"');
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:toolResult:${expectedFingerprint(toolResultMessage)}"`,
    );
    await expect(fs.readFile(target.bogusSessionFile, "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("preserves gateway user-turn identity across Codex transcript mirroring", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-user-identity-");
    const userMessage = castAgentMessage({
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "client prompt" }],
        timestamp: Date.now(),
      }),
      idempotencyKey: "client-run:user",
    }) as MirroredAgentMessage;

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"client-run:user"');
    expect(raw).toContain('"mirrorOrigin":"codex-app-server"');
    expect(raw).not.toContain('"idempotencyKey":"codex-app-server:thread-1:');
    expect(first.userMessagesPresent).toHaveLength(1);
    expect(second.userMessagesPresent).toHaveLength(1);
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("emits message-bearing updates for newly appended mirrored messages only", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-live-updates-");
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "show me live" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionKey).toBe(target.sessionKey);
    expect(updates[0]?.storePath).toBe(target.storePath);
    expect(updates[0]?.update?.messageId).toEqual(expect.any(String));
    expect(updates[0]?.update?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(updates[0]?.update?.messageSeq).toBe(1);
    expect(firstMirror.userMessagesPresent).toHaveLength(1);
    expect(firstMirror.userMessagesPresent[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(secondMirror.userMessagesPresent).toHaveLength(1);
    expect(secondMirror.userMessagesPresent[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
  });

  it("emits stable sequence numbers for multi-message mirror batches", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-seq-");

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [
        attachCodexMirrorIdentity(
          makeAgentUserMessage({
            content: [{ type: "text", text: "first" }],
            timestamp: Date.now(),
          }),
          "turn-1:prompt",
        ),
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "second" }],
            timestamp: Date.now() + 1,
          }),
          "turn-1:assistant",
        ),
      ],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates.map((update) => update.update?.messageSeq)).toEqual([1, 2]);
    expect(
      updates.map((update) => {
        const message = update.update?.message as { role?: string } | undefined;
        return message?.role;
      }),
    ).toEqual(["user", "assistant"]);
  });

  it("keeps assistant ownership when live update publication fails", async () => {
    publishSessionTranscriptUpdateByIdentityMock.mockRejectedValueOnce(new Error("publish failed"));
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-publish-failure-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "durably persisted" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const result = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorRaw(target)).toContain('"role":"assistant"');
  });

  it("rejects mirror writes without a runtime session identity", async () => {
    await expect(
      mirrorCodexAppServerTranscript({
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "no identity" }],
            timestamp: Date.now(),
          }),
        ],
      }),
    ).rejects.toThrow("runtime session identity");
  });

  it("deduplicates app-server turn mirrors by idempotency scope", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-dedupe-");
    const messages = [
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
    ] as const;

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [...messages],
      idempotencyScope: "scope-1",
    });
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [...messages],
      idempotencyScope: "scope-1",
    });

    expect((await readMirrorMessages(target)).filter((message) => message.role)).toHaveLength(2);
  });

  it("reports final assistant ownership for new and idempotent mirrors", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-assistant-owned-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "owned once" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(firstMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(secondMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("runs before_message_write before appending mirrored transcript messages", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "hello [hooked]" }],
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
  });

  it("returns the persisted user message for duplicate mirror hits", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "[redacted by hook]" }],
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-duplicates-");
    const sourceMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "secret prompt" }],
      timestamp: Date.now(),
    });

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    expect(first.userMessagesPresent[0]?.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(second.userMessagesPresent[0]?.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(JSON.stringify(second.userMessagesPresent)).not.toContain("secret prompt");
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("preserves the computed idempotency key when hooks rewrite message keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              idempotencyKey: "hook-rewritten-key",
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-key-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
    expect(raw).not.toContain("hook-rewritten-key");
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-blocked-");

    const result = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "should not persist" }],
            timestamp: Date.now(),
          }),
          "turn-1:assistant",
        ),
      ],
      idempotencyScope: "scope-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorMessages(target)).toEqual([]);
  });

  it("leaves the assistant unowned when transcript persistence fails", async () => {
    const root = await makeRoot("openclaw-codex-transcript-failure-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "needs fallback persistence" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const assistantTranscriptOwned = await mirrorTranscriptBestEffort({
      params: {
        sessionId: "session-1",
        suppressNextUserMessagePersistence: true,
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [assistantMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(assistantTranscriptOwned).toBe(false);
  });

  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-shift-");
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });
    const reasoningMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "[Codex reasoning] thinking" }],
        timestamp: Date.now() + 2,
      }),
      "turn-1:reasoning",
    );
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, reasoningMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect((await readMirrorMessages(target)).map((m) => m.text)).toEqual([
      "hello",
      "hi there",
      "[Codex reasoning] thinking",
    ]);
  });

  it("keeps repeated same-content turns distinct", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-repeat-");
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({ content: [{ type: "text", text: "yes" }], timestamp: Date.now() }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({ content: [{ type: "text", text: "yes" }], timestamp: Date.now() + 2 }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 1" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 2" },
    ]);
  });

  it("dedupes prior-turn entries re-emitted into a later turn's snapshot", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-reemit-");
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({ content: [{ type: "text", text: "msg1" }], timestamp: Date.now() }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "msg2" }],
        timestamp: Date.now() + 2,
      }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1, userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "reply1" },
      { role: "user", text: "msg2" },
      { role: "assistant", text: "reply2" },
    ]);
  });

  it("uses the role+content fingerprint when no identity is attached", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-fingerprint-");
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
  });
});
