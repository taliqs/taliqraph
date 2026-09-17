---
name: taliqraph-workflows
description: Write and edit Taliqraph workflow packages - workflow.yaml pipelines, agent files, script manifests, gates and references. Use when authoring, reviewing or debugging a Taliqraph package, or when a user asks for a workflow that runs AI agents with scripts and human approvals.
license: Apache-2.0
---

# Authoring Taliqraph workflows

Taliqraph runs AI agents through a workflow the author defines. A workflow is a
folder of plain files, so authoring one is writing files, and every mistake is
catchable before a run: `taliqraph lint <folder>` makes the same checks a run does.

Install the runner with `npm install -g taliqraph` (Node 22+). The binary is
`taliqraph`, and `tq` is the same thing.

## The folder

Only `workflow.yaml` is required. Everything else is what that workflow uses.

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
    changelog/SKILL.md     reusable instructions an agent pulls in
  workflows/
    sub-flow/              a nested package, run by a `workflow:` step
      workflow.yaml
```

Copying the folder copies everything. `taliqraph pack <folder>` turns it into one
`.tqh` file, and `taliqraph unpack` reverses that.

### Where the folder lives

The CLI runs a package folder wherever it is: `taliqraph ./anywhere/my-workflow`
works, and nothing has to be installed anywhere.

The desktop app and the shared Library are different. They read a **definitions
root** and expect this layout inside it:

```
.taliqraph/
  workflows/<name>/workflow.yaml   the packages
  agents/  scripts/  standards/  skills/   shared by all of them
```

There are two such roots: `~/.taliqraph` is the Library, shared by every folder,
and `<project>/.taliqraph` is one project's own, which shadows it. So a workflow
meant for the desktop belongs at `<project>/.taliqraph/workflows/<name>/`.

Open the **project** in the desktop app, not the `.taliqraph` folder and not
`workflows/`: it appends `.taliqraph` to whatever you opened, so opening the
definitions folder itself makes it look for `.taliqraph/.taliqraph` and find
nothing.

## References are the whole idea

Every step writes its result under its own id, and under `output:` when it names
one. Later steps read those results by name:

- `inputs.question` - a declared input
- `reviewer` - everything the `reviewer` step reported
- `reviewer.findings` - one field of it
- `$listing.summary` - the same, inside a `with:` block

A reference to a field that no step produces is a lint error. This is why an
agent's report block and a script's `report:` skeleton matter: they are what
makes `<step>.<field>` real.

## workflow.yaml

```yaml
name: pr-review
title: Review a pull request
description: What it does, and when someone should run it.

inputs:
  question: { type: prompt, description: What do you want to know? }
  depth: { type: choice, options: [quick, deep], default: quick }
  retries: { type: number, required: false, default: 2 }
secrets: [GH_TOKEN, JIRA_TOKEN?]
env: [HTTP_PROXY]

steps:
  - id: review
    agent: reviewer
    input: [inputs.question]
    output: review

  - id: sign-off
    gate: approve
    show: [review.summary, review.findings]

  - id: post
    script: post-review
    input: [inputs.pr, review.findings] # fills the script's parameters, in order
    output: post

  - id: done
    finish: run
    with: { posted: $post.posted, _summary: $review.summary }
```

Input types are `text`, `prompt`, `number`, `boolean` and `choice`. A plain value
is shorthand: `question: ''` is required text.

**An input's name is lowercase letters, digits and underscores, starting with a
letter**: `test_hash`, not `testHash`. The rule is enforced at parse time. Report
fields are not held to it, so `matrix.topReason` is fine while `inputs.topReason`
is not.

Secrets are **names, never values**. A `?` marks one optional. They arrive from
`--secret NAME=value` or the environment, and are redacted from the event log. A
run refuses to start when a required one is missing. The workflow's `secrets:`
list says which ones the run may use; a step's own `secrets:` list says which of
those that step actually gets. A secret no step lists is a lint warning, and a
step naming one the workflow does not declare is a lint error.

`env:` is a pass-through of host variables, for proxies and the like.

`extends: <other workflow>` inherits another workflow's steps. Steps merge by id:
the same id replaces the inherited step, a new id is appended. Cycles are
rejected, and extending a workflow that does not exist is an error.

## Steps

One key per step decides what it is.

| Step         | Key                             | What it does                                                            |
| ------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Agent        | `agent: <name>`                 | Runs an agent from `agents/`; `input:` lists what it is given           |
| Script       | `script: <name>`                | Runs a script from `scripts/`, or an inline shell command               |
| Gate         | `gate: approve\|choice\|select` | Pauses for a person                                                     |
| Sub-workflow | `workflow: <name>`              | Runs a nested package under `workflows/`                                |
| Condition    | `if: <ref>`                     | Compares a reference, takes `then:` or `else:`                          |
| Loop         | `while: <ref>`                  | Jumps back to `goto:` while it holds, up to `max_loops`                 |
| Fan-out      | `for_each: <ref>`               | Runs `do:` once per list entry, at the same time, capped by `max_items` |
| Parallel     | `parallel:`                     | Runs several branches at the same time                                  |
| Jump         | `goto: <step id>`               | Jumps to another step, capped by `max_loops`                            |
| Finish       | `finish: run`                   | Ends successfully; `input:` and `with:` become the run's output         |
| Fail         | `fail: <message>`               | Ends as failed; the value is the message                                |

Keys that ride along on a step, whatever it is:

| Key                                      | On which step                       | What it does                                                         |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `output: <name>`                         | agent, script                       | Names the result, so later steps can read `<name>.<field>`           |
| `secrets: [NAME]`                        | agent, script                       | The secrets this step gets, from the workflow's own list             |
| `when: { max_runs: 2 }`                  | agent, script, workflow             | Runs at most that many times, however often the flow reaches it      |
| `model:`, `effort:`                      | agent                               | Overrides the agent file, for this step only                         |
| `on_blocking: { goto, max_loops, then }` | agent, workflow, for_each, parallel | When the report says `blocking: true`, jump back; `then: gate\|fail` |
| `on_fail: fail \| continue \| ask`       | for_each, parallel                  | What a failing branch does to the rest; `fail` is the default        |

Comparisons are `equals`, `not_equals`, `gte`, `lte` and `in`.

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
  as: finding # what each entry is called inside `do:`
  max_items: 20 # at most 50
  on_fail: continue
  do:
    agent: scorer
    input: [finding]

- id: both
  parallel: # two or more branches, each a step or a list of steps
    - { id: lint, script: npm run lint }
    - - id: test
        script: npm test
      - id: report
        agent: summarizer
        input: [test]
```

`then:` and `else:` take a step id or a list of steps, and either may be left out:
an else-only condition does extra work on false and otherwise carries on.

Ending the run:

```yaml
- id: done
  finish: run
  with: { answer: $write.answer, _summary: $write.summary }

- id: give-up
  fail: The tests are still red after three attempts # the value IS the message
  with: { failures: $tests.failed }
```

`finish:` and `fail:` take `input:` (positional references) and `with:` (named
fields; `$ref` resolves, anything else is a literal). Together they are the run's
output. `_summary` is the one reserved key: it becomes the run's summary line.

## Gates

A gate says on its first line what it asks for. Pick the kind by what the person
has to do, not by what is convenient.

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
  list: review.findings # MUST resolve to an array
  choices:
    - { id: post, label: Post the ticked ones, needs: selection }
    - { id: nothing, label: Do nothing, needs: none }
```

`needs: selection` keeps an exit unavailable until something is ticked.
`default: true` marks the exit a headless run takes.

What a gate hands on:

| Reference                             | On which gate        | Value                                               |
| ------------------------------------- | -------------------- | --------------------------------------------------- |
| `<gate>.approved`                     | all                  | true or false                                       |
| `<gate>.note`                         | all                  | the note typed, empty when none                     |
| `<gate>.rejections`                   | all                  | how many times it was sent back                     |
| `<gate>.choice`                       | choice, select       | the exit that was picked                            |
| `<gate>.selected`, `<gate>.dismissed` | select               | the entries ticked, and those dropped, with reasons |
| `<gate>.edited`                       | any `editable:` gate | the edited text                                     |

## Agents

An agent is a markdown file: frontmatter for the model and its permissions, body
for the prompt. The file is `agents/<name>.agent.md` and the name is what a step
references.

````markdown
---
name: reviewer
description: Reviews a diff for real bugs.
engine: anthropic
model: sonnet-5 # sonnet-5 | opus-5 | haiku-4-5
effort: high # low | med | high | max
tools:
  read: always # always | off
  write: workspace # workspace | anywhere | off
  commands: allowlist # allowlist | sandbox | off
  allowlist: [git diff, npm test] # prefix match, one per entry
  network: off # off | allowlist
  mcp: [github] # MCP servers this agent may use; `github?` makes it optional
skills: [changelog]
---

You review a diff and report real bugs only.

## Report

```json
{ "findings": [{ "id": "f1", "short": "null deref", "severity": "high" }] }
```
````

The report block is the shape the agent must end with. The runner reads it, warns
when a declared field is missing, and later steps read it as `reviewer.findings`.
Invent whatever fields the workflow needs; they render and are referenceable.

Permissions are a contract, not a suggestion. Give an agent the least it needs:
`write: off` for anything that only reads, `commands: off` unless it genuinely
runs something, `network: off` by default. An agent that names an MCP server makes
that server a requirement of every workflow that runs it.

## Scripts

**A script's declared parameters are filled by the step's `input:` list, in order.**
`with:` adds named values on top; it does not fill a declared parameter, and lint
says `script/missing-input` when a step relies on it to. A script that declares no
parameters takes whatever it is given, as `args`.

A script is a folder with a manifest and the code beside it. Use one wherever the
work is deterministic: an agent that formats JSON or calls an API is a script
waiting to happen.

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

What the script is given:

| Given                           | What it holds                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `$TQ_INPUTS`                    | a JSON file `{ inputs, args, <parameter>: value }`, the same JSON also on stdin |
| `TQ_ARG_<n>`, `TQ_INPUT_<NAME>` | the same values as environment variables                                        |
| `$TQ_WORKSPACE`                 | the folder the run works in, which is also the working directory                |
| `$TQ_SCRIPT_DIR`                | the script's own folder, for files that ship with it                            |
| `$TQ_REPORT_FILE`               | write the report here instead of printing it                                    |

**The output is the last JSON line the script prints**, or the file at
`$TQ_REPORT_FILE` when it writes one. Anything else it prints is kept as
`{ output: "<text>" }` and the step says so. This is the single most common
mistake: `console.log({ passed: 3 })` prints `[object Object]` and reports
nothing. Write `console.log(JSON.stringify({ passed: 3 }))`.

A definition's `run` is spawned without a shell, so quoting behaves the same
everywhere. An inline `script: npm test` goes through the shell instead.

## Standards and skills

A standard is house rules an agent is told to follow: a markdown file under
`standards/` with `name` and optional `applies_to`. A skill is a reusable
procedure under `skills/<name>/SKILL.md`, pulled in by an agent's `skills:` list.
Both are injected into the agent's prompt word for word.

## MCP servers

An agent's `tools.mcp` names the servers it may use; `name?` makes one optional.
Naming a server makes it a requirement of every workflow that runs that agent, and
the run refuses to start where it is missing. The host supplies them; the CLI takes
a JSON file:

```bash
taliqraph ./my-workflow --mcp-servers ./servers.json
```

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

## What the checker will stop you doing

These are not style rules; the parser or lint rejects them, and each one is easy
to write by accident.

- **A step inside a branch is not visible after it.** An `output:` produced in a
  condition's `then:` or `else:`, or inside a `for_each` or a `parallel` branch,
  cannot be referenced by a step after the fork: that branch might not have run.
  Lint says `ref/unknown-producer`. Reference something the pipeline itself
  produced instead.
- **`on_blocking: { goto: … }` stays in its own lane.** From inside a branch it
  can only target a step in that branch. Naming a step in the enclosing pipeline
  is rejected outright, not warned about.
- **A jump goes backwards.** `goto:` and `while:` target an earlier step; jumping
  forward gets `jump/not-backwards`.
- **A gate's `list:` must resolve to an array**, and a `select` gate without one
  will not parse. `gate: choice` needs `choices:`; `gate: approve` may have
  neither.
- **A script's parameters come from `input:`, in order.** See above; this is the
  one that silently produces a step with no data.
- **Every reference is checked**, including inside `with:`. A field no step
  declares is an error, which is why report skeletons are not optional in
  practice.

## Running it

```bash
taliqraph ./my-workflow --input question="what changed?"   # gates in the terminal
taliqraph -p ./my-workflow --input question="what changed?" # headless, for CI
taliqraph lint ./my-workflow                                # check without running
```

Exit codes: 0 finished, 1 failed, 2 the workflow is wrong (usage, a lint problem,
or a package that will not load), 3 stopped at a gate, 4 over budget, 130
interrupted. 1 and 2 are the distinction worth wiring into CI: 2 means fix the
workflow, 1 means it ran and did not succeed.

From Node, the same package is a library:

```ts
import { runWorkflow } from 'taliqraph';

const result = await runWorkflow({
  workflow: './my-workflow',
  inputs: { question: 'what changed?' },
  secrets: { GH_TOKEN: process.env.GH_TOKEN },
  cwd: '/tmp/work',
  onEvent: (event) => console.log(event.kind),
  onGate: async (gate) => ({ approved: true }),
});
```

`taliqraph/definitions` is the browser-safe half: the model and the linter, with
no Node behind it.

## Writing a good workflow

- **Name every step's output** you intend to read later, and reference it by
  field. A step whose result nothing reads is usually a step that should not exist.
- **Put the deterministic parts in scripts.** Agents are for judgement.
- **Gate where a person would actually want to stop it**, not everywhere. Each
  gate is a pause someone has to come back to.
- **Declare the report shape** on every agent and script. Without it the next step
  has nothing to reference and lint cannot help.
- **Run `taliqraph lint` before handing the workflow over.** Its rules are named,
  so the output says exactly what is wrong: `agent/unknown`, `script/unknown`,
  `script/missing-input`, `script/extra-input`, `workflow/unknown`,
  `workflow/self-nesting`, `gate/list-not-a-list`, `gate/unknown-choice`,
  `gate/duplicate-choice`, `secret/undeclared`, `secret/unused`, `input/unused`,
  `output/alias-collision`, `jump/unknown-target`, `jump/not-backwards`,
  `jump/into-run-once`, `flow/dead-steps`, `fork/on-blocking-ignored`,
  `mcp/unconfigured`, `package/outside`.
- **Keep permissions tight**, and remember secrets are names in the file and
  values only at run time. Never write a secret value into `workflow.yaml`.

## A workflow that uses all of it

This one lints clean (`taliqraph lint`), and exercises every key above.

```yaml
name: pack
title: Everything the skill documents
description: A workflow that uses each documented feature, to check the skill is true.
inputs:
  question: { type: prompt, description: What do you want to know? }
  depth: { type: choice, options: [quick, deep], default: quick }
  retries: { type: number, required: false, default: 2 }
secrets: [GH_TOKEN, JIRA_TOKEN?]
env: [HTTP_PROXY]
steps:
  - id: review
    agent: reviewer
    model: opus-5
    effort: high
    when: { max_runs: 2 }
    input: [inputs.question, inputs.depth, inputs.retries]
    secrets: [GH_TOKEN, JIRA_TOKEN]
    output: review

  - id: sign-off
    gate: approve
    show: [review.summary, review.findings]
    editable: true

  - id: what-next
    gate: choice
    show: [review]
    choices:
      - { id: post, label: Post it, default: true }
      - { id: stop, label: Do nothing }

  - id: triage
    gate: select
    show: [review]
    list: review.findings
    choices:
      - { id: send, label: Send the ticked ones, needs: selection }
      - { id: none, label: Do nothing, needs: none }

  - id: route
    if: review.blocking
    equals: true
    then:
      - id: collect-facts
        script: collect
        input: [inputs.question]
        output: facts
    else: wrap

  - id: score
    for_each: review.findings
    on_blocking: { goto: review, max_loops: 2, then: gate }
    as: finding
    max_items: 20
    on_fail: continue
    do:
      agent: reviewer
      input: [finding]

  - id: both
    parallel:
      - id: lint-it
        script: collect
        input: [inputs.question]
      - - id: nested
          workflow: sub
          when: { max_runs: 1 }

  - id: retry
    while: review.blocking
    equals: true
    goto: review
    max_loops: 3

  - id: last-call
    if: review.blocking
    equals: true
    then: give-up

  - id: wrap
    finish: run
    with: { answer: $review.summary, _summary: $review.summary }

  - id: give-up
    fail: Still blocking after the retries
    with: { findings: $review.findings }
```
