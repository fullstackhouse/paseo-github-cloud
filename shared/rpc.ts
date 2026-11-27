import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The task's name, for the title of the agent a task link opens. */
export const taskInfo = defineRpc({
  name: "task.info",
  input: z.object({ taskId: z.string() }),
  output: z.object({ name: z.string().nullable() }),
});
