# Sets, runs, and submissions

## The shift

Your agent works one shift in the back office of a clinic. The clinic runs its work in a web
product, and your agent has its own sign-in to it. A queue of items is waiting. The agent takes
one item at a time, and it gets the next item only after it has closed the current one. Every
item is plain text.

- A **task** asks for one answer. The agent answers it or skips it. A correct answer scores +1,
  a wrong answer -1, and a skipped task 0. An answer is compared with the expected one, as
  described under "How answers are compared". A closed task cannot be reopened.
- A **message** tells the agent something. The agent closes it by acknowledging it. It scores
  nothing. Later tasks may depend on it.

The shift has a fixed length, counted from the moment your agent's container starts. Nothing
else marks the start: the agent asks for its first item when it is ready, and the time it spends
before that is part of the shift. The shift ends when its time is over, when the last item is
closed, or when your container exits. The score is the total of the points of the tasks the
agent closed.

The agent has a fixed amount of model spend. When it is used up, the model endpoint refuses
further requests, and the shift goes on.

Three words name the pieces of this:

- A **set** is a fixed queue of items at one clinic, with the length of the shift and the model
  spend. There is one practice set, three scored sets (Set 1, Set 2, and Set 3), and a final
  set. Each set is at a different clinic, with its own data.
- A **run** is one execution of your image on one set. A practice run is one you start yourself:
  your image, on the practice set, on the judge. Scored runs happen only as part of a submission.
- A **submission** is your image run once on each of the three scored sets. It is what counts
  toward the leaderboard.

You can look around one clinic's product at any time, and the practice set is at that clinic.

## The agent's role

The agent is a member of the clinic's back-office staff. A message may say how a kind of work
is done (a workflow), change a workflow, state a fact, or have nothing to do with the work. When two
messages disagree about the same thing, the later one holds. A scored set can contain kinds of
message that the practice set does not.

## How answers are compared

Your answer and the expected one are both put into the same normal form and then compared.
The differences listed here do not count against you. Any other difference does.

### When a message sets the form of the answer

A message that describes a workflow says how to write its answers and gives examples. These
answers are compared as text:

- Upper and lower case, spaces at the start and end, spaces next to `:` and `,`, and several
  spaces in a row are ignored. `ok:3, 4` and `OK:3,4` are the same answer.
- Everything else must match the form character for character: each digit, including leading
  and trailing zeros, the decimal point, a `$` sign, hyphens, and the order of the values.
- Send one string. A list is a wrong answer, even when the form has several values; join them
  with commas as the form shows. A JSON number is read in its shortest form, so `2.50` becomes
  `2.5`; where the form shows `2.50`, send the string `"2.50"`.
- Do not add quotes, backticks, or words around the answer.

### Other questions

Every other task is a question about the clinic's data, and the answer is compared by the kind
of value it asks for. Each form in a row is accepted, and the examples in a row are equal.

| Kind | What is accepted | Examples |
|---|---|---|
| Whole number | A JSON number or a string. A string may have a leading `$`, a trailing `%`, a sign, and commas between thousands. It must be a whole number with no words | `1204`, `"1204"`, `"1,204"` |
| Amount or other number with decimals | The same forms. Compared as numbers, within a tolerance the question sets: half a cent for an amount of money. For other values it can be zero, so send the value as the product shows it, or rounded as the question says | `12.5`, `"12.50"`, `"$12.50"` |
| Date | A string: `2026-11-01`, `2026/11/01`, `11/01/2026` (month first), `November 1, 2026`, `Nov 1 2026`, or `1 November 2026`. A time after the date is ignored when it follows a space or `T` and is written as in the next row. Any other text after the date makes the answer wrong | `"2026-11-01"`, `"11/01/2026"` |
| Date and time | A date as above, then a time: `09:20`, `9:20`, `9:20 AM`, or `09:20:00`, after a space, `T`, `at`, or a comma | `"2026-11-01T09:20"`, `"Nov 1 2026 at 9:20 AM"` |
| Phone number | A string or a JSON number: digits with spaces, parentheses, dots, hyphens, or `+`. Ten digits, or eleven starting with 1 | `"(512) 555-0142"`, `"512.555.0142"`, `"+1 512 555 0142"` |
| Text: a name, a username, an ID, an address | A string. A JSON number is read as text, which drops leading zeros. Case, spaces at the start and end, and several spaces in a row are ignored | `"Jane Smith"`, `"jane  smith"` |
| List | A JSON list of strings, or one string with the items separated by commas, semicolons, or new lines. Each item is compared as text. Order and repeats do not matter, unless the question asks for an order | `["Jane Smith", "Ali Khan"]`, `"Ali Khan; Jane Smith"` |

Some of these are stricter than you might expect:

- In text, punctuation and words count. `Smith, Jane` is not `Jane Smith`, and `12 Oak St` is
  not `12 Oak Street`. Copy the value as the product shows it, in the form the question asks
  for.
- A date written with slashes and the year last is read month first: `01/11/2026` is January 11.
- A time is the clock time in the time zone the question names. A `Z` or a UTC offset at the
  end is dropped, not converted. Seconds count when they are not zero.
- A list sent as one string is split at every comma. An item that contains a comma must be
  sent in a JSON list.
- A whole number must be whole and bare: `12.5` and `12 patients` are wrong answers to it,
  and `12.0` is accepted.
- There are no true or false answers. JSON `true` and `false` are refused with `bad_request`.
- An empty string is a wrong answer, not a skip.

## The container

The judge starts your image once per run and sets these environment variables:

| Variable | What it holds |
|---|---|
| `QUEUE_URL` | Base URL of the queue API |
| `SHIFT_SECONDS` | The run's length in seconds |
| `SITE_URL` | Address of the clinic's product |
| `SITE_USERNAME`, `SITE_PASSWORD` | The agent's sign-in to the product |
| `LLM_BASE_URL` | The model endpoint, OpenAI-compatible, ending in `/v1` |
| `LLM_API_KEY` | Key for the model endpoint, valid for this run only |
| `WORK_DIR` | A writable directory |

The container runs on a private network with no route to the internet. It reaches the three
addresses these variables give it and nothing else: a connection to any other address fails, and
names on the internet do not resolve. Everything the agent needs must be in the image, because
nothing can be downloaded during a run.

| Address | Variable | How to use it |
|---|---|---|
| The queue API | `QUEUE_URL` | HTTP with JSON bodies: the two routes under "The queue API" |
| The clinic's product | `SITE_URL` | The same web product as the practice clinic, with this clinic's data. Sign in at `$SITE_URL/login` with `SITE_USERNAME` and `SITE_PASSWORD`; the session is a cookie. Your agent can drive the pages with a browser or send the same HTTP requests itself |
| The model endpoint | `LLM_BASE_URL` | An OpenAI-compatible proxy to OpenRouter, with `Authorization: Bearer $LLM_API_KEY`, described below. It is the only way to a model: OpenRouter's own address and every other provider are unreachable |

The addresses are plain `http://` addresses on the private network. Read them from the
environment rather than writing them into your code. The model endpoint does not fetch addresses
for you: a request whose message content names a web address is refused with 400
`policy_violation`, and files and images go in as `data:` URLs. The agent serves nothing: the judge never
connects to it.

Limits of the container: 4 CPUs, 8192 MiB of memory with no swap, 1024 MiB of shared memory,
2048 processes, and 10240 MiB in `WORK_DIR`. It runs with no Linux capabilities and cannot gain
privileges. The image may be at most 8192 MiB.

The model endpoint takes `Authorization: Bearer $LLM_API_KEY` and serves `POST
/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, and `/v1/responses`, and `GET
/v1/models`. The `model` field is an OpenRouter model id. The endpoint refuses a request with
one of these:

| Status | Code | When |
|---|---|---|
| 400 | `policy_violation` | A model id in `model` or `models` starts with `@preset/`, ends in `:online`, or contains `sonar`, `search-preview`, or `deep-research`; the body has a `plugins` or `web_search_options` field; a tool's type contains `web_search` or `web_fetch`; or a message's content names a web address in a `url` field, where only `data:` URLs are accepted |
| 402 | `cost_cap_reached` | The set's model spend is used up. Every later `POST` request gets this answer |
| 429 | `concurrency_limit` | 32 requests of the run are already in progress, or the budget left admits fewer at once (one request per 0.50 USD left, and always at least one) |
| 504 | `upstream_timeout` | The request took longer than 120 seconds. A streamed answer that has already begun keeps its status and ends with a `data:` line that holds this error |

It also answers 401 `invalid_api_key` for a missing or unknown key, 404 `not_found` and 405
`method_not_allowed` for any other route or method, 400 `invalid_json` for a body that is not
JSON, and 502 with a code that starts with `upstream_` when the model provider could not be
reached or its answer could not be read. An error of the model provider itself is passed on
unchanged, with the provider's status and body. That status can also be 429.

## The queue API

The API has two routes, with JSON bodies. Every request is answered at once, so the agent can hold an item
as long as it likes without keeping a connection open.

`GET $QUEUE_URL/item` returns the state of the queue. It returns the same open item, with the
same id, until that item is closed.

```
{ "status": "open", "item": { "id": "...", "kind": "task", "text": "..." }, "seconds_left": 512.4 }
{ "status": "ended", "reason": "time" }
{ "status": "ended", "reason": "queue_finished" }
```

`kind` is `task` or `message`. `id` is what the close request names the item by, and it carries
no other meaning. `seconds_left` is the time left on the shift's clock.

`POST $QUEUE_URL/item/close` closes the open item. The body has the item's `id` and exactly one
other field:

| Field | Closes |
|---|---|
| `"answer"`: a string, a number, or a list of strings and numbers | a task |
| `"skip": true` | a task |
| `"acknowledge": true` | a message |

The response is the state after the close, in the form of `GET /item`: the next item, or the
end of the run. It does not say whether an answer was correct. A close counts if its request
arrives before the run ends. Requests are handled one at a time, in the order they arrive.

An error has the body `{ "error": { "code": "...", "message": "..." }, "state": ... }`, where
`state` is present only for `not_current` and `ended`.

| Status | Code | When | The open item |
|---|---|---|---|
| 400 | `bad_request` | The body is not JSON, or is none of the three forms above | stays open |
| 404 | `not_found` | Any other route or method | |
| 409 | `not_current` | The id is not that of the open item. `state` is the current state | stays open |
| 409 | `ended` | The run has ended. `state` says why | |
| 413 | `too_large` | The body is larger than 1048576 bytes | stays open |
| 422 | `wrong_action` | The open item is a message and the body has an answer or a skip, or it is a task and the body has an acknowledgement | stays open |
| 503 | `unavailable` | The judge could not handle the request. The run ends as a failure on the organizers' side | |

An example exchange (item texts shortened):

```
GET /item
200 { "status": "open", "seconds_left": 1187.2,
      "item": { "id": "i001", "kind": "message", "text": "From today, ..." } }

POST /item/close  { "id": "i001", "acknowledge": true }
200 { "status": "open", "seconds_left": 1186.9,
      "item": { "id": "i002", "kind": "task", "text": "Is ... ?" } }

POST /item/close  { "id": "i002", "answer": "NO" }
200 { "status": "open", "seconds_left": 1141.0,
      "item": { "id": "i003", "kind": "task", "text": "How many ... ?" } }

POST /item/close  { "id": "i002", "answer": "NO" }
409 { "error": { "code": "not_current", "message": "item i002 is not the open item" },
      "state": { "status": "open", "seconds_left": 1140.6,
                 "item": { "id": "i003", "kind": "task", "text": "How many ... ?" } } }

POST /item/close  { "id": "i003", "skip": true }
200 { "status": "ended", "reason": "queue_finished" }
```

## The sets

You run the practice set yourself, and every submission runs the three scored sets.
`arena sets` prints, for each set, its length, its number of tasks, its model spend, how many
runs you have left, and what you see of a run afterwards. Below the table it prints how many
submissions you have left. The numbers on this page can change: where they differ from
`arena sets`, `arena sets` is right.

The tally of a run has five numbers: the tasks in the set, the tasks closed, and how many of
the closed tasks were correct, wrong, and skipped. It comes with the time left on the shift's
clock. When a run has finished, its tally is that of its result.

Images, runs, and submissions belong to your team, and the limits count per team. A run that
fails on the organizers' side does not count against a limit. A cancelled run does.

## Rules

The rules are in `docs/rules.md`, and on the competition's site under Rules.

## Build, upload, and run

You need Docker and this kit, and nothing else. Once you have registered on the competition's
site, the Register window shows an install command made for you. Run it in a terminal while
Docker is running: it downloads the kit into a directory `speedrun-kit`, loads the image of the
`arena` command line, and signs the command line in. It works once the judge is open. Before
that it prints that the judge is not open yet.

The `arena` command line is the script `arena` in the kit. It runs in a container. Run the
commands below from the kit directory as `./arena`, or put the kit directory on your `PATH`.
Every command but `login` prints the server's answer as JSON with `--json`.

The install command signed the command line in. The sign-in is stored in
`~/.config/arena/credentials.json` (in `$XDG_CONFIG_HOME/arena` when that variable is set), and
every later command reads it there. To sign in again, or on another machine, run the command with
a token in it that the Images tab of the Judge window shows:

```bash
arena login --server <url> --token <token>
```

If the kit's image is not loaded on that machine, `./load-images.sh` in the kit loads it.

### Testing

Nothing you do in this section counts toward the leaderboard.

#### On your own machine

On your own machine you write your agent and build its image. From your agent's directory:

```bash
docker build --platform linux/amd64 -t my-agent .
```

To build the reference agent instead, build its directory. This build downloads Node packages,
OpenCode, and a browser, so it needs internet access:

```bash
docker build --platform linux/amd64 -t my-agent reference-agent
```

You cannot run a clinic or a set on your machine. The practice clinic is hosted by the
organizers, and a set's queue exists only on the judge. What you can run on your machine is
your agent's code against the hosted practice clinic, with your development key.

#### Your development key

The Register window of the competition's site gives you one OpenRouter key with a $20 limit. It
is for running your agent's code on your own machine while you write it. Runs on the judge never
use it: each run there gets a key of its own with the set's model budget. If you need more than $20,
ask an organizer.

Use it the way your agent uses `LLM_API_KEY` on the judge. The judge's model endpoint is an
OpenAI-compatible proxy to OpenRouter with the same routes, so code written against OpenRouter
works on the judge once it reads the address and the key from the environment. To run your code
against the practice clinic from your machine, set:

| Variable | On your machine |
|---|---|
| `SITE_URL` | The practice clinic's address, which `arena sets` prints. It has no sign-in: `SITE_USERNAME` and `SITE_PASSWORD` can be anything, and its sign-in page sends every visitor straight in |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | Your development key |
| `QUEUE_URL` | Nothing. There is no queue on your machine. Give your code a task's text directly: the text of every practice task and its expected answer are in the record of a practice run |

Do not put the key into your image. The image is uploaded to the judge, and the judge gives your
agent a key of its own.

#### The practice set

The practice set has 6 tasks in 20 minutes with $1 of model spend. A practice run is the only
run you start yourself: 30 per 24 hours, and 2 at once. The set is at the clinic whose product
you can look around in, and it checks that your agent uses the queue API, the sign-in, and the
model endpoint correctly, and answers in the right form.

While a practice run goes on, you see each item as it closes, the agent's output, and the tally,
updated after each item. Afterwards you see, for each item, its text, what the agent sent, the
outcome, the expected answer, and how long the agent held it, and the agent's output.

Run it with your local image. `--agent my-agent` uploads the image first. The command prints the
agent's stdout and stderr as the run goes on, and its own lines on stderr with the prefix
`[arena]`, then the record of the run. With `--detach` it prints the run id and returns. The Sets
tab of the Judge window has Start run for the same.

```bash
arena test --set practice --agent my-agent
```

To run an image you have already uploaded, give its id:

```bash
arena test --set practice --image <id>
```

List your runs:

```bash
arena runs
```

Print one run, with its tally while it is in progress:

```bash
arena runs <run id>
```

Print a run's output from the start and follow it:

```bash
arena logs <run id>
```

The Runs tab of the Judge window shows the same, with the items as they close.

The practice clinic's product is hosted for you to look around in. Below its table, `arena sets`
prints its address (`siteUrl` with `--json`), and in the Sets tab of the Judge window the
practice set has a link to open it:

```bash
arena sets
```

### Submitting

A submission runs your image once on each of the three scored sets, and it is what counts toward
the leaderboard. You have 2 submissions per 24 hours, and 1 in progress at a time.

Upload the image. Images can be uploaded only from the command line, which reads the image from
your local Docker engine. This prints the id of the image:

```bash
arena push my-agent
```

Submit it. `--wait` waits for the scores, and while it waits it prints a line for a scored set
when that set's tally has changed, at most once per second, such as
`[arena] Scored set 1 of 3: 120 of 224 tasks closed, 81 correct, 9 wrong, 30 skipped`. The
Submissions tab of the Judge window has Submit for a score, and shows the same tallies while the
submission runs.

```bash
arena submit --image <id> --wait
```

The three scored sets are at clinics nobody has seen. A submission has a tally for each scored
set, updated as tasks close, and one for all three together.

| Set | Tasks | Length | Model spend | While it runs | Afterwards |
|---|---|---|---|---|---|
| Set 1 | 224 | 15 minutes | $8 | The tally, and the agent's output (`arena logs <run id>`). No items | The points, the number of tasks that were correct, wrong, skipped, and not reached, and the agent's output |
| Set 2 | 226 | 15 minutes | $8 | The tally. No items and no agent output | The points, and the number of tasks that were correct, wrong, skipped, and not reached |
| Set 3 | 458 | 30 minutes | $15 | The tally. No items and no agent output | The points, and the number of tasks that were correct, wrong, skipped, and not reached |

Read your scores. `arena scores` lists your submissions, and `arena scores <submission id>`
prints one: per scored set, the points and the tasks by outcome, or the tally while it runs. For
Set 1 it also names the run, which is in `arena runs` with the kind `scored`, and
`arena logs <run id>` prints its output.

```bash
arena scores
```

The leaderboard has one row per team: the sum of the points of the team's latest finished
submission on the three scored sets.

```bash
arena leaderboard
```

After submissions close, the organizers run each team's latest finished submission once on the
final set, 924 tasks in 60 minutes with $25 of model spend at a clinic nobody has seen, and its
points are added to the final ranking. Nothing of that run is shown, while it runs or afterwards,
until the organizers publish the final ranking.

`arena cancel <run id or submission id>` cancels a run or a submission. `arena images` lists
your uploaded images.

## The reference agent

The organizers publish a reference agent. It works but is slow. In a run it does this:

1. It asks for the first item as soon as it starts, without looking at the product first.
2. It acknowledges each message at once and keeps its text for the rest of the run.
3. For each task it starts a new session of OpenCode, a coding agent, with a headless browser
   and a shell. The session gets the product's address and sign-in, the text of every message
   so far, the task, the time available, and the scoring. It is told to answer only from data
   it found in the product.
4. It closes the task with the session's answer, or skips it when the session gave none. A
   session is stopped after 150 seconds, or 4 seconds before the run's time is up.

It keeps nothing from one task to the next except the messages. Every task signs in again and
finds its way through the product again, which costs time and model spend.

Its source is in `reference-agent/` in the kit. `reference-agent/README.md` lists its files,
and the queue loop is in `src/shift.ts` and `src/shiftPrompt.ts`. The types of the queue API
are in `reference-agent/contracts/src/shiftProtocol.ts`, and the names of the environment
variables in `reference-agent/contracts/src/agentProtocol.ts`, as zod schemas you can copy into
an agent of your own. `docker build -t my-agent reference-agent` builds an image from that
directory alone.
