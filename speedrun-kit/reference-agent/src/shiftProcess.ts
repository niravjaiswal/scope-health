import type { AgentConfig, ShiftSettings } from "./config";
import { writeOpencodeConfig } from "./opencodeConfig";
import { createQueueClient, runShift } from "./shift";

/**
 * Works one shift and ends the process: with status 0 when the shift ended, with status 1 when
 * the agent could not go on. A shift is worked by asking the queue API for items. The agent
 * serves nothing in it.
 */
export async function workShiftAndExit(config: AgentConfig, shift: ShiftSettings): Promise<never> {
  const configPath = await writeOpencodeConfig(config);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  console.log(
    JSON.stringify({ event: "shift_started", model: config.model, mode: "shift", configPath }),
  );
  const ended = await runShift(config, configPath, createQueueClient(shift.queueUrl)).catch(
    (error: unknown) => {
      console.error(JSON.stringify({ event: "shift_error", error: String(error) }));
      return null;
    },
  );
  console.log(
    JSON.stringify({
      event: "shift_ended",
      reason: ended?.reason ?? null,
      closed: ended?.closed ?? null,
      messages: ended?.messages.length ?? null,
    }),
  );
  process.exit(ended === null ? 1 : 0);
}
