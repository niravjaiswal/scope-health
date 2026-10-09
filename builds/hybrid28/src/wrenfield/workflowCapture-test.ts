// Set 1 messages: each long workflow message is captured with its answer tokens; tasks tag to their workflow.
import { readFileSync } from "node:fs";
import { captureWorkflow, workflowFor, capturedWorkflows } from "./workflowCapture.js";
const items = readFileSync("fixtures/set1-items.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
let tagged = 0, tasks = 0; const byWf: Record<string, number> = {};
for (const it of items) {
  if (it.kind === "message") captureWorkflow(it.text, it.n);
  else { tasks++; const w = workflowFor(it.text); if (w) { tagged++; byWf[w.title] = (byWf[w.title] ?? 0) + 1; } }
}
for (const w of capturedWorkflows()) console.log(w.order, w.title, w.tokens.join(" "), "|", w.inputs);
console.log(byWf);
const n = capturedWorkflows().length;
console.log(`${n} workflows, ${tagged}/${tasks} tasks tagged`);
if (n < 5) { console.error("FAIL: expected >=5 Set 1 workflows"); process.exit(1); }
// A count question is never tagged with a workflow that doesn't count (lab triage: "what happens to a lab report").
for (const t of ["How many lab reports came in on 2026-10-12?", "Count of Lab report documents received 10/12/2026.", "Number of lab reports received on 2026-10-11"]) {
  const w = workflowFor(t); if (w && /lab report/i.test(w.title)) { console.error(`FAIL: count question tagged as ${w.title}: ${t}`); process.exit(1); }
}
const rc = workflowFor("How many patients are left to notify about the recall of lot AB12?");
if (!rc || !/recall/i.test(rc.title)) { console.error("FAIL: recall count question lost its (counting) workflow"); process.exit(1); }
console.log("count questions: not captured by non-counting workflows; recall kept");
