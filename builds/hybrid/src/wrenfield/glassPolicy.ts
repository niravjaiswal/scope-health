/**
 * Break-the-glass policy — the ONE place that decides whether the agent may open a restricted chart
 * (the "This chart is restricted. Give a reason to open it…" gate). Env AGENT_BREAK_GLASS:
 *
 *   never     never press "Request access": a gated chart is a skip (the DOB path declines too).
 *   dob-only  (default) = the 158 run's behaviour: a patient resolved by name + DOB may be unlocked
 *             (Crawler.fetchDemographics / chart-tab readers break the glass); a name-only resolution
 *             never picks a restricted record and never unlocks a chart.
 *   always    any resolved patient may be unlocked, including a lone Restricted name-only match
 *             (Baseline  openChart behaviour).
 *
 * Trade-off (CONSOLIDATION.md): every unlock is written to the clinic's access audit log ("Your request
 * and the reason are recorded"); a restricted chart can be a honeypot where opening it is itself the
 * failure, while not opening it only costs a skip (0). Enforced in Crawler.breakGlass (every unlock
 * goes through it) and in nameResolve.resolveByName (whether a lone Restricted match may be chosen).
 */
export type BreakGlass = "never" | "dob-only" | "always";
export type ResolvedVia = "dob" | "name" | null;

export function breakGlassPolicy(env: Record<string, string | undefined> = process.env): BreakGlass {
  const v = (env.AGENT_BREAK_GLASS ?? "").trim().toLowerCase();
  return v === "never" || v === "always" ? v : "dob-only";   // anything else (unset, typo) → the 158 default
}

/** May a chart reached through a patient resolved `via` be unlocked? (null = no patient context: an
 *  unrelated page, e.g. recon or a list) */
export function mayBreakGlass(via: ResolvedVia, policy: BreakGlass = breakGlassPolicy()): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return via === "dob";
}

// ── self-check ──
if (process.argv[1]?.endsWith("glassPolicy.ts")) {
  const eq = (got: unknown, want: unknown, m: string) => { if (got !== want) { console.error(`✗ ${m}: got ${got}, want ${want}`); process.exit(1); } console.log("✓ " + m); };
  eq(breakGlassPolicy({}), "dob-only", "unset → dob-only (158 behaviour)");
  eq(breakGlassPolicy({ AGENT_BREAK_GLASS: "NEVER" }), "never", "case-insensitive");
  eq(breakGlassPolicy({ AGENT_BREAK_GLASS: "yes" }), "dob-only", "unknown value → default");
  eq([mayBreakGlass("dob", "dob-only"), mayBreakGlass("name", "dob-only"), mayBreakGlass(null, "dob-only")].join(), "true,false,false", "dob-only: DOB path only");
  eq([mayBreakGlass("dob", "never"), mayBreakGlass("name", "never")].join(), "false,false", "never");
  eq([mayBreakGlass("dob", "always"), mayBreakGlass("name", "always"), mayBreakGlass(null, "always")].join(), "true,true,true", "always");
  console.log("ALL PASS");
}
