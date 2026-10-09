/** End-to-end: run the real shift loop against a mock queue serving the practice
 *  items, with the sample index. Proves the queue contract + inference + close
 *  protocol work together. (Swap the sample index for the live crawler for a real run.) */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { runShift } from "./shiftMain.js";
import { index } from "./run.js";

const items = [
  { id: "i001", kind: "message", text: JSON.parse(readFileSync(new URL("../../fixtures/practice-queue.json", import.meta.url), "utf8")).items[0].text },
  { id: "i002", kind: "task", text: "Billing question: Guadalupe Driscoll, visit with Sharon Morales, MD on 2025-11-05. Is that a new or an established patient visit?" },
  { id: "i003", kind: "task", text: "Referral letter received on 2025-11-10 for patient Randy Singh (born 1939-12-04): which practice made the referral?" },
  { id: "i004", kind: "task", text: "What phone number do we have on file for patient Julie Martínez (born 2010-01-10)?" },
];
const expected = [
  { id: "i001", acknowledge: true },
  { id: "i002", answer: "NEW" },
  { id: "i003", answer: "Plains Dermatology Associates" },
  { id: "i004", answer: "(620) 323-6931" },
];

let cur = 0;
const closes: any[] = [];
const stateNow = () => (cur < items.length ? { status: "open", item: items[cur], seconds_left: 1000 } : { status: "ended", reason: "queue_finished" });

const server = createServer((req, res) => {
  const send = (o: any, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/item" && req.method === "GET") return send(stateNow());
  if (req.url === "/item/close" && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = JSON.parse(b || "{}");
      if (cur >= items.length) return send({ error: { code: "ended" }, state: stateNow() }, 409);
      if (body.id !== items[cur].id) return send({ error: { code: "not_current" }, state: stateNow() }, 409);
      closes.push(body); cur++; send(stateNow());
    });
    return;
  }
  send({ error: { code: "not_found" } }, 404);
});

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  process.env.QUEUE_URL = `http://127.0.0.1:${port}`;

  const { closed } = await runShift(index);

  let pass = 0;
  for (let i = 0; i < expected.length; i++) {
    const g = closes[i], e = expected[i];
    const ok = JSON.stringify(g) === JSON.stringify(e);
    if (ok) pass++;
    console.log(`${ok ? "✓" : "✗"} ${e.id}: sent ${JSON.stringify(g)}  expected ${JSON.stringify(e)}`);
  }
  console.log(`\nclosed=${closed}  ${pass}/${expected.length} correct close-requests`);
  server.close();
}
main().catch((e) => { console.error(e); server.close(); process.exit(1); });
