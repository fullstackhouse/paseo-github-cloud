import { describe, expect, it } from "vitest";
import { answerFor } from "../input";
import { relayUrl } from "./link";
import { WpsTransport, type WebSocketLike } from "./wps-transport";

const lane = (direction: string) => `user.u1.env.e1.client.c1.${direction}`;
const groups = { broadcast: lane("broadcast"), to_client: lane("to-client"), to_host: lane("to-host") };

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Runs the Web PubSub handshake the way Azure answers it. */
async function connected(): Promise<{ transport: WpsTransport; socket: FakeSocket }> {
  const socket = new FakeSocket();
  const opening = WpsTransport.connect({ url: "wss://relay", groups, createSocket: () => socket });
  socket.deliver({ type: "system", event: "connected" });
  const joins = socket.sent.filter((frame) => frame.type === "joinGroup");
  expect(joins.map((frame) => frame.group)).toEqual([groups.broadcast, groups.to_client]);
  for (const join of joins) socket.deliver({ type: "ack", ackId: join.ackId, success: true });
  const capabilities = socket.sent.at(-1)!;
  expect(capabilities).toMatchObject({ type: "sendToGroup", group: groups.to_host, data: { kind: "capabilities", accepts: ["batch"] } });
  socket.deliver({ type: "ack", ackId: capabilities.ackId, success: true });
  return { transport: await opening, socket };
}

describe("WpsTransport", () => {
  it("joins its groups, advertises batches, then publishes JSON-RPC to the host group", async () => {
    const { transport, socket } = await connected();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} } as never);
    expect(socket.sent.at(-1)).toMatchObject({
      type: "sendToGroup",
      group: groups.to_host,
      dataType: "json",
      noEcho: true,
      data: { kind: "message", data: { jsonrpc: "2.0", id: 1, method: "initialize" } },
    });
  });

  it("acknowledges sequenced frames, drops redeliveries, and unpacks batches", async () => {
    const { transport, socket } = await connected();
    const message = (id: number) => ({ jsonrpc: "2.0", id, result: {} });
    socket.deliver({ type: "message", from: "group", group: groups.to_client, dataType: "json", sequenceId: 1, data: { kind: "message", data: message(1) } });
    socket.deliver({ type: "message", from: "group", group: groups.to_client, dataType: "json", sequenceId: 1, data: { kind: "message", data: message(1) } });
    socket.deliver({ type: "message", from: "group", group: groups.to_client, dataType: "json", sequenceId: 2, data: { kind: "batch", items: [message(2), message(3)] } });
    const received = [await transport.recv(), await transport.recv(), await transport.recv()];
    expect(received.map((frame) => (frame as { message: { id: number } }).message.id)).toEqual([1, 2, 3]);
    expect(socket.sent.filter((frame) => frame.type === "sequenceAck").map((frame) => frame.sequenceId)).toEqual([1, 1, 2]);
  });

  it("fails the handshake when the relay rejects a group join", async () => {
    const socket = new FakeSocket();
    const opening = WpsTransport.connect({ url: "wss://relay", groups, createSocket: () => socket });
    socket.deliver({ type: "system", event: "connected" });
    socket.deliver({ type: "ack", ackId: 1, success: false });
    await expect(opening).rejects.toThrow(`Joining relay group ${groups.broadcast} failed`);
  });

  it("ends reads when the sandbox goes away", async () => {
    let closed: Error | null = null;
    const socket = new FakeSocket();
    const opening = WpsTransport.connect({ url: "wss://relay", groups, createSocket: () => socket, onClose: (error) => (closed = error) });
    socket.deliver({ type: "system", event: "connected" });
    for (const join of socket.sent.filter((frame) => frame.type === "joinGroup")) socket.deliver({ type: "ack", ackId: join.ackId, success: true });
    socket.deliver({ type: "ack", ackId: socket.sent.at(-1)!.ackId, success: true });
    const transport = await opening;
    const read = transport.recv();
    socket.onclose?.({ code: 1006, reason: "gone" });
    expect(await read).toBeNull();
    expect(closed).toEqual(new Error("The relay closed (1006: gone)"));
  });
});

describe("answerFor", () => {
  const select = { id: "answer", kind: "single-select", options: [{ id: "A", label: "Option A" }, { id: "B", label: "B" }] };

  it("picks the option the answer names by label or id", () => {
    expect(answerFor(select, "Option A")).toEqual({ state: "submitted", value: { kind: "selected", value: "A" } });
    expect(answerFor(select, "B")).toEqual({ state: "submitted", value: { kind: "selected", value: "B" } });
  });

  it("sends other text as free input", () => {
    expect(answerFor(select, "Neither")).toEqual({ state: "submitted", value: { kind: "selected", value: "", freeformValues: ["Neither"] } });
    expect(answerFor({ id: "q", kind: "text" }, "Ada")).toEqual({ state: "submitted", value: { kind: "text", value: "Ada" } });
  });
});

describe("relayUrl", () => {
  it("forces wss and carries the client token", () => {
    expect(relayUrl({ wps_endpoint: "https://host.webpubsub.azure.com/client/hubs/h", access_token: "a b", client_id: "c1" })).toBe(
      "wss://host.webpubsub.azure.com/client/hubs/h?access_token=a%20b&clientId=c1",
    );
  });
});
