/**
 * Re-login when the session ends mid-shift (Site C bench, 278 image: the session expired at 600 s, the site sent every page to its
 * sign-in form, and the agent never signed in again: 69 answerable tasks closed with no page read). crawl.ts awaitMarker now: on a
 * sign-in page (short "sign in / password" text AND a password field or /login in the top document) signs in again with the shift's
 * credentials, sets the location picker back to All locations, and repeats the read once. The suspension page is waited out, never
 * signed in again (suspend-test).
 *   npx tsx src/wrenfield/relogin-test.ts
 */
export {};
process.env.AGENT_SUSPEND_POLL_MS = "40";
process.env.AGENT_SUSPEND_WAIT_S = "5";
process.env.AGENT_NAV_CAP = "1:3,5:100";
const { Crawler } = await import("./crawl.js");

let fails = 0;
const ok = (c: unknown, m: string) => { if (c) console.log("✓ " + m); else { fails++; console.error("✗ " + m); } };
const LOGIN = "Sign in to Wrenfield\nUsername\nPassword\nSign in";
const SUSPENDED = "Wrenfield\nThis account is suspended\n\nYou cannot use Wrenfield with this account at the moment. Try again later, or ask your practice administrator.";
const PATIENTS = "Wrenfield\nPatients\nFind a patient by last name, date of birth, or MRN.";

ok(Crawler.looksLikeLogin(LOGIN), "the sign-in page text is a sign-in cue");
ok(!Crawler.looksLikeLogin(PATIENTS), "an ordinary page is not");
ok(!Crawler.looksLikeLogin(SUSPENDED), "the suspension page is not");
ok(!Crawler.looksLikeLogin("Chart note: patient forgot the portal password, asked how to sign in.\n" + "x".repeat(1600)), "a long chart page that mentions a password is not");

/** A Crawler with no browser: a session that is signed out until login() runs. */
function fake(opts: { loginOk?: boolean; text?: () => string } = {}) {
  const c: any = new Crawler("http://x", "/tmp/relogin-test-profile");
  const st = { signedIn: false, logins: 0, pickerResets: 0, navigations: [] as string[] };
  c.client = { Page: { navigate: async ({ url }: { url: string }) => { st.navigations.push(url); }, reload: async () => {} } };
  c.appText = async () => (opts.text ? opts.text() : st.signedIn ? PATIENTS : LOGIN);
  c.evalTop = async (expr: string) => (/password/.test(expr) ? !st.signedIn : "");
  c.evalApp = async () => ""; c.record = async () => {}; c.step = () => {};
  c.login = async () => { st.logins++; if (opts.loginOk !== false) st.signedIn = true; return opts.loginOk !== false; };
  c.setAllLocations = async () => { st.pickerResets++; };
  c.pickerLabel = async () => "Location: All locations";
  return { c, st };
}

Crawler.creds = { user: "u", pass: "p" };
{ // expired session: the read signs in again, resets the picker, re-navigates to the page and arrives
  const { c, st } = fake(); const n0 = Crawler.relogins;
  const arrived = await c.awaitMarker("last name", 800, "goto /patients", "", true, "/patients?lastName=Hill");
  ok(arrived === true, "a read on an ended session arrives after signing in again");
  ok(st.logins === 1 && Crawler.relogins === n0 + 1, `one sign-in (${st.logins}), counted (relogin ${Crawler.relogins - n0})`);
  ok(st.pickerResets === 1, "the location picker is set back to All locations");
  ok(st.navigations.at(-1) === "http://x/patients?lastName=Hill", "the read's page is loaded again: " + st.navigations.at(-1));
}
{ // sign-in fails: the read does not loop on it; it times out as before, after one attempt
  const { c, st } = fake({ loginOk: false });
  const t = Date.now(); const arrived = await c.awaitMarker("last name", 400, "goto /patients", "", true, "/patients");
  ok(arrived === false && st.logins === 1, `a failed sign-in is tried once (${st.logins}) and the read fails`);
  ok(Date.now() - t < 2500, "within its timeout");
}
{ // a second failed sign-in in a row: no more attempts this shift
  const { c, st } = fake({ loginOk: false });
  await c.awaitMarker("last name", 200, "goto /patients", "", true, "/patients");
  const again = fake({ loginOk: false }); await again.c.awaitMarker("last name", 200, "goto /patients", "", true, "/patients");
  ok(st.logins === 1 && again.st.logins === 0 && Crawler.reloginFails >= 2, `after two failed sign-ins in a row no more attempts (${st.logins}, ${again.st.logins})`);
  Crawler.reloginFails = 0;
}
{ // no credentials (a no-auth clinic): never tries
  const saved = Crawler.creds; Crawler.creds = null;
  const { c, st } = fake();
  const arrived = await c.awaitMarker("last name", 200, "goto /patients", "", true, "/patients");
  ok(arrived === false && st.logins === 0, "no credentials → no sign-in attempt");
  Crawler.creds = saved;
}
{ // the suspension page is waited out, not signed in again
  let reloads = 0; const { c, st } = fake({ text: () => (reloads < 2 ? SUSPENDED : PATIENTS) });
  c.client.Page.reload = async () => { reloads++; };
  st.signedIn = true; // the password probe answers "no form"
  const arrived = await c.awaitMarker("last name", 400, "goto /patients", "", true, "/patients");
  ok(arrived === true && st.logins === 0, "a suspension spell is waited out with no sign-in");
}
{ // a marker that matches anything (/./, claimReader) never takes the sign-in page for the awaited page
  const { c, st } = fake();
  const arrived = await c.awaitMarker(/./, 800, "goto /claims", "", true, "/claims");
  ok(arrived === true && st.logins === 1, "the /./ marker waits for the signed-in page");
}
console.log(fails ? `✗ relogin-test: ${fails} failed` : "✓ relogin-test: all passed");
process.exit(fails ? 1 : 0);
