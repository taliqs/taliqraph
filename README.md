# taliqraph

Run workflows made of AI agents, scripts and approval gates, defined as plain files. From a terminal, or from your own code.

A workflow is a folder you can read, diff and commit: a `workflow.yaml` with the agents and scripts it uses beside it. The runner loads it, checks it, runs it in the folder you point it at, and hands back the result with every event it produced. It keeps no database, no home folder and no background state.

```bash
npm i -g taliqraph
taliqraph ./my-workflow --input question="what does this folder do"
```

Node 22 or newer. The engines are your own installs and sign-ins: [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex/cli).

## Contents

- [Try it](#try-it)
- [What a workflow looks like](#what-a-workflow-looks-like)
- [Steps](#steps)
- [Inputs, secrets and environment](#inputs-secrets-and-environment)
- [Gates](#gates)
- [Agents](#agents)
- [Scripts](#scripts)
- [Standards and skills](#standards-and-skills)
- [The CLI](#the-cli)
- [From code](#from-code)
- [Single-file packages](#single-file-packages)
- [License](#license)

## Try it

Three files, no model call, so it costs nothing:

```bash
mkdir -p probe/scripts/inspect && cd probe
```

`workflow.yaml`

```yaml
name: probe
title: Probe
description: Lists the folder, then asks what to do with the files it found.
steps:
  - id: look
    script: inspect
    output: listing

  - id: decide
    gate: select
    show: [listing]
    list: listing.files
    choices:
      - { id: keep, label: Looks right, needs: selection }
      - { id: stop, label: Stop here, needs: none }

  - id: done
    finish: run
    with:
      picked: $decide.selected
      exit: $decide.choice
      _summary: $listing.summary
```

`scripts/inspect/script.yaml`

```yaml
name: inspect
title: Inspect the folder
description: Lists what is in the workspace and reports it.
run: node run.mjs
timeout_minutes: 1
report:
  summary: 3 files in /path
  files: [a.txt]
```

`scripts/inspect/run.mjs`

```js
import { readdirSync, writeFileSync } from 'node:fs';

const files = readdirSync(process.cwd());
writeFileSync(
  process.env.TQ_REPORT_FILE,
  JSON.stringify({ summary: `${files.length} files in ${process.cwd()}`, files }),
);
```

Then:

```bash
taliqraph lint .          # the same checks a run makes before it starts
taliqraph . --cwd ~/some-folder
```

The gate opens in the terminal with one checkbox per file. Arrows move, Space ticks, Enter picks, `d` dismisses an entry, Ctrl+C stops the run. Add `-p` to answer everything automatically.

## What a workflow looks like

A package is a folder. Only `workflow.yaml` is required; everything else is what that workflow uses.

```
my-workflow/
  workflow.yaml            the pipeline
  agents/
    reviewer.agent.md      a model with a prompt, a toolset and a report shape
  scripts/
    post-review/
      script.yaml          name, inputs, report shape, timeout
      run.mjs              the code
  standards/
    typescript.md          house rules an agent is told to follow
  skills/
    changelog.md           reusable instructions an agent can pull in
  workflows/
    sub-flow/              a nested package, run by a `workflow:` step
      workflow.yaml
```

Every step writes its result under its own id, and under `output:` when it names one. Later steps read them as references: `reviewer`, `reviewer.findings`, `inputs.question`, `$listing.summary` inside a `with:` block.

## Steps

One key per step decides what it is.

| Step         | Key                                 | What it does                                                                               |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Agent        | `agent: <name>`                     | Runs an agent from `agents/`. `input:` lists what it is given, `output:` names its report  |
| Script       | `script: <name>`                    | Runs a script from `scripts/`, or an inline shell command. `with:` passes named parameters |
| Gate         | `gate: approve \| choice \| select` | Pauses for a person. See [Gates](#gates)                                                   |
| Sub-workflow | `workflow: <name>`                  | Runs a nested package under `workflows/`                                                   |
| Condition    | `if: <ref>`                         | Compares a reference and takes `then:` or `else:`                                          |
| Loop         | `while: <ref>`                      | Jumps back to `goto:` while the comparison holds, up to `max_loops`                        |
| Fan-out      | `for_each: <ref>`                   | Runs `do:` once per entry of a list, all at the same time, capped by `max_items`           |
| Parallel     | `parallel:`                         | Runs several branches at the same time                                                     |
| Jump         | `goto: <step id>`                   | Jumps to another step, up to `max_loops` times                                             |
| Finish       | `finish: run`                       | Ends the run successfully. `input:` and `with:` become the run's output                    |
| Fail         | `fail: run`                         | Ends the run as failed, with a `message:`                                                  |

Conditions and loops compare with `equals`, `not_equals`, `gte`, `lte` or `in`:

```yaml
- id: route
  if: review.blocking
  equals: true
  then:
    - id: fix
      agent: engineer
      input: [review]
  else: post # a step id, or a list of steps

- id: retry
  while: tests.failed
  equals: true
  goto: fix
  max_loops: 3

- id: score
  for_each: review.findings
  as: finding
  max_items: 20
  do:
    agent: scorer
    input: [finding]
```

## Inputs, secrets and environment

```yaml
inputs:
  question: { type: prompt, description: What do you want to know? }
  depth: { type: choice, options: [quick, deep], default: quick }
  retries: { type: number, required: false, default: 2 }
secrets: [GH_TOKEN, JIRA_TOKEN?]
env: [HTTP_PROXY]
```

Input types are `text`, `prompt`, `number`, `boolean` and `choice`. Steps read them as `inputs.<name>`. A plain value instead of a spec is shorthand: `question: ''` is required text.

Secrets are names, never values. A `?` marks one as optional. They come from `--secret NAME=value` or the process environment, and reach only the steps that list them under `secrets:`. A run refuses to start when a required one is missing. Values are redacted from the event log.

`env:` is a pass-through: host variables a step may see, for proxies and the like.

## Gates

A gate says on its first line what it asks for.

```yaml
- id: sign-off
  gate: approve # show these, answer yes or no, with an optional note
  show: [plan, diff]
  editable: true # the shown text can be edited before deciding

- id: what-next
  gate: choice # pick one of the exits
  show: [review]
  choices:
    - { id: post, label: Post the review, default: true }
    - { id: nothing, label: Do nothing }

- id: triage
  gate: select # tick entries from a list a step produced
  show: [review]
  list: review.findings # must resolve to an array
  choices:
    - { id: post, label: Post the ticked ones, needs: selection }
    - { id: nothing, label: Do nothing, needs: none }
```

`needs: selection` keeps an exit unavailable until something is ticked. `default: true` marks the exit a headless run takes.

What a gate hands to later steps:

| Reference                             | On which gate        | Value                                                    |
| ------------------------------------- | -------------------- | -------------------------------------------------------- |
| `<gate>.approved`                     | all                  | true or false                                            |
| `<gate>.note`                         | all                  | the note typed, empty when none                          |
| `<gate>.rejections`                   | all                  | how many times it was sent back                          |
| `<gate>.choice`                       | choice, select       | the exit that was picked                                 |
| `<gate>.selected`, `<gate>.dismissed` | select               | the entries ticked, and those dropped with their reasons |
| `<gate>.edited`                       | any `editable:` gate | the edited text                                          |

## Agents

An agent is a markdown file: frontmatter for the model and its permissions, body for the prompt.

````markdown
---
name: reviewer
description: Reviews a diff for real bugs.
engine: claude-code
model: sonnet-5
effort: high
tools:
  read: always # always | off
  write: workspace # workspace | anywhere | off
  commands: allowlist # allowlist | sandbox | off
  allowlist: [git diff, npm test]
  network: off # off | allowlist
  mcp: [github] # MCP servers this agent may use
skills: [changelog]
---

You review a diff and report real bugs only.

## Report

```json
{ "findings": [{ "id": "f1", "short": "null deref", "severity": "high" }] }
```
````

The report block is the shape the agent must end with. The runner reads it, warns when declared fields are missing, and later steps read its fields as `reviewer.findings`.

## Scripts

A script is a folder with a manifest and code. The manifest declares its name, how to run it, what it takes and the shape it reports.

```yaml
name: post-review
title: Post a review
description: Posts the ticked findings to the pull request.
run: node run.mjs
inputs: [pr, findings]
timeout_minutes: 5
report:
  posted: 3
  url: https://example.com/pull/1
```

The contract, for both script definitions and inline commands:

| Given to the script             | What it holds                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `$TQ_INPUTS`                    | a JSON file: `{ inputs: {...}, args: [...in the step's order], <parameter>: value }`, also on stdin |
| `TQ_ARG_<n>`, `TQ_INPUT_<NAME>` | the same values as environment variables, strings raw, everything else JSON                         |
| `$TQ_WORKSPACE`                 | the folder the run works in, which is also the working directory                                    |
| `$TQ_SCRIPT_DIR`                | the script's own folder, for files that ship with it                                                |
| `$TQ_REPORT_FILE`               | write the report here instead of printing it                                                        |

The report is the file at `$TQ_REPORT_FILE`, else the last JSON line on stdout. Anything else is kept as `{ output: "<text>" }` and the step says so, so print `JSON.stringify(...)` when later steps read fields. A definition's `run` is spawned without a shell, so quoting behaves the same everywhere; inline commands go through the shell.

## Standards and skills

A standard is house rules an agent is told to follow, a markdown file with `name` and optional `applies_to` globs. A skill is a reusable instruction file in the `SKILL.md` shape, `name` and `description` in frontmatter, pulled in by an agent's `skills:` list. Both are plain files under `standards/` and `skills/`.

## The CLI

```bash
taliqraph <workflow> [options]     # run it; the workflow is a folder or a .tqh file
taliqraph lint [target]            # the checks a run makes, without running
taliqraph pack <folder>            # a package as one .tqh file
taliqraph unpack <file>            # a .tqh file back into a folder
taliqraph login [engine]           # the engine's own sign-in, in this terminal
taliqraph doctor                   # engines, sign-ins, node
```

The binary is `taliqraph`, and `tq` is the same thing.

| Run option                   | What it does                                                          |
| ---------------------------- | --------------------------------------------------------------------- |
| `-i, --input <name=value>`   | one declared input, repeat per input                                  |
| `--inputs <json\|file>`      | every input at once, as a JSON object or a path to one                |
| `-p, --print`                | headless: gates answer themselves, over budget exits 4                |
| `--secret <NAME=value>`      | a secret for this run only, never stored                              |
| `--env <NAME=value>`         | a host variable for the workflow's `env:` pass-through                |
| `--mcp-servers <file>`       | MCP servers the agents may use, a JSON array of `{ name, kind, ... }` |
| `--cwd <folder>`             | the folder to work in, default the current one                        |
| `--output-format <fmt>`      | `text`, `json`, or `stream-json` for one event per line               |
| `--verbose`                  | agent prose and tool calls in the feed                                |
| `--json`, `--no-color`, `-q` | machine-readable output, plain output, results only                   |

Interactive by default: a gate, a question or a permission ask opens a menu in the terminal. Without a terminal, the first pause fails the run and points at `-p`.

| Exit code | Meaning                |
| --------- | ---------------------- |
| 0         | the run finished       |
| 1         | the run failed         |
| 2         | usage or lint problems |
| 3         | stopped at a gate      |
| 4         | over budget            |
| 130       | interrupted            |

An MCP servers file looks like this:

```json
[
  { "name": "docs", "kind": "stdio", "command": "mcp-docs", "args": ["--root", "."] },
  {
    "name": "api",
    "kind": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer …" }
  }
]
```

## From code

```ts
import { runWorkflow } from 'taliqraph';

const result = await runWorkflow({
  workflow: './my-workflow',
  inputs: { question: 'what does this folder do' },
  cwd: '/path/to/folder',
  secrets: { GH_TOKEN: process.env.GH_TOKEN },
  onEvent: (event) => console.log(event.type, event.at),
  onGate: async (gate) => {
    if (gate.kind === 'select') {
      return { approved: true, choice: 'post', selected: gate.items?.map((item) => item.key) };
    }
    return { approved: true, note: 'looks fine' };
  },
});

console.log(result.status, result.summary);
console.log(result.metrics.costUsd, result.metrics.tokens.total);
```

| Option       | Default               | What it is                                                               |
| ------------ | --------------------- | ------------------------------------------------------------------------ |
| `workflow`   | required              | a package folder or a `.tqh` file                                        |
| `inputs`     | `{}`                  | values for the inputs the workflow declares                              |
| `secrets`    | the environment       | values for the secrets it declares                                       |
| `env`        | the environment       | host variables for its `env:` pass-through                               |
| `cwd`        | the process cwd       | the folder the run works in                                              |
| `isolated`   | false                 | true when `cwd` is a copy you made, so agents are told to stay inside it |
| `hooks`      | none                  | `{ afterStep, afterTask }` shell commands run in the workspace           |
| `engines`    | Claude Code and Codex | the engine registry to use                                               |
| `mcpServers` | none                  | resolved MCP servers the agents may name                                 |
| `onEvent`    | none                  | every event as it happens, timestamped                                   |
| `onGate`     | none                  | answers every pause                                                      |
| `headless`   | false                 | answer every pause automatically, the way `-p` does                      |
| `signal`     | none                  | aborting cancels the run                                                 |
| `resumeFrom` | none                  | the events of an earlier run, to continue it                             |

The result:

```ts
{
  status: 'done' | 'failed' | 'cancelled',
  output?: Record<string, unknown>,   // what the finish step handed out, `_summary` included
  summary?: string,
  message?: string,                   // why it failed or stopped
  workspace: string,                  // the folder it worked in
  metrics: { costUsd, tokens, durationMs, steps: [...] },
  events: TimedRunEvent[],            // the whole log; feed it back as `resumeFrom`
  exitCode: number,
}
```

Events are the whole record of the run, each stamped with `at`:

| Event                                                           | What it carries                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `run-started`                                                   | the workflow's name and the inputs the run was given                                            |
| `step-started`                                                  | the step id and kind, the references it was handed, and for an agent its name, model and effort |
| `agent-text`, `agent-tool-call`, `agent-tool-result`            | what the agent said, every tool call with its input, and whether it failed                      |
| `step-usage`                                                    | tokens in and out, and the cost, per step                                                       |
| `step-completed`                                                | the step's report, plus any declared fields it left out                                         |
| `step-failed`, `step-skipped`                                   | why a step failed or did not run                                                                |
| `gate-opened`                                                   | what the gate showed, the entries to tick, the exits offered                                    |
| `gate-selection-changed`, `gate-resolved`                       | every tick and dismissal, then the answer with its note and choice                              |
| `condition-evaluated`, `loop-back`                              | which way a condition went and why the run jumped back                                          |
| `hook-ran`                                                      | a hook command and its exit code                                                                |
| `run-completed`                                                 | the run's output, and every step's report under `outputs`                                       |
| `run-failed`, `run-cancelled`, `run-interrupted`, `run-resumed` | how the run ended, or why it stopped                                                            |

Secret values never appear in the log; they are redacted from every event. Feed `result.events` back as `resumeFrom` to continue a run where it stopped.

A workflow that can pause needs `onGate` or `headless`. Without either, `runWorkflow` throws before anything runs, so a server never hangs on a gate nobody can answer:

```ts
import { GateHandlerRequired, SecretsMissing, WorkflowInvalid, lintPackage } from 'taliqraph';

try {
  await runWorkflow({ workflow: './my-workflow' });
} catch (error) {
  if (error instanceof GateHandlerRequired) {
    // error.stepIds: the steps that would pause
  }
  if (error instanceof WorkflowInvalid) {
    // error.problems: what the linter refused
  }
  if (error instanceof SecretsMissing) {
    // error.names: what it needs
  }
}

const { lint, missingMcp, problems } = await lintPackage('./my-workflow');
```

`taliqraph/definitions` is the definition model on its own, with no Node in it: parse, serialize and lint workflows, agents, scripts, standards and skills, and read or write `.tqh` files. It runs in a browser.

```ts
import { parseWorkflowDefinition, lintWorkflow, buildPackageTqh } from 'taliqraph/definitions';
```

## Single-file packages

`pack` writes a whole package as one YAML file, `.tqh`, with every file inline. `unpack` writes it back out. A `.tqh` file runs and lints like a folder, so a workflow travels as one attachment. Packing refuses content that looks like a token.

```bash
taliqraph pack ./my-workflow --file my-workflow.tqh
taliqraph my-workflow.tqh -p --input question="what changed"
```

## Development

```bash
corepack enable
pnpm install
pnpm cli --help
pnpm verify        # typecheck, lint, tests, build
```

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

Taliqraph runs workflows with engines you install and sign in to yourself. The Claude engine uses Anthropic's Claude Agent SDK, which carries Anthropic's own terms; the Codex engine drives the `codex` CLI.
