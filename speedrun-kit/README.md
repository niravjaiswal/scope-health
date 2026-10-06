# Competition kit 0.1.0

Build an agent that answers a clinic's back-office requests using Wrenfield, its web records system.
Your goal is more correct answers within each set's length and model budget.
All clinic records are synthetic.

## Explore the clinic first

[Open the practice clinic](https://practice.speedrun.scopehealth.com/).
Browse patients, appointments, billing, documents, and reports before writing code.
The [getting-started guide](https://speedrun.scopehealth.com/getting-started.md) includes an example of a task and its answer.

## Your first practice run

The website's install command loads the CLI and signs it into your account.
If you used that command, your kit is ready. Otherwise, run `./load-images.sh` and use the login command from the website.
Docker must be running.

```bash
./arena sets
docker build --platform linux/amd64 -t my-agent reference-agent
./arena test --set practice --agent my-agent
```

Read the completed run under **Test** in [Judge](https://speedrun.scopehealth.com/#judge), or with `./arena runs <run-id>`.
Practice shows your answers, outcomes, and expected answers. Keep this first result as your baseline.
Then improve the agent, measure the change on practice, and submit when ready.
The reference agent works but can be slow. You can change it or build your own agent.

## Track your work in Judge

[Open the Judge screen](https://speedrun.scopehealth.com/#judge), or select Judge from the website's dock.
**Test** starts practice runs and shows their live output, answers, and expected answers.
**Submit** starts scored submissions and shows progress and results for each scored set.
Upload images with `./arena push`. The website and CLI use the same account and show the same work.
The Judge controls are on the desktop site.

## What you build

Your Docker image runs one agent process. It reads tasks and messages from the queue, uses the clinic, and submits answers.
Correct answers score +1, wrong answers -1, and skipped tasks 0. Messages give instructions and score nothing.
The organizers host the clinic and run your image. You do not need the clinic or judge server source.
During a run on the judge, use SITE_URL and the provided credentials. Each set is at a different clinic.
Use `./arena sets` for current lengths, budgets, and daily limits.

## Protocol and rules

Start with `docs/shift.md`: the shift your agent works, the sets, what your agent's container gets, the queue API, and how to build, upload, and run.

## Contents

| Path | What it is |
|---|---|
| `arena` | The command line of the judge server. It runs in the image `arena-public/cli:0.1.0`. |
| `load-images.sh` | Loads that image into the local Docker engine. Run it once. |
| `docs/` | The documents for competitors. |
| `reference-agent/` | Source of the reference agent, with a Dockerfile that builds it from this directory alone. |
| `reference-agent/contracts/` | The types of the queue API (`src/shiftProtocol.ts`) and the names of the environment variables (`src/agentProtocol.ts`), as zod schemas. |
| `kit.json` | The version of the kit and the name of the image. |

## Set up

```bash
./load-images.sh
./arena --help
```

Where `docs/shift.md` writes `arena`, run `./arena` from this directory, or put this
directory on your `PATH`.

The command line runs in a container. `./arena login` stores your sign-in in
`~/.config/arena/credentials.json` (in `$XDG_CONFIG_HOME/arena` when that is set), and
every later command reads it from there. `./arena push`, and `--agent` of `./arena test`
and `./arena submit`, read the image from your local Docker engine.
