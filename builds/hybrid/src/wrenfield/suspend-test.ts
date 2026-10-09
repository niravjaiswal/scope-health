/**
 * The "This account is suspended" page (Set 1 run 265: two spells, ~60 s and ~740 s → end of the shift; 219 s of 4-12 s marker
 * timeouts, the tasks of the spells skipped). crawl.ts waits the spell out instead (reloads every SUSPEND_POLL_MS), gives the page
 * that loads next its own timeout, and runs a typed-form read once more when a spell was waited out during it.
 *   npx tsx src/wrenfield/suspend-test.ts
 */
export {};
process.env.AGENT_SUSPEND_POLL_MS = "40";
process.env.AGENT_SUSPEND_WAIT_S = "5";
process.env.AGENT_NAV_CAP = "1:3,5:100";
const { Crawler } = await import("./crawl.js");

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log("✓ " + m); else { fails++; console.error("✗ " + m); } };

const SUSPENDED = "Wrenfield\nThis account is suspended\n\nYou cannot use Wrenfield with this account at the moment. Try again later, or ask your practice administrator.";
ok(Crawler.isSuspended(SUSPENDED), "the captured suspension page is recognised");
ok(!Crawler.isSuspended("Wrenfield\nPatients\nFind a patient by last name or date of birth."), "an ordinary page is not");
ok(!Crawler.isSuspended("Chart note\nThis account is suspended for billing review, try again later.\n" + "x".repeat(700)), "a long page that mentions it is not (the state is a whole-page one)");
ok(!Crawler.isSuspended("This account is suspended"), "the words alone, without 'try again later', are not enough");

/** A Crawler with no browser: appText reads a script of page texts; Page.reload advances it. */
function fake(script: Array<{ untilReload: number; text: string }>) {
  const c: any = new Crawler("http://x", "/tmp/suspend-test-profile");
  const st = { reloads: 0 };
  c.client = { Page: { reload: async () => { st.reloads++; } } };
  c.appText = async () => { for (const s of script) if (st.reloads <= s.untilReload) return s.text; return script[script.length - 1].text; };
  c.evalApp = async () => ""; c.record = async () => {}; c.step = () => {};
  return { c, st };
}

{ // a spell of 3 reloads: the read waits it out and arrives on the page that follows, with a fresh timeout
  const { c, st } = fake([{ untilReload: 2, text: SUSPENDED }, { untilReload: 99, text: "Wrenfield\nPatients\nFind a patient by last name" }]);
  const e0 = Crawler.suspendEpisodes, w0 = Crawler.suspendWaitedMs;
  const t = Date.now(); const arrived = await c.awaitMarker("last name", 300, "goto /patients");
  ok(arrived === true, "a read through a spell arrives once it lifts");
  ok(st.reloads >= 3, `it reloaded until the page changed (${st.reloads} reloads)`);
  ok(Crawler.suspendEpisodes === e0 + 1 && Crawler.suspendWaitedMs - w0 >= 80, "the spell is counted (episodes, ms waited)");
  ok(Date.now() - t < 1500, "and costs the spell, not a timeout");
}
{ // a marker that matches any text (claimReader waits on /./) must not take the suspension page for the page it asked for
  const { c, st } = fake([{ untilReload: 1, text: SUSPENDED }, { untilReload: 99, text: "Contract of State Family Assistance\nAppeal window 120 days" }]);
  ok((await c.awaitMarker(/./, 300, "goto /claims/payers/{id}")) === true && st.reloads >= 2, "a /./ marker waits the spell out instead of arriving on it");
}
{ // the wait is longer than the read's own timeout: the timeout restarts after the spell
  const { c } = fake([{ untilReload: 12, text: SUSPENDED }, { untilReload: 99, text: "Patients: last name" }]);
  ok((await c.awaitMarker("last name", 100, "goto /patients")) === true, "a spell longer than the read's timeout does not use it up");
}
{ // an ordinary miss still times out as before
  const { c, st } = fake([{ untilReload: 99, text: "Wrenfield\nSomething else" }]);
  const t = Date.now(); const arrived = await c.awaitMarker("last name", 150, "goto /patients");
  ok(arrived === false && st.reloads === 0 && Date.now() - t >= 140, "no suspension page: a plain marker timeout, no reloads");
}
{ // budget spent: the legacy behaviour (a marker timeout), no more waiting
  const { c, st } = fake([{ untilReload: 99, text: SUSPENDED }]);
  const w = Crawler.suspendWaitedMs; Crawler.suspendWaitedMs = Crawler.SUSPEND_BUDGET_MS;
  const arrived = await c.awaitMarker("last name", 150, "goto /patients");
  ok(arrived === false && st.reloads === 0, "budget spent → falls back to the marker timeout");
  Crawler.suspendWaitedMs = w;
}
{ // a typed-form read that failed during a spell runs once more; one that failed without a spell does not
  const { c } = fake([{ untilReload: 99, text: "x" }]);
  let runs = 0;
  const r1 = await c.againAfterSuspension(async () => { runs++; if (runs === 1) Crawler.suspendEpisodes++; return runs === 1 ? [] : [1]; }, (r: unknown[]) => r.length === 0);
  ok(runs === 2 && r1.length === 1, "failed during a spell → once more, on the lifted account");
  runs = 0;
  const r2 = await c.againAfterSuspension(async () => { runs++; return []; }, (r: unknown[]) => r.length === 0);
  ok(runs === 1 && r2.length === 0, "failed without a spell → not repeated");
  runs = 0;
  const r3 = await c.againAfterSuspension(async () => { runs++; Crawler.suspendEpisodes++; return [1]; }, (r: unknown[]) => r.length === 0);
  ok(runs === 1 && r3.length === 1, "a spell but the read succeeded → not repeated");
}
{ // the page-load governor ("1:3" = at most 3 loads in any 1 s): three go through at once, the fourth and fifth wait for the window
  const t = Date.now(); const at: number[] = [];
  for (let i = 0; i < 5; i++) { await Crawler.navGate(); at.push(Date.now() - t); }
  ok(at[2] < 100, `3 loads pass at once (${at.join(", ")} ms)`);
  ok(at[3] >= 950 && at[3] < 1300, `the 4th waits for the 1 s window (${at[3]} ms)`);
  ok(at[4] >= 950 && at[4] < 1400, `and the 5th (${at[4]} ms)`);
  ok(Crawler.navDelayedMs >= 900, "the delay is counted");
}
console.log(fails ? `✗ suspend-test: ${fails} failed` : "✓ suspend-test: all passed");
process.exit(fails ? 1 : 0);
