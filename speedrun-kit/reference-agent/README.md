# Reference agent

An agent that works a shift. It wraps [OpenCode](https://opencode.ai), an open-source coding
agent, and gives it a headless browser and a shell. It works, and it is slow. `docs/shift.md`
in the kit says what it does in a shift.

## Build

```bash
docker build -t my-agent reference-agent      # from the kit directory
```

The build needs internet access: it installs the Node packages of `pnpm-lock.yaml`, OpenCode,
and Chromium. The image is about 1.8 GB. Nothing can be downloaded during a shift, so anything
you add has to be installed in the `Dockerfile`.

## Files

| Path | What it is |
|---|---|
| `src/shiftMain.ts` | Entry point. Reads the environment and starts the shift. It stops when `QUEUE_URL` is not set |
| `src/shiftProcess.ts` | Writes the OpenCode configuration, works the shift, and ends the process |
| `src/shift.ts` | The loop of a shift: asks the queue for an item, acknowledges a message, works a task, closes it |
| `src/shiftPrompt.ts` | The prompt of one task |
| `src/config.ts` | The environment variables the agent reads, and its own settings |
| `src/harness.ts`, `src/session.ts`, `src/opencodeConfig.ts` | Starting and stopping OpenCode, and its configuration |
| `src/answer.ts` | Reading an answer out of the model's reply, or out of the file the model keeps it in |
| `contracts/src/shiftProtocol.ts` | The types of the queue API, and of the record of a shift you see afterwards, as zod schemas |
| `contracts/src/agentProtocol.ts` | The names of the environment variables (`agentEnv`), and the type of an answer |
| `Dockerfile` | The image |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | The Node packages, at exact versions |

The source imports the types as `@arena/contracts`, which is the package in `contracts/`.

## Settings

The agent reads these from its environment, on top of what the judge sets. Set them with `ENV`
in the `Dockerfile`.

| Variable | Default | What it sets |
|---|---|---|
| `REFERENCE_MODEL` | see `src/config.ts` | The OpenRouter model id |
| `REFERENCE_TASK_SECONDS` | 150 | The most seconds the session of one task may take |
| `REFERENCE_TASK_MINIMUM_SECONDS` | 20 | A task is skipped when fewer seconds than this are left for its session |
| `REFERENCE_DEADLINE_MARGIN_SECONDS` | 4 | The session of a task is stopped this many seconds before the shift ends |
| `REFERENCE_NOTES` | none | Text added to the prompt of every task |

## Work on the source

```bash
cd reference-agent
pnpm install            # needs Node 24 and pnpm 10
```
