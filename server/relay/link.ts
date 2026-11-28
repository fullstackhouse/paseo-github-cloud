import { randomUUID } from "node:crypto";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { SandboxUnreachableError, type CopilotTasksApi, type RelayToken } from "../api";
import { WpsTransport } from "./wps-transport";

/**
 * Input for interactive sandbox tasks. GitHub takes their turns only over the sandbox's Agent Host
 * Protocol relay (Azure Web PubSub + JSON-RPC), not the REST steer call. The timeline still comes from
 * the REST event poll; ids match across both (request ids, tool call ids, turn ids).
 *
 * One link per task: it connects on first use, keeps the connection while input keeps coming, and
 * closes after a minute idle so a resting sandbox can sleep.
 */

const IDLE_CLOSE_MS = 60_000;
/** How long to keep trying while a dormant sandbox wakes. */
const CONNECT_DEADLINE_MS = 180_000;
const RETRY_DELAY_MS = 5_000;
/** After GitHub reports the host unreachable, wait longer before waking it again. */
const UNREACHABLE_RETRY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

interface SandboxProject {
  path: string;
  status: "ready" | "cloning" | "failed";
  remoteUrl?: string;
  error?: string;
}

function sameRepository(remoteUrl: string | undefined, repository: { owner: string; name: string }): boolean {
  const match = remoteUrl?.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return !!match && match[1].toLowerCase() === repository.owner.toLowerCase() && match[2].toLowerCase() === repository.name.toLowerCase();
}

/** How long the host may take to clone the repository for a new session. */
const CLONE_DEADLINE_MS = 300_000;

/** The sandbox isn't reachable yet (dormant or waking); connecting again may succeed. */
class SandboxUnavailable extends Error {}
const PROTOCOL_VERSIONS = ["1.1.0", "1.0.0"];

interface Connection {
  client: AhpClient;
  transport: WpsTransport;
  sessionUri: string;
  chatUri: string;
}

/** A pending input request from the session's `inputNeeded`, or a tool call awaiting confirmation. */
export type RelayInputRequest =
  | { kind: "chat"; chat: string; request: ChatInputRequest }
  | { kind: "tool"; chat: string; turnId: string; toolCallId: string };

export interface ChatInputRequest {
  id: string;
  message?: string;
  questions?: ChatInputQuestion[];
}

export interface ChatInputQuestion {
  id: string;
  kind: string;
  message?: string;
  options?: Array<{ id: string; label: string }>;
  allowFreeformInput?: boolean;
}

export class RelayLink {
  private connection: Promise<Connection> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: CopilotTasksApi,
    private readonly environmentId: string,
    private readonly sessionUri: string,
    private readonly log: (message: string) => void,
    /** A new sandbox task's repository: the host session is created on its checkout. */
    private readonly repository?: { owner: string; name: string },
  ) {}

  /** Sends a user message as a new turn. The host queues it when a turn is already running. */
  async sendMessage(text: string, turnId: string = randomUUID()): Promise<string> {
    await this.dispatchChat({
      type: "chat/turnStarted",
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: "user" } },
    });
    return turnId;
  }

  /** Answers a question or plan review. `answers` maps question ids to AHP answers. */
  async completeInput(requestId: string, response: "accept" | "decline" | "cancel", answers?: Record<string, unknown>): Promise<void> {
    const pending = await this.findInput(requestId);
    await this.dispatch(pending?.chat, { type: "chat/inputCompleted", requestId, response, ...(answers ? { answers } : {}) });
  }

  async confirmToolCall(toolCallId: string, approved: boolean): Promise<void> {
    const pending = await this.findTool(toolCallId);
    if (!pending) throw new Error("That permission request is no longer pending");
    await this.dispatch(
      pending.chat,
      approved
        ? { type: "chat/toolCallConfirmed", turnId: pending.turnId, toolCallId, approved: true, confirmed: "user-action" }
        : { type: "chat/toolCallConfirmed", turnId: pending.turnId, toolCallId, approved: false, reason: "denied" },
    );
  }

  /** Cancels the running turn, if any. */
  async cancelTurn(): Promise<void> {
    const { client, chatUri } = await this.connect();
    const { result } = await client.subscribe(chatUri as never);
    const active = (result as unknown as { snapshot?: { state?: { activeTurn?: { id: string; startedAt: string } } } }).snapshot?.state
      ?.activeTurn;
    if (!active) return;
    await this.dispatchChat({ type: "chat/turnCancelled", turnId: active.id, duration: Date.now() - Date.parse(active.startedAt) });
  }

  /**
   * Switches the agent's mode through whichever config declares a `mode` key, the session's or the
   * chat's. Writing a key the host doesn't declare is refused rather than sent.
   */
  async setMode(mode: string): Promise<void> {
    const { client, sessionUri, chatUri } = await this.connect();
    const session = await client.subscribe(sessionUri as never);
    if (declaresMode(session.result)) {
      await this.dispatch(sessionUri, { type: "session/configChanged", config: { mode } });
      return;
    }
    const chat = await client.subscribe(chatUri as never);
    if (declaresMode(chat.result)) {
      await this.dispatch(chatUri, { type: "chat/configChanged", config: { mode } });
      return;
    }
    throw new Error("This cloud session doesn't let clients switch its mode");
  }

  /** The chat input request with this id, with its questions, if still pending. */
  async findInput(requestId: string): Promise<Extract<RelayInputRequest, { kind: "chat" }> | null> {
    for (const entry of await this.inputNeeded()) {
      if (entry.kind === "chat" && entry.request.id === requestId) return entry;
    }
    return null;
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const connection = this.connection;
    this.connection = null;
    void connection
      ?.then(async ({ client, transport }) => {
        await client.shutdown().catch(() => {});
        transport.close();
      })
      .catch(() => {});
  }

  private async findTool(toolCallId: string): Promise<Extract<RelayInputRequest, { kind: "tool" }> | null> {
    for (const entry of await this.inputNeeded()) {
      if (entry.kind === "tool" && entry.toolCallId === toolCallId) return entry;
    }
    return null;
  }

  private async inputNeeded(): Promise<RelayInputRequest[]> {
    const { client, sessionUri } = await this.connect();
    const { result } = await client.subscribe(sessionUri as never);
    const state = (result as unknown as { snapshot?: { state?: { inputNeeded?: unknown[] } } }).snapshot?.state;
    return (state?.inputNeeded ?? []).flatMap((raw): RelayInputRequest[] => {
      const entry = raw as { kind?: string; chat?: string; request?: ChatInputRequest; turnId?: string; toolCall?: { toolCallId?: string } };
      if (entry.request && entry.chat) return [{ kind: "chat", chat: entry.chat, request: entry.request }];
      if (entry.turnId && entry.toolCall?.toolCallId && entry.chat) {
        return [{ kind: "tool", chat: entry.chat, turnId: entry.turnId, toolCallId: entry.toolCall.toolCallId }];
      }
      return [];
    });
  }

  private async dispatchChat(action: Record<string, unknown>): Promise<void> {
    const { chatUri } = await this.connect();
    await this.dispatch(chatUri, action);
  }

  private async dispatch(channel: string | undefined, action: Record<string, unknown>): Promise<void> {
    const connection = await this.connect();
    connection.client.dispatch((channel ?? connection.chatUri) as never, action as never);
    this.touch();
  }

  private connect(): Promise<Connection> {
    this.touch();
    if (this.connection) return this.connection;
    const connecting = this.open().catch((error) => {
      if (this.connection === connecting) this.connection = null;
      throw error;
    });
    this.connection = connecting;
    return connecting;
  }

  /**
   * Connects, retrying while the sandbox wakes. A minted token only means Mission Control believes
   * the sandbox is online; a dormant one closes the relay ("went offline") or never answers the
   * handshake, and the next `/connect` wakes it (202s until it is up).
   */
  private async open(): Promise<Connection> {
    const deadline = Date.now() + CONNECT_DEADLINE_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt();
      } catch (error) {
        const retryable = error instanceof SandboxUnavailable || error instanceof SandboxUnreachableError;
        if (!retryable || Date.now() + UNREACHABLE_RETRY_MS > deadline) throw error;
        this.log(`sandbox not ready (attempt ${attempt}): ${error.message}; retrying`);
        await new Promise((resolve) => setTimeout(resolve, error instanceof SandboxUnreachableError ? UNREACHABLE_RETRY_MS : RETRY_DELAY_MS));
      }
    }
  }

  private async attempt(): Promise<Connection> {
    const token = await this.api.connectEnvironment(this.environmentId, CONNECT_DEADLINE_MS);
    if (!token.encrypted_github_token) throw new Error("GitHub didn't issue a relay credential for this sandbox");
    let connection: Promise<Connection> | null = null;
    let rejectClosed: (error: Error) => void = () => {};
    const closed = new Promise<never>((_, reject) => (rejectClosed = reject));
    closed.catch(() => {});
    const transport = await WpsTransport.connect({
      url: relayUrl(token),
      groups: token.groups,
      onClose: (error) => {
        if (error) this.log(`relay closed: ${error.message}`);
        rejectClosed(new SandboxUnavailable(error?.message ?? "The relay closed"));
        // Reconnect on next use, unless a newer connection already replaced this one.
        if (this.connection === connection) this.connection = null;
      },
    }).catch((error: Error) => {
      throw new SandboxUnavailable(error.message);
    });
    connection = this.connection;
    const client = new AhpClient(transport, { requestTimeoutMs: HANDSHAKE_TIMEOUT_MS });
    client.connect();
    // A dormant sandbox leaves the handshake unanswered; treat that like "offline" and retry.
    const handshake = async () => {
      await client.initialize({ clientId: token.client_id, protocolVersions: PROTOCOL_VERSIONS });
      await (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request("authenticate", {
        channel: "ahp-root://",
        resource: "https://api.github.com",
        token: token.encrypted_github_token,
      });
      try {
        return await client.subscribe(this.sessionUri as never);
      } catch (error) {
        // A new sandbox task has no host session yet: the client creates it, on the repository checkout.
        if (!this.repository || !/not found|-32008/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await this.createHostSession(client, this.repository);
        return client.subscribe(this.sessionUri as never);
      }
    };
    let subscribed: Awaited<ReturnType<typeof handshake>>;
    try {
      subscribed = await Promise.race([handshake(), closed]);
    } catch (error) {
      transport.close();
      if (error instanceof SandboxUnavailable) throw error;
      throw new SandboxUnavailable(error instanceof Error ? error.message : String(error));
    }
    const chatUri = (subscribed.result as unknown as { snapshot?: { state?: { defaultChat?: string } } }).snapshot?.state
      ?.defaultChat;
    if (!chatUri) throw new Error("The cloud session has no chat to send to");
    return { client, transport, sessionUri: this.sessionUri, chatUri };
  }

  /** Clones the repository on the host (or reuses its checkout) and creates the session there. */
  private async createHostSession(client: AhpClient, repository: { owner: string; name: string }): Promise<void> {
    const request = (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request.bind(client);
    const path = await this.checkout(client, request, repository);
    await request("createSession", {
      channel: this.sessionUri,
      provider: "copilot",
      workingDirectories: [`file://${path}`],
    });
    this.log(`created the sandbox session on ${path}`);
  }

  private async checkout(
    client: AhpClient,
    request: (method: string, params: unknown) => Promise<unknown>,
    repository: { owner: string; name: string },
  ): Promise<string> {
    const deadline = Date.now() + CLONE_DEADLINE_MS;
    let requested = false;
    for (;;) {
      const projects = await this.projects(client);
      const project = projects.find((candidate) => sameRepository(candidate.remoteUrl, repository));
      if (project?.status === "ready" && project.path.startsWith("/")) return project.path;
      if (project?.status === "failed") throw new Error(`The cloud sandbox couldn't clone ${repository.owner}/${repository.name}${project.error ? `: ${project.error}` : ""}`);
      if (!project && !requested) {
        requested = true;
        await request("extensions/cloneProject", { url: `https://github.com/${repository.owner}/${repository.name}`, depth: 1 });
      }
      if (Date.now() > deadline) throw new Error(`Cloning ${repository.owner}/${repository.name} in the cloud sandbox took too long`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /** The repositories the host has checked out (`config.values.copilot.projects` in root state). */
  private async projects(client: AhpClient): Promise<SandboxProject[]> {
    await client.unsubscribe("ahp-root://" as never).catch(() => {});
    const { result } = await client.subscribe("ahp-root://" as never);
    const values = (result as unknown as { snapshot?: { state?: { config?: { values?: { copilot?: { projects?: unknown[] } } } } } })
      .snapshot?.state?.config?.values;
    return (values?.copilot?.projects ?? []).flatMap((raw) => {
      const project = raw as Partial<SandboxProject>;
      return typeof project.path === "string" ? [{ path: project.path, status: project.status ?? "ready", remoteUrl: project.remoteUrl, error: project.error }] : [];
    });
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }
}

function declaresMode(result: unknown): boolean {
  const config = (result as { snapshot?: { state?: { config?: { schema?: { properties?: Record<string, unknown> } } } } }).snapshot
    ?.state?.config;
  return Boolean(config?.schema?.properties && "mode" in config.schema.properties);
}

/** The Web PubSub URL for a relay token, forced to `wss://` as VS Code does. */
export function relayUrl(token: Pick<RelayToken, "wps_endpoint" | "access_token" | "client_id">): string {
  const base = token.wps_endpoint.replace(/^(?:wss?|https?):\/\//i, "");
  const separator = base.includes("?") ? "&" : "?";
  return `wss://${base}${separator}access_token=${encodeURIComponent(token.access_token)}&clientId=${encodeURIComponent(token.client_id)}`;
}
