/** Set 1 routing parity: every Set 1 task must route to the family the 158 run logged.
 *   npx tsx src/wrenfield/routing-parity.ts   (exit 1 on any difference) */
import { readFileSync } from "node:fs";
import { taskFamily } from "./families.js";
const log = readFileSync(new URL("../../fixtures/set1/run-158-set1.log", import.meta.url), "utf8").split("\n")
  .filter((l) => l.startsWith('{"event":"item"')).map((l) => JSON.parse(l)).filter((i) => i.kind === "task");
let diff = 0;
for (const i of log) { const f = taskFamily(i.text); if (f !== i.family) { diff++; console.log(`DIFF n=${i.n}: 158=${i.family} now=${f} :: ${i.text.slice(0, 100)}`); } }
console.log(diff ? `✗ routing parity: ${diff} of ${log.length} tasks changed family` : `✓ routing parity: ${log.length}/${log.length} tasks keep the 158 family`);
process.exit(diff ? 1 : 0);
