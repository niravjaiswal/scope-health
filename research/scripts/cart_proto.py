"""cartographer: protocol properties of /v/<rand>/ URLs (reuse, cross-session, fp requirement). Read-only GET/POST of page loads only."""
import asyncio, time, sys, os, re
import httpx
from playwright.async_api import async_playwright
BASE = "https://practice.speedrun.scopehealth.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 1000}, bypass_csp=True)
        pg = await ctx.new_page()
        posts = []
        pg.on("request", lambda r: posts.append((r.url, r.post_data, r.frame.url if r.frame else None)) if r.method == "POST" else None)
        await pg.goto(BASE + "/patients/03q14ndmmd", wait_until="networkidle")
        fr = [f for f in pg.frames if "/v/" in f.url][-1]
        ifr_url = fr.url
        print("iframe url", ifr_url)
        print("posts", posts)
        cookies = {c["name"]: c["value"] for c in await ctx.cookies()}
        # 1. re-GET the iframe document with same session (httpx, no browser)
        async with httpx.AsyncClient(cookies=cookies, follow_redirects=False) as hc:
            r = await hc.get(ifr_url)
            print("re-GET same session:", r.status_code, len(r.text), re.findall(r"<h1[^>]*>(.*?)</h1>", r.text)[:1])
            r = await hc.get(ifr_url)
            print("re-GET again:", r.status_code, len(r.text))
            # shell via httpx
            r = await hc.get(BASE + "/patients/6sqtnhdpq1")
            print("shell GET via httpx:", r.status_code, len(r.text), "has iframe in raw shell?", "<iframe" in r.text)
            # replay the initial POST with the same body (same token+fp)
            url, body, _ = posts[0]
            r = await hc.post(url, content=body, headers={"content-type": "application/x-www-form-urlencoded"})
            print("replay initial POST:", r.status_code, r.text[:200].replace("\n", " "))
            # POST with wrong fp
            body2 = re.sub(r"=([0-9a-z]+)$", "=abc123", body)
            r = await hc.post(url, content=body2, headers={"content-type": "application/x-www-form-urlencoded"})
            print("POST wrong fp:", r.status_code, r.text[:200].replace("\n", " "))
        # 2. other session
        async with httpx.AsyncClient(follow_redirects=False) as hc2:
            r = await hc2.get(ifr_url)
            print("GET iframe from cookieless session:", r.status_code, len(r.text), r.headers.get("location"))
            r = await hc2.get(BASE + "/patients/03q14ndmmd")
            print("shell GET w/o cookie:", r.status_code, r.headers.get("location"), "set-cookie" in r.headers)
            r = await hc2.get(BASE + "/login")
            print("GET /login w/o cookie:", r.status_code, r.headers.get("location"), r.text[:300].replace("\n", " "))
        # 3. after navigating elsewhere, is old iframe url still valid?
        await pg.goto(BASE + "/patients/6sqtnhdpq1", wait_until="networkidle")
        async with httpx.AsyncClient(cookies=cookies) as hc:
            r = await hc.get(ifr_url)
            print("old iframe url after another nav:", r.status_code, len(r.text))
        # 4. navigate the iframe itself to a deep link (frame.goto)
        fr = [f for f in pg.frames if "/v/" in f.url][-1]
        try:
            await fr.goto(BASE + "/patients/03q14ndmmd/insurance", wait_until="domcontentloaded")
            print("frame.goto deep link ->", fr.url, (await fr.inner_text("body"))[:200].replace("\n", " | "))
        except Exception as e:
            print("frame.goto error", e)
        await b.close()

asyncio.run(main())
