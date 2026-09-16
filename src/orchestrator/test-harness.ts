import type { AgentDefinition } from '../definitions/agent/agent-definition';
import type { WorkflowDefinition } from '../definitions/workflow/workflow-definition';
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineRunSpec,
  EngineSession,
} from '../engines/engine-adapter';
import type { EngineEvent } from '../engines/engine-event';
import { EngineRegistry } from '../engines/engine-registry';
import type { RunEvent } from './run-event';
import type { OrchestratorDeps, StepMeta, TaskRunContext } from './workflow-run';

export class ScriptedSession implements EngineSession {
  readonly id = `scripted-${Math.random().toString(36).slice(2)}`;
  readonly sent: string[] = [];
  cancelled = false;
  private release: (() => void) | null = null;

  constructor(
    private readonly script: readonly EngineEvent[],
    private readonly hangAtEnd: boolean,
  ) {}

  async *events(): AsyncIterable<EngineEvent> {
    for (const event of this.script) {
      if (this.cancelled) {
        return;
      }
      yield event;
    }
    if (this.hangAtEnd && !this.cancelled) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  send(message: string): void {
    this.sent.push(message);
  }

  cancel(): void {
    this.cancelled = true;
    this.release?.();
  }
}

export class ScriptedEngine implements EngineAdapter {
  readonly id: string = 'scripted';
  readonly label: string = 'Scripted';
  readonly specs: EngineRunSpec[] = [];
  readonly sessions: ScriptedSession[] = [];
  private readonly scripts: (readonly EngineEvent[])[];

  constructor(
    scripts: readonly (readonly EngineEvent[])[],
    private readonly hangAtEnd = false,
  ) {
    this.scripts = [...scripts];
  }

  capabilities(): EngineCapabilities {
    return {
      models: [{ id: 'model-x', label: 'Model X' }],
      effort: true,
      mcp: false,
      permissionCallbacks: false,
      resume: false,
    };
  }

  authStatus(): Promise<EngineAuthStatus> {
    return Promise.resolve({ state: 'authenticated' });
  }

  startSession(spec: EngineRunSpec): EngineSession {
    this.specs.push(spec);
    const script = this.scripts.shift() ?? [
      { type: 'error', message: 'scripted engine ran out of scripts' },
    ];
    const session = new ScriptedSession(script, this.hangAtEnd && this.scripts.length === 0);
    this.sessions.push(session);
    return session;
  }
}

export function agentDef(name: string): AgentDefinition {
  return {
    name,
    description: name,
    engine: 'scripted',
    model: 'model-x',
    effort: 'med',
    tools: {
      read: 'always',
      write: 'workspace',
      commands: 'allowlist',
      commandAllowlist: ['npm test'],
      network: 'off',
      mcp: [],
    },
    scope: 'global',
    prompt: `You are ${name}.`,
  };
}

export const AGENTS: Record<string, AgentDefinition> = {
  planner: agentDef('planner'),
  engineer: agentDef('engineer'),
  reviewer: agentDef('reviewer'),
  strict: {
    ...agentDef('strict'),
    reportExample: '{ "summary": "one paragraph", "risks": [] }',
  },
  scout: agentDef('scout'),
  bugs: agentDef('bugs'),
  style: agentDef('style'),
  fixer: agentDef('fixer'),
};

export const context: TaskRunContext = {
  taskId: 'task-1',
  projectId: 'proj-1',
  workspacePath: '/work/task-1',
  inputs: { prompt: 'Fix the license retry loop.' },
};

export const featureDev: WorkflowDefinition = {
  name: 'feature-dev',
  title: 'Feature Dev',
  scope: 'global',
  steps: [
    { kind: 'agent', id: 'plan', agent: 'planner', input: ['inputs.prompt'], output: 'plan' },
    { kind: 'gate', gate: 'approve', id: 'approve-plan', show: ['plan'], editable: true },
    { kind: 'agent', id: 'implement', agent: 'engineer', input: ['plan'] },
    { kind: 'script', id: 'open-pr', command: 'github-create-pr', params: { draft: true } },
  ],
};

export const reviewLoopChild: WorkflowDefinition = {
  name: 'review-loop',
  title: 'Review',
  scope: 'global',
  steps: [{ kind: 'agent', id: 'bug-hunt', agent: 'reviewer', input: [] }],
};

export function reviewWorkflow(maxLoops: number): WorkflowDefinition {
  return {
    name: 'with-review',
    title: 'With Review',
    scope: 'global',
    steps: [
      { kind: 'agent', id: 'implement', agent: 'engineer', input: ['inputs.prompt'] },
      {
        kind: 'workflow',
        id: 'review',
        workflow: 'review-loop',
        onBlocking: { gotoStepId: 'implement', maxLoops, then: 'gate' },
      },
    ],
  };
}

export interface Harness {
  readonly deps: OrchestratorDeps;
  readonly events: RunEvent[];
  readonly metas: StepMeta[];
  readonly scripts: string[];
  /** Every script run with the inputs it received (positional + `with:`). */
  readonly scriptRuns: Array<{ command: string; inputs: Readonly<Record<string, unknown>> }>;
}

export function makeDeps(
  engine: ScriptedEngine,
  workflows: Record<string, WorkflowDefinition> = {},
): Harness {
  const events: RunEvent[] = [];
  const scriptRuns: Array<{ command: string; inputs: Readonly<Record<string, unknown>> }> = [];
  const metas: StepMeta[] = [];
  const registry = new EngineRegistry();
  registry.register(engine);
  const scripts: string[] = [];
  const deps: OrchestratorDeps = {
    engines: registry,
    resolveAgent: (name) => AGENTS[name],
    resolveWorkflow: (name) => workflows[name],
    runScript: (spec) => {
      const command = spec.command ?? spec.definition?.name ?? '';
      scripts.push(command);
      scriptRuns.push({ command, inputs: spec.inputs });
      return Promise.resolve(
        command.includes('fail')
          ? { exitCode: 1, stdout: '', stderr: 'boom' }
          : { exitCode: 0, stdout: '{ "passed": true }', stderr: '' },
      );
    },
    emit: (event) => {
      events.push(event);
    },
    instrument: (stream, meta) => {
      metas.push(meta);
      return stream;
    },
  };
  return { deps, events, metas, scripts, scriptRuns };
}

export const done = (report?: unknown): EngineEvent =>
  report === undefined ? { type: 'done' } : { type: 'done', report };
export const text = (value: string): EngineEvent => ({ type: 'text-delta', text: value });

export function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}
