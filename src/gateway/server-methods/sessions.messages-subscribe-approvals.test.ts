import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionApprovalReplay } from "../../../packages/gateway-protocol/src/index.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

import { sessionsHandlers } from "./sessions.js";

function createClient(params: {
  scopes: string[];
  deviceId?: string;
  connId?: string;
}): GatewayClient {
  return {
    connId: params.connId ?? "conn-approval-reviewer",
    connect: {
      client: { id: "approval-subscribe-test", displayName: "Approval Subscribe Test" },
      scopes: params.scopes,
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
  } as unknown as GatewayClient;
}

function createContext(params: {
  replay?: SessionApprovalReplay;
  globalScope?: boolean;
  agents?: Array<{ id: string; default?: boolean }>;
}) {
  const subscribeSessionMessageEvents = vi.fn();
  const listSessionPendingApprovals = vi.fn(
    (_sessionKey: string, _client: GatewayClient | null) => params.replay,
  );
  const logError = vi.fn();
  const context = {
    getRuntimeConfig: () => ({
      agents: { list: params.agents ?? [{ id: "main", default: true }] },
      ...(params.globalScope ? { session: { scope: "global" as const } } : {}),
    }),
    listSessionPendingApprovals,
    logGateway: { error: logError },
    subscribeSessionMessageEvents,
  } as unknown as GatewayRequestContext;
  return { context, listSessionPendingApprovals, logError, subscribeSessionMessageEvents };
}

async function subscribe(params: {
  body: Record<string, unknown>;
  client: GatewayClient;
  context: GatewayRequestContext;
}) {
  const respond = vi.fn();
  await sessionsHandlers["sessions.messages.subscribe"]({
    req: { id: "req-subscribe-approvals" } as never,
    params: params.body,
    respond,
    context: params.context,
    client: params.client,
    isWebchatConnect: () => false,
  } satisfies GatewayRequestHandlerOptions);
  return respond;
}

describe("sessions.messages.subscribe approval opt-in", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({ canonicalKey: sessionKey }));
  });

  it("allows an admin without a paired device and uses the exact scoped subscription key", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "global" });
    const approvalReplay = {
      sessionKey: "agent:work:global",
      updatedAtMs: 42,
      approvals: [],
      truncated: false,
    } satisfies SessionApprovalReplay;
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext({
      replay: approvalReplay,
      globalScope: true,
      agents: [{ id: "main", default: true }, { id: "work" }],
    });

    const respond = await subscribe({
      body: { key: "agent:work:main", includeApprovals: true },
      client: createClient({ scopes: ["operator.admin"], connId: " conn-admin " }),
      context,
    });

    expect(listSessionPendingApprovals).toHaveBeenCalledWith(
      "agent:work:global",
      expect.objectContaining({ connId: " conn-admin " }),
    );
    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-admin", "agent:work:global", {
      includeApprovals: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "global", approvalReplay },
      undefined,
    );
  });

  it("allows a paired device with approval scope", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "agent:main:child" });
    const approvalReplay = {
      sessionKey: "agent:main:child",
      updatedAtMs: 43,
      approvals: [],
      truncated: false,
    } satisfies SessionApprovalReplay;
    const { context, subscribeSessionMessageEvents } = createContext({ replay: approvalReplay });

    const respond = await subscribe({
      body: { key: "child", includeApprovals: true },
      client: createClient({ scopes: ["operator.approvals"], deviceId: "phone" }),
      context,
    });

    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-approval-reviewer",
      "agent:main:child",
      { includeApprovals: true },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:child", approvalReplay },
      undefined,
    );
  });

  it.each([
    {
      name: "approval scope without a paired device",
      client: createClient({ scopes: ["operator.approvals"] }),
    },
    {
      name: "paired device without approval authority",
      client: createClient({ scopes: ["operator.read"], deviceId: "phone" }),
    },
  ])("rejects $name", async ({ client }) => {
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext(
      {},
    );

    const respond = await subscribe({
      body: { key: "agent:main:child", includeApprovals: true },
      client,
      context,
    });

    expect(listSessionPendingApprovals).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("operator.approvals"),
      }),
    );
  });

  it("keeps the non-approval response shape and skips replay", async () => {
    loadSessionEntryMock.mockReturnValueOnce({ canonicalKey: "agent:main:child" });
    const { context, listSessionPendingApprovals, subscribeSessionMessageEvents } = createContext(
      {},
    );

    const respond = await subscribe({
      body: { key: "child" },
      client: createClient({ scopes: ["operator.read"] }),
      context,
    });

    expect(listSessionPendingApprovals).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).toHaveBeenCalled();
    expect(subscribeSessionMessageEvents.mock.calls[0]?.slice(0, 2)).toEqual([
      "conn-approval-reviewer",
      "agent:main:child",
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:child" },
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("approvalReplay");
  });
});
