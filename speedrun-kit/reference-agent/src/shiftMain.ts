import { agentEnv } from "@arena/contracts";
import { loadConfig } from "./config";
import { workShiftAndExit } from "./shiftProcess";

// The entry point of an agent that works shifts and does nothing else.
const config = loadConfig(process.env);
if (config.shift === null) {
  console.error(`${agentEnv.queueUrl} is not set: there is no shift to work`);
  process.exit(1);
}
await workShiftAndExit(config, config.shift);
