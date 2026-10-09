/**
 * Risk-audit guards: extra DECLINES on answer paths that were new in the 265 image (lookup, name-only context, end-form proofs).
 * Every guard only turns an answer into a skip, never the other way. `AGENT_GUARD_<NAME>=off|on` sets one; `AGENT_GUARDS=off`
 * switches them all off (the 265 behaviour); a per-guard `on` wins over the master switch. Defaults are the recommended ones.
 *   LOOKUP_TIME      lookup: a question that asks for a time of day / "date and time" is never answered with a bare date
 *   CHART_TIME       chartAnswers (the 278 path): the same for "last / first appointment" asked as date AND time
 *   LOOKUP_ACTIVITY lookup: activity-log answers only from a named entry kind that our own chart opens cannot change
 *   LOOKUP_INS_DATE  lookup: insurance blocks show today's coverage — a dated or past-tense coverage question declines
 *   LOOKUP_SYN_DATE  lookup: "diagnosed" / "arrived" name the onset / received date column only in a when / what-date question
 *   LOOKUP_RECURRING lookup: a chart with recurring appointment series is never answered from its appointments table (the series occurrences are not rows)
 *   LOOKUP_PROVIDER  lookup: a name without a DOB that is also on the provider roster is not taken for a patient
 *   LOOKUP_EDGE      lookup: "last / first appointment" with no status named needs the edge row to be a Completed visit
 */
export function guard(name: string, dflt = true): boolean {
  const own = process.env[`AGENT_GUARD_${name}`];
  const v = own !== undefined ? own : process.env.AGENT_GUARDS === "off" ? "off" : undefined;
  return v === undefined ? dflt : !/^(?:off|0|false|no)$/i.test(v);
}
