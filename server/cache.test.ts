import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileTaskCache } from "./cache";

describe("fileTaskCache", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps a task's snapshot across instances and leaves no temp files", async () => {
    dir = await mkdtemp(join(tmpdir(), "github-cloud-cache-"));
    const snapshot = {
      cursor: "e9",
      pending: [{ kind: "question" as const, requestId: "q1", title: "Pick A or B", choices: ["A", "B"] }],
      items: [{ type: "assistant_message" as const, id: "msg:m1", text: "Hello" }],
    };
    await fileTaskCache(dir).save("b2e859d1-d47f-4866-8203-40778430dac2", snapshot);
    expect(await fileTaskCache(dir).load("b2e859d1-d47f-4866-8203-40778430dac2")).toEqual(snapshot);
    expect(await fileTaskCache(dir).load("unknown")).toBeNull();
    expect(await readdir(dir)).toEqual(["b2e859d1-d47f-4866-8203-40778430dac2.json"]);
  });
});
