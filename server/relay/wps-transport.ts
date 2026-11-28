import type { AhpTransport, JsonRpcMessage, TransportFrame } from "@microsoft/agent-host-protocol/client";
import { Reassembler } from "./chunking";
import { buildPublish, parseInbound, RELIABLE_JSON_SUBPROTOCOL, type SendToGroupCommand } from "./framing";

/**
 * AHP transport over Azure Web PubSub, the relay GitHub uses between clients and a cloud sandbox's agent
 * host. Modelled on VS Code's `webPubSubRelayTransport.ts` (MIT): join the client's inbound groups,
 * advertise that it accepts batches, publish JSON-RPC to the host group, and acknowledge every
 * sequenced inbound frame so the reliable subprotocol doesn't redeliver it.
 */

export interface RelayGroups {
  /** Host → clients. */
  broadcast: string;
  /** Host → this client. */
  to_client: string;
  /** This client → host. */
  to_host: string;
}

export interface WpsTransportOptions {
  url: string;
  groups: RelayGroups;
  /** Injected in tests. Defaults to Node's global WebSocket. */
  createSocket?: (url: string, protocol: string) => WebSocketLike;
  timeoutMs?: number;
  /** Called once when the connection ends; `error` is null for a local close. */
  onClose?: (error: Error | null) => void;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;

export class WpsTransport implements AhpTransport {
  private readonly reassembler = new Reassembler();
  private readonly frames: TransportFrame[] = [];
  private readonly waiters: Array<(frame: TransportFrame | null) => void> = [];
  private socket: WebSocketLike | null = null;
  private ackId = 0;
  private lastSequenceId = 0;
  private closed = false;
  private closeError: Error | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly options: WpsTransportOptions) {}

  /** Opens the socket, joins the inbound groups and advertises batch support. */
  static async connect(options: WpsTransportOptions): Promise<WpsTransport> {
    const transport = new WpsTransport(options);
    await transport.open();
    return transport;
  }

  /** Why the relay closed, once it has. */
  get error(): Error | null {
    return this.closeError;
  }

  async send(message: JsonRpcMessage | string): Promise<void> {
    if (this.closed || !this.socket) throw new Error("The relay connection is closed");
    const payload = typeof message === "string" ? JSON.parse(message) : message;
    const frames = buildPublish({ group: this.options.groups.to_host, nextAckId: () => ++this.ackId, payload });
    for (const frame of frames) this.raw(frame);
  }

  recv(): Promise<TransportFrame | null> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.finish(null);
  }

  private open(): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const create = this.options.createSocket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as WebSocketLike);
    const socket = create(this.options.url, RELIABLE_JSON_SUBPROTOCOL);
    this.socket = socket;
    return new Promise<void>((resolve, reject) => {
      const joins = new Map<number, string>();
      let capabilitiesAck: number | null = null;
      let settled = false;
      const settle = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.finish(error);
          reject(error);
          return;
        }
        socket.onmessage = (event) => this.receive(event.data);
        this.sweep = setInterval(() => this.reassembler.sweepExpired(), SWEEP_INTERVAL_MS);
        resolve();
      };
      const timer = setTimeout(() => settle(new Error("The relay handshake timed out")), timeoutMs);
      socket.onerror = () => settle(new Error("The relay connection failed"));
      socket.onclose = (event) => {
        const error = new Error(`The relay closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
        if (!settled) settle(error);
        else this.finish(error);
      };
      socket.onmessage = (event) => {
        const frame = parse(event.data);
        if (!frame) return;
        if (frame.type === "system" && frame.event === "connected") {
          for (const group of [this.options.groups.broadcast, this.options.groups.to_client]) {
            const ackId = ++this.ackId;
            joins.set(ackId, group);
            this.raw({ type: "joinGroup", group, ackId });
          }
          return;
        }
        if (frame.type === "ack" && typeof frame.ackId === "number") {
          if (joins.has(frame.ackId)) {
            const group = joins.get(frame.ackId);
            joins.delete(frame.ackId);
            if (frame.success === false) return settle(new Error(`Joining relay group ${group} failed`));
            if (joins.size === 0) {
              capabilitiesAck = ++this.ackId;
              this.raw({
                type: "sendToGroup",
                group: this.options.groups.to_host,
                ackId: capabilitiesAck,
                dataType: "json",
                noEcho: true,
                data: { kind: "capabilities", accepts: ["batch"] },
              });
            }
            return;
          }
          if (frame.ackId === capabilitiesAck) {
            if (frame.success === false) return settle(new Error("The relay rejected the client's capabilities"));
            settle(null);
          }
          return;
        }
        // Host frames can arrive before the handshake completes; keep them.
        this.receive(event.data, frame);
      };
    });
  }

  private receive(data: unknown, parsed?: Record<string, unknown> | null): void {
    if (this.closed) return;
    const frame = parsed ?? parse(data);
    if (!frame) return;
    if (frame.type === "ack") {
      const error = frame.error as { name?: string; message?: string } | undefined;
      if (frame.success === false && error?.name !== "Duplicate") {
        this.finish(new Error(`The relay rejected a message${error?.message ? `: ${error.message}` : ""}`));
      }
      return;
    }
    if (frame.type === "message" && typeof frame.sequenceId === "number") {
      const duplicate = frame.sequenceId <= this.lastSequenceId;
      this.lastSequenceId = Math.max(this.lastSequenceId, frame.sequenceId);
      this.raw({ type: "sequenceAck", sequenceId: this.lastSequenceId });
      if (duplicate) return;
    }
    let result: ReturnType<typeof parseInbound>;
    try {
      result = parseInbound(frame, { reassembler: this.reassembler });
    } catch {
      return; // malformed group frame: skip it, as VS Code does
    }
    switch (result.kind) {
      case "payload":
        this.push({ kind: "parsed", message: result.payload as never });
        return;
      case "batch":
        for (const payload of result.payloads) this.push({ kind: "parsed", message: payload as never });
        return;
      case "hostOffline":
        this.finish(new Error("The cloud sandbox went offline"));
        return;
      case "closed":
        if (result.group.scope === "client" && result.group.lane === "to-client") {
          this.finish(new Error("The cloud sandbox closed the connection"));
        }
        return;
      default:
        return;
    }
  }

  private push(frame: TransportFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.frames.push(frame);
  }

  private raw(frame: SendToGroupCommand | Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private finish(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    if (this.sweep) clearInterval(this.sweep);
    try {
      this.socket?.close(1000);
    } catch {
      // already closed
    }
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.options.onClose?.(error);
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
