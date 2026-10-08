# speedrun.scopehealth.com desktop-SPA windows (captured 2026-10-08 ~19:20 EDT, verbatim innerText)


## Window: welcome
```
×
−
+
Welcome to Speedrun
Speedrun
Register

Questions? Email ashank@scopehealth.com
or text 609-216-2842.
```


## Window: prizes
```
Prizes
FIRST PLACE
$5,000
Split among team members, and an iPhone Duo for each team member.
For the final ranking, each team's last submission runs once more on a final set nobody has seen, and that score is added in. Final standings and prizes at the fireside chat on Friday, Oct 9 at 7:30 PM in CCCB 3460.
IPHONE DUO
SECOND PLACE
$3,000
Split among team members.
THIRD PLACE
AirPods Pro
A pair for each team member.
Teams of 1 to 3.
```


## Window: messages
```
Messages
Sign in to read messages from the organizers.
Sign in
```


## Window: board
```
Leaderboard
Rank	Team	Set 1	Set 2	Set 3	Points ▾
1	speedrun squad	167	112	46	325
2	riz	180	83	24	287
3	coins	185	34	59	278
4	anonymous_pizza_lovers	167	27	40	234
5	AK	173	31	17	221
6	tonylicious	147	29	43	219
7	JhunxMarble	157	19	32	208
8	To be healthy	93	29	37	159
9	DuncanLarzelere team	122	25	8	155
10	krillion	66	43	46	155
11	wow	98	19	37	154
12	Physical Realities	71	6	1	78
13	Kaicheng	35	16	7	58
14	Sammy Jankis	41	-2	6	45
15	Name	19	-1	18	36
16	nomos	2	15	15	32
17	CreamOfWheat	-14	4	12	2
18	teamsters	-70	-40	-62	-172
Current standings.
Each team's latest finished submission, with its points on the scored sets (Set 1, Set 2 and Set 3) added up. A team can have at most 908 points. Updated 7:19 PM.
Refresh
Submissions
Tasks
Teams
18
Submissions
211
Last submission
Oct 8, 6:27 PM
Points by team
```


## Window: about
```
About Scope
Scope
Scope is the agent workspace for healthcare. Clinicians hand off work, and agents do it inside the systems they already use.
Visit scopehealth.com
```


## Window: trash
```
Things your agent should throw away before its next shift.
Empty
Name ▴	Date Modified	Size	Kind
screenshots_of_every_page	Today, 9:41 AM	2.3 GB	Folder (947 items)
retry_until_it_works.py	Today, 9:38 AM	4 KB	Python Script
hardcoded_answers.json	Yesterday, 11:02 PM	12 KB	JSON Document
selectors_that_broke.txt	Yesterday, 6:15 PM	1 KB	Plain Text
sleep(60).js	Oct 1, 2026	1 KB	JavaScript
5 items, 1.21 TB available
```


## Window: Library — organizer reading list: "Work on making agents faster at tasks they've done before." (30 items; links from the page DOM)
Papers:
- OSWorld-Human: Benchmarking the Efficiency of Computer-Use Agents (Abhyankar et al. 2025) https://arxiv.org/abs/2506.16042
- SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills (Zheng et al. 2025) https://arxiv.org/abs/2504.07079
- ReUseIt: Synthesizing Reusable AI Agent Workflows for Web Automation (Liu et al. 2025) https://arxiv.org/abs/2510.14308
- Inducing Programmatic Skills for Agentic Tasks (ASI, Wang et al. 2025) https://arxiv.org/abs/2504.06821
- Agent Workflow Memory (Wang et al. 2024) https://arxiv.org/abs/2409.07429
- Beyond Browsing: API-Based Web Agents (Song et al. 2024) https://arxiv.org/abs/2410.16464
- Agent JIT Compilation for Latency-Optimizing Web Agent Planning and Scheduling (ICML 2026) https://agent-jit-compilation.github.io/
- Get Experience from Practice: LLM Agents with Record & Replay (Feng et al. 2025) https://arxiv.org/abs/2505.17716
- Agentic Plan Caching: Test-Time Memory for Fast and Cost-Efficient LLM Agents (Zhang et al. 2025) https://arxiv.org/abs/2506.14852
- WebXSkill: Skill Learning for Autonomous Web Agents (Wang et al. 2026) https://arxiv.org/abs/2604.13318
- Online Skill Learning for Web Agents via State-Grounded Dynamic Retrieval (Li et al. 2026) https://arxiv.org/abs/2606.04391
- API Agents vs. GUI Agents: Divergence and Convergence (Zhang et al. 2025) https://arxiv.org/abs/2503.11069
- Build the web for agents, not agents for the web (Lù et al. 2025) https://arxiv.org/abs/2506.10953
- Voyager (Wang et al. 2023) https://arxiv.org/abs/2305.16291
Posts & docs:
- Show HN: Workflow Use (Browser Use) https://news.ycombinator.com/item?id=44007065
- Stagehand v3: Faster AI Automation, No Playwright (Browserbase) https://www.browserbase.com/blog/stagehand-v3
- Caching actions (Stagehand docs) https://docs.stagehand.dev/v4/best-practices/caching
- How to Reverse-Engineer a Website's Private API (Integuru) https://www.integuru.com/blog/reverse-engineer-website-private-api
- Unbrowse blog https://www.unbrowse.ai/blog
- Action Caching & Replay (Agentic Patterns) https://www.agentic-patterns.com/patterns/action-caching-replay
- Beyond Browsing project page https://yueqis.github.io/API-Based-Agent/
Code:
- https://github.com/browser-use/workflow-use
- https://github.com/browserbase/stagehand
- https://github.com/kalil0321/reverse-api-engineer
- https://github.com/Integuru-AI/Integuru
- https://github.com/OSU-NLP-Group/SkillWeaver
- https://github.com/zorazrw/agent-skill-induction
- https://github.com/zorazrw/agent-workflow-memory
- https://github.com/yueqis/API-Based-Agent
- https://github.com/MineDojo/Voyager

## Window: Agent interface
```
Agent interface.rtf
This document describes what a run gives your agent’s program and what the program sends back. The kit’s docs/shift.md has the same rules.
What your program gets at start
The judge starts your image once per run and sets these environment variables.
Variable	What it holds
QUEUE_URL	Base URL of the queue API
SHIFT_SECONDS	The run’s length in seconds
SITE_URL	Address of the clinic’s product
SITE_USERNAME, SITE_PASSWORD	The agent’s sign-in to the product
LLM_BASE_URL	The model endpoint, OpenAI-compatible, ending in /v1
LLM_API_KEY	Key for the model endpoint, valid for this run only
WORK_DIR	A writable directory
The shift’s clock starts when the container starts. Time the agent spends before it asks for its first item counts against the shift. The agent serves nothing, and the judge never connects to it.
The loop
The queue API has two routes, with JSON bodies. Every request is answered at once, so the agent can hold an item as long as it likes without keeping a connection open. The agent gets the next item only after it has closed the current one.
Get the current item
GET $QUEUE_URL/item returns the state of the queue. It returns the same open item, with the same id, until that item is closed. A message and a task look like this (item texts shortened; every item is plain text):
{ "status": "open", "seconds_left": 1187.2,
  "item": { "id": "i001", "kind": "message",
            "text": "From today, ..." } }
{ "status": "open", "seconds_left": 1186.9,
  "item": { "id": "i002", "kind": "task",
            "text": "Is ... ?" } }
kind is task or message. id is what the close request names the item by, and it carries no other meaning. seconds_left is the time left on the shift’s clock.
Close it
POST $QUEUE_URL/item/close closes the open item. The body has the item’s id and exactly one other field.
Field	Closes
"answer": a string, a number, or a list of strings and numbers	a task
"skip": true	a task
"acknowledge": true	a message
POST /item/close  { "id": "i001", "acknowledge": true }
POST /item/close  { "id": "i002", "answer": "NO" }
POST /item/close  { "id": "i003", "skip": true }
A task is answered or skipped. A correct answer scores +1, a wrong answer −1, and a skip 0. A closed task cannot be reopened. A message is closed by acknowledging it and scores nothing, but later tasks may depend on what it says.
The response is the state after the close, in the same form as GET /item: the next open item, or the end of the run. It does not say whether an answer was correct. Requests are handled one at a time, in the order they arrive.
When the shift ends
The shift ends when its time is over, when the last item is closed, or when your container exits. From then on the state is one of these:
{ "status": "ended", "reason": "time" }
{ "status": "ended", "reason": "queue_finished" }
A close counts if its request arrives before the shift ends. A close that arrives later is refused with 409 ended, and its state says why the shift ended. Tasks the agent did not reach score 0.
When an item was already closed
A close that names an id other than the open item’s is refused with 409 not_current. The open item stays open, and state in the response is the current state, so the agent can go on from it:
POST /item/close  { "id": "i002", "answer": "NO" }
409 {
  "error": { "code": "not_current",
             "message": "item i002 is not the open item" },
  "state": { "status": "open", "seconds_left": 1140.6,
             "item": { "id": "i003", "kind": "task",
                       "text": "How many ... ?" } }
}
Errors
An error has this body, where state is present only for not_current and ended:
{ "error": { "code": "...", "message": "..." }, "state": ... }
Status	Code	When	The open item
400	bad_request	The body is not JSON, or is none of the three forms above	stays open
404	not_found	Any other route or method	
409	not_current	The id is not that of the open item. state is the current state	stays open
409	ended	The run has ended. state says why	
413	too_large	The body is larger than 1048576 bytes	stays open
422	wrong_action	An answer or a skip for a message, or an acknowledgement for a task	stays open
503	unavailable	The judge could not handle the request. The run ends as a failure on the organizers’ side	
Answer forms
Your answer and the expected one are both put into the same normal form and then compared. The differences listed here do not count against you. Any other difference does.
When a message sets the form of the answer
A message that describes a workflow says how to write its answers and gives examples. These answers are compared as text.
Case, spaces at the start and end, spaces next to : and ,, and several spaces in a row are ignored. ok:3, 4 and OK:3,4 are the same answer.
Everything else must match the form character for character: each digit, including leading and trailing zeros, the decimal point, a $ sign, hyphens, and the order of the values.
Send one string. A list is a wrong answer, even when the form has several values; join them with commas as the form shows.
A JSON number is read in its shortest form, so 2.50 becomes 2.5. Where the form shows 2.50, send the string "2.50".
Do not add quotes, backticks, or words around the answer.
Other questions
Every other task is a question about the clinic’s data, and the answer is compared by the kind of value it asks for. Each form in a row is accepted.
Kind	What is accepted, and examples that are equal to each other
Whole number	A JSON number or a string. A string may have a leading $, a trailing %, a sign, and commas between thousands. It must be a whole number with no words.
1204
"1204"
"1,204"
Amount or other number with decimals	The same forms. Compared as numbers, within a tolerance the question sets: half a cent for an amount of money. For other values the tolerance can be zero, so send the value as the product shows it, or rounded as the question says.
12.5
"12.50"
"$12.50"
Date	A string: 2026-11-01, 2026/11/01, 11/01/2026 (month first), November 1, 2026, Nov 1 2026, or 1 November 2026. A time after the date is ignored when it follows a space or T and is written as in the next row. Any other text after the date makes the answer wrong.
"2026-11-01"
"11/01/2026"
Date and time	A date as above, then a time: 09:20, 9:20, 9:20 AM, or 09:20:00, after a space, T, at, or a comma.
"2026-11-01T09:20"
"Nov 1 2026 at 9:20 AM"
Phone number	A string or a JSON number: digits with spaces, parentheses, dots, hyphens, or +. Ten digits, or eleven starting with 1.
"(512) 555-0142"
"+1 512 555 0142"
Text: a name, a username, an ID, an address	A string. A JSON number is read as text, which drops leading zeros. Case, spaces at the start and end, and several spaces in a row are ignored.
"Jane Smith"
"jane  smith"
List	A JSON list of strings, or one string with the items separated by commas, semicolons, or new lines. Each item is compared as text. Order and repeats do not matter, unless the question asks for an order.
["Jane Smith", "Ali Khan"]
"Ali Khan; Jane Smith"
These points are stricter than they may look:
In text, punctuation and words count. Smith, Jane is not Jane Smith, and 12 Oak St is not 12 Oak Street. Copy the value as the product shows it, in the form the question asks for.
A date written with slashes and the year last is read month first: 01/11/2026 is January 11.
A time is the clock time in the time zone the question names. A Z or a UTC offset at the end is dropped, not converted. Seconds count when they are not zero.
A list sent as one string is split at every comma. An item that contains a comma must be sent in a JSON list.
A whole number must be whole and bare: 12.5 and 12 patients are wrong answers to it, and 12.0 is accepted.
There are no true or false answers. JSON true and false are refused with 400 bad_request, and the task stays open.
An empty string is a wrong answer and scores −1. To skip a task, send "skip": true.
The model endpoint
The model endpoint is at LLM_BASE_URL, which ends in /v1. It is an OpenAI-compatible proxy to OpenRouter. It takes the header Authorization: Bearer $LLM_API_KEY and serves these routes:
POST /v1/chat/completions
POST /v1/completions
POST /v1/embeddings
POST /v1/responses
GET  /v1/models
The model field is an OpenRouter model id. Any model on OpenRouter can be used, except models with web search or browsing built in.
Up to 32 requests of a run can be in progress at once, and a request may take up to 120 seconds. Each set has a model budget, paid by Scope and enforced by the proxy. Once it is spent, further requests are refused and the run goes on.
Set	Model budget
Practice	$1
Set 1	$8
Set 2	$8
Set 3	$15
Final	$25
The endpoint refuses a request with one of these:
Status	Code	When
400	policy_violation	A model id in model or models starts with @preset/, ends in :online, or contains sonar, search-preview, or deep-research; the body has a plugins or web_search_options field; a tool’s type contains web_search or web_fetch; or a message’s content names a web address in a url field, where only data: URLs are accepted
402	cost_cap_reached	The set’s model budget is used up. Every later POST gets this answer
429	concurrency_limit	32 requests of the run are already in progress
504	upstream_timeout	The request took longer than 120 seconds. A streamed answer that has already begun keeps its status and ends with a data: line that holds this error
It also answers 401 invalid_api_key for a missing or unknown key, 404 not_found and 405 method_not_allowed for any other route or method, 400 invalid_json for a body that is not JSON, and 502 with a code that starts with upstream_ when the model provider could not be reached or its answer could not be read. An error of the model provider itself is passed on unchanged, with the provider’s status and body. That status can also be 429.
The sandbox
Your container runs on a private network with no route to the internet. It can reach the three addresses the environment variables give it, and nothing else. A connection to any other address fails, and names on the internet do not resolve. Everything the agent needs must be in the image, because nothing can be downloaded during a run.
Address	Variable	How to use it
The queue API	QUEUE_URL	HTTP with JSON bodies: the two routes under “The loop”.
The clinic’s product	SITE_URL	The same web product as the practice clinic, with this clinic’s data. Sign in at $SITE_URL/login with SITE_USERNAME and SITE_PASSWORD; the session is a cookie. Your agent can drive the pages with a browser or send the same HTTP requests itself.
The model endpoint	LLM_BASE_URL	An OpenAI-compatible proxy to OpenRouter, with Authorization: Bearer $LLM_API_KEY, described under “The model endpoint”. It is the only way to a model: OpenRouter’s own address and every other provider are unreachable.
The addresses are plain http:// addresses on the private network. Read them from the environment rather than writing them into your code. The model endpoint does not fetch addresses for you: a request whose message content names a web address is refused with 400 policy_violation. Files and images go in as data: URLs.
Limits of the container
Resource	Limit
CPUs	4
Memory	8192 MiB (8 GB), no swap
Shared memory	1024 MiB
Processes	2048
Disk	10240 MiB (10 GB) in WORK_DIR
Output kept	100 MB
Image size	At most 8192 MiB
Network	Only the queue API, the product, and the model endpoint
Privileges	No Linux capabilities, and the agent cannot gain privileges
A minimal agent
This Python program acknowledges every message and skips every task, so it scores 0 on any set. An agent that scores has the same loop and sends {"id": item["id"], "answer": ...} when it has found an answer in the product.
import os, requests
queue = os.environ["QUEUE_URL"]
state = requests.get(f"{queue}/item").json()
while state["status"] == "open":
    item = state["item"]
    if item["kind"] == "message":
        body = {"id": item["id"], "acknowledge": True}
    else:
        body = {"id": item["id"], "skip": True}
    resp = requests.post(f"{queue}/item/close", json=body)
    data = resp.json()
    # A 200 body is the next state, and a 409 body carries it.
    # Any other error has no state, which stops the loop.
    if not resp.ok:
        data = data.get("state", {"status": "error"})
    state = data
print("shift over:", state)
A complete example
The Reference agent document describes the agent in the kit, which signs in to the product with a browser and answers tasks with a model.
```


## Window: Reference agent
```
Reference agent.rtf
The kit includes a reference agent in reference-agent/. It works a shift from start to end and shows one way to use the Agent interface.
What it is
The reference agent is a Node program. For each task it starts a new session of OpenCode, an open-source coding agent, which has a headless Chromium browser and a shell. The session calls anthropic/claude-sonnet-5.5 through the run’s model endpoint at LLM_BASE_URL with LLM_API_KEY. A session may take at most 150 seconds, and it is stopped 4 seconds before the run’s time is up. When the session has not produced an answer by then, the agent skips the task. When fewer than 20 seconds are left for a session, the agent skips the task without starting one.
How it handles items
The agent asks the queue for its first item as soon as it starts, without looking at the product first (src/shift.ts). It acknowledges each message at once and keeps the message’s text for the rest of the run.
For a task, it builds a prompt (src/shiftPrompt.ts) with the product’s address and sign-in, the text of every message so far in the order they arrived, the task, the seconds available, and the scoring. The prompt tells the model to answer only from data it found in the product, to answer null otherwise, and not to change any data. The model is asked to write its checked answer to a file, answer.json, and then to reply with the answer inside <answer> tags.
When the session ends, the agent takes the last answer tag in the model’s reply, or, if there is none, the content of answer.json (src/answer.ts). An empty answer or null becomes a skip. Text that reads as JSON (a string, a number, or a list of them) is sent as that value, and any other text is sent as it is. If the queue refuses a close with not_current or ended, the agent goes on from the state in the refusal. When the run has ended, the process exits with status 0, and with status 1 if it could not go on (src/shiftProcess.ts).
It keeps nothing from one task to the next except the messages. Every task signs in again and finds its way through the product again, which costs time and model spend.
Build and run it
From the kit directory, build the image. The build needs internet access, because it installs the Node packages, OpenCode, and Chromium. The image is about 1.8 GB.
docker build -t my-agent reference-agent
Then run it on the practice set. --agent my-agent uploads the local image first. To use an image you have already uploaded with arena push my-agent, pass --image <id> instead.
arena test --set practice --agent my-agent
arena test --set practice --image <id>
The command prints the agent’s output as the run goes on, then the record of the run. The Getting Started guide has the other arena commands.
Its score
On October 5 it scored 0 on the practice set: 0 correct, 0 wrong, and 6 skipped. It ran out of its own 150 seconds on five tasks and skipped the sixth. It is there to show the interface working, and it is slow. Set 1 has 224 tasks in 15 minutes, about 4 seconds per task, and the agent gives each task up to 150 seconds.
What to change first
src/shift.ts, workTask: each task starts a new OpenCode session with a new browser, which signs in again. Keeping a signed-in browser across tasks, and keeping what the agent learned about the product, saves that time on every later task.
src/config.ts: defaultModel and REFERENCE_TASK_SECONDS set the model and the time per task. Both can also be set with ENV in the Dockerfile, as REFERENCE_MODEL and REFERENCE_TASK_SECONDS.
src/shiftPrompt.ts: the prompt of one task. What you know about the product from looking around in it can go here, or into REFERENCE_NOTES, which is added to the prompt of every task.
reference-agent/README.md lists every file. The types of the queue API are in contracts/src/shiftProtocol.ts as zod schemas you can copy into an agent of your own.
```


## Window: Rules
```
Rules.rtf
Inside its container, your agent connects only to the three addresses in its environment: QUEUE_URL, SITE_URL, and LLM_BASE_URL. No other network connection, directly or through a model or tool that reaches the web. What it sends to those three addresses is not restricted.
Do not access systems you were not given: the judge's host, the admin interfaces of the clinic product and the model endpoint, other teams' images, runs, submissions, and accounts, and the competition's source code and configuration. What your own account shows you is yours to use.
Do not try to crash or overload the site, the judge, the queue, the model endpoint, or the clinic product. This does not limit how much your agent uses the clinic product during its own run.
One account and one team per person.
Anything not on this list is allowed.
```
