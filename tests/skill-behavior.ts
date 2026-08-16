import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const scenarioTimeoutMs = 120_000;
const skillNames = ["grill-me", "thinking-partner", "handoff"] as const;
type SkillName = (typeof skillNames)[number];
type Mode = "baseline" | "package";

interface Options {
  mode: Mode;
  packageArgument?: string;
  output: string;
}

export interface Scenario {
  name: SkillName;
  prompt: string;
  required: string[];
  forbidden: string[];
}

export interface CriterionResult {
  criterion: string;
  passed: boolean;
}

export interface ScenarioSummary {
  skill: SkillName;
  discovered: boolean;
  passed: boolean;
  required: CriterionResult[];
  forbidden: CriterionResult[];
}

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface RpcCommandEntry {
  name: string;
  source: string;
}

function parseArguments(argv: string[]): Options {
  let mode: Mode | undefined;
  let packageArgument: string | undefined;
  let output: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--mode") {
      if (mode || (value !== "baseline" && value !== "package"))
        throw new Error("--mode must be baseline or package");
      mode = value;
      index++;
    } else if (flag === "--package") {
      if (packageArgument || !value)
        throw new Error("--package requires exactly one value");
      packageArgument = value;
      index++;
    } else if (flag === "--output") {
      if (output || !value)
        throw new Error("--output requires exactly one value");
      output = value;
      index++;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (!mode) throw new Error("--mode is required");
  if (!output) throw new Error("--output is required");
  if (mode === "package" && !packageArgument)
    throw new Error("--package is required in package mode");
  if (mode === "baseline" && packageArgument)
    throw new Error("--package is only valid in package mode");
  return { mode, packageArgument, output };
}

function section(markdown: string, heading: string): string {
  const match = markdown.match(
    new RegExp(`(?:^|\\n)## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  if (!match) throw new Error(`scenario is missing section: ${heading}`);
  return match[1].trim();
}

export async function loadScenario(
  name: SkillName,
  scenariosDirectory: string,
): Promise<Scenario> {
  const markdown = await readFile(
    join(scenariosDirectory, `${name}.md`),
    "utf8",
  );
  const criteria = (heading: string): string[] =>
    section(markdown, heading)
      .split("\n")
      .filter((line) => line.startsWith("- `") && line.endsWith("`"))
      .map((line) => line.slice(3, -1));
  const required = criteria("Required observations");
  const forbidden = criteria("Forbidden observations");
  if (required.length === 0 || forbidden.length === 0)
    throw new Error(`${name} must define required and forbidden observations`);
  return { name, prompt: section(markdown, "Prompt"), required, forbidden };
}

function evaluateCriterion(text: string, criterion: string): boolean {
  if (criterion.startsWith("qualifying-questions>=")) {
    const separator = criterion.indexOf(":");
    if (separator < 0)
      throw new Error(
        `qualifying question criterion needs a topic regex: ${criterion}`,
      );
    const minimum = Number.parseInt(
      criterion.slice("qualifying-questions>=".length, separator),
      10,
    );
    if (!Number.isInteger(minimum))
      throw new Error(`invalid qualifying question criterion: ${criterion}`);
    const topic = new RegExp(criterion.slice(separator + 1), "i");
    const questions = text.match(/[^\n.!?]*\?/g) ?? [];
    return (
      questions.filter((question) => topic.test(question)).length >= minimum
    );
  }
  if (criterion.startsWith("questions>=")) {
    const minimum = Number.parseInt(criterion.slice("questions>=".length), 10);
    if (!Number.isInteger(minimum))
      throw new Error(`invalid question criterion: ${criterion}`);
    return (text.match(/\?/g) ?? []).length >= minimum;
  }
  if (criterion.startsWith("contains:"))
    return text
      .toLocaleLowerCase()
      .includes(criterion.slice("contains:".length).toLocaleLowerCase());
  if (criterion.startsWith("regex:"))
    return new RegExp(criterion.slice("regex:".length), "i").test(text);
  throw new Error(`unknown criterion: ${criterion}`);
}

export function evaluateScenario(
  scenario: Scenario,
  text: string,
): ScenarioSummary {
  const required = scenario.required.map((criterion) => ({
    criterion,
    passed: evaluateCriterion(text, criterion),
  }));
  const forbidden = scenario.forbidden.map((criterion) => ({
    criterion,
    passed: !evaluateCriterion(text, criterion),
  }));
  return {
    skill: scenario.name,
    discovered: true,
    passed:
      required.every((result) => result.passed) &&
      forbidden.every((result) => result.passed),
    required,
    forbidden,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function canonicalTarget(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return join(await realpath(ancestor), ...missing);
}

async function prepareOutput(
  path: string,
  repository: string,
): Promise<string> {
  const [canonicalRepository, canonicalOutput] = await Promise.all([
    realpath(repository),
    canonicalTarget(path),
  ]);
  if (isWithin(canonicalRepository, canonicalOutput)) {
    throw new Error(`output directory must be outside the repository: ${path}`);
  }
  await mkdir(canonicalOutput, { recursive: true });
  const createdOutput = await realpath(canonicalOutput);
  if (isWithin(canonicalRepository, createdOutput)) {
    throw new Error(`output directory resolves inside the repository: ${path}`);
  }
  return createdOutput;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function copyCredentialFiles(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  for (const name of ["auth.json", "models.json"]) {
    const source = join(sourceDirectory, name);
    try {
      const contents = await readFile(source);
      await writeFile(join(destinationDirectory, name), contents, {
        mode: 0o600,
      });
      await chmod(join(destinationDirectory, name), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function buildMinimalEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "VOLTA_HOME",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return { ...environment, ...overrides };
}

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal, "scenario aborted");
}

async function createFixture(
  root: string,
  signal: AbortSignal,
): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = join(root, "repository");
  const agentDirectory = join(root, "pi-agent");
  const binDirectory = join(root, "bin");
  const beadsDirectory = join(root, "beads", ".beads");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(beadsDirectory, { recursive: true }),
  ]);

  const sourceAgentDirectory =
    process.env.PI_SKILL_TEST_CREDENTIAL_DIR ?? join(homedir(), ".pi", "agent");
  await copyCredentialFiles(sourceAgentDirectory, agentDirectory);
  throwIfAborted(signal);

  await writeFile(
    join(beadsDirectory, "fixture-123.json"),
    JSON.stringify(
      {
        id: "fixture-123",
        title: "Finish fixture migration",
        status: "in_progress",
      },
      null,
      2,
    ),
  );
  const fakeBd = join(binDirectory, "bd");
  await writeFile(
    fakeBd,
    `#!/bin/sh\nset -eu\nexpected=${shellQuote(beadsDirectory)}\nif [ "\${BEADS_DIR:-}" != "$expected" ]; then\n  echo "unexpected BEADS_DIR" >&2\n  exit 2\nfi\ncase " $* " in\n  *" --json "*) printf '%s\\n' '[{"id":"fixture-123","title":"Finish fixture migration","status":"in_progress"}]' ;;\n  *) printf '%s\\n' 'fixture-123 [in_progress] Finish fixture migration' ;;\nesac\n`,
  );
  await chmod(fakeBd, 0o755);

  const env = buildMinimalEnvironment(process.env, {
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_CLIENT_SESSION_ID: "skill-behavior-fixture",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    BEADS_DIR: beadsDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: root,
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
  });

  await runCommand(
    "git",
    ["init", "--initial-branch", "fixture-handoff"],
    cwd,
    env,
    signal,
  );
  await runCommand(
    "git",
    ["config", "user.name", "Skill Fixture"],
    cwd,
    env,
    signal,
  );
  await runCommand(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    cwd,
    env,
    signal,
  );
  await writeFile(join(cwd, "fixture-change.txt"), "before\n");
  await runCommand("git", ["add", "fixture-change.txt"], cwd, env, signal);
  await runCommand(
    "git",
    ["commit", "-m", "Created fixture"],
    cwd,
    env,
    signal,
  );
  await writeFile(join(cwd, "fixture-change.txt"), "before\nafter\n");
  return { cwd, env };
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`process group ${pid} did not exit`);
}

async function terminateProcessGroup(
  child: ChildProcess,
  exited: Promise<ProcessExit>,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await exited;
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 250)),
  ]);
  signalProcessGroup(child, "SIGKILL");
  await exited;
  await waitForProcessGroupExit(pid);
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.once("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<ProcessExit>((resolvePromise) =>
    child.once("close", (code, exitSignal) =>
      resolvePromise({ code, signal: exitSignal }),
    ),
  );
  let termination: Promise<void> | undefined;
  const onAbort = () => {
    termination ??= terminateProcessGroup(child, exited);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const result = await exited;
  signal.removeEventListener("abort", onAbort);
  if (signal.aborted) {
    await termination;
    throw abortError(signal, `${command} aborted`);
  }
  if (spawnError) throw spawnError;
  if (result.code !== 0) {
    throw new Error(
      `${command} exited ${result.code} (signal=${result.signal}): ${stderr}`,
    );
  }
}

interface RpcProcessOptions {
  executable?: string;
  signal?: AbortSignal;
}

export class RpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 0;
  private stderr = "";
  private stopped = false;
  private failure: Error | undefined;
  private exited: Promise<ProcessExit>;
  private stopPromise: Promise<void> | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;
  private pending = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  private eventWaiters: Array<{
    type: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: RpcProcessOptions = {},
  ) {
    this.child = spawn(options.executable ?? "pi", args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise<ProcessExit>((resolvePromise) =>
      this.child.once("close", (code, signal) =>
        resolvePromise({ code, signal }),
      ),
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
    });
    this.child.once("error", (error) =>
      this.fail(new Error(`failed to start pi: ${error.message}`)),
    );
    this.child.once("close", (code, signal) => {
      if (!this.stopped)
        this.fail(
          new Error(
            `pi exited before RPC completion (code=${code}, signal=${signal}): ${this.stderr}`,
          ),
        );
    });
    this.abortSignal = options.signal;
    if (this.abortSignal) {
      this.abortListener = () => {
        void this.stop(abortError(this.abortSignal!, "scenario aborted")).catch(
          (error: unknown) =>
            this.fail(
              error instanceof Error ? error : new Error(String(error)),
            ),
        );
      };
      this.abortSignal.addEventListener("abort", this.abortListener, {
        once: true,
      });
      if (this.abortSignal.aborted) this.abortListener();
    }
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.fail(new Error(`invalid RPC JSON: ${line.slice(0, 200)}`));
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const request = this.pending.get(message.id);
      if (!request) {
        this.fail(new Error(`unexpected RPC response id: ${message.id}`));
        return;
      }
      this.pending.delete(message.id);
      request.resolve(message as unknown as RpcResponse);
      return;
    }
    if (message.type === "extension_error") {
      this.fail(new Error(`Pi extension error: ${JSON.stringify(message)}`));
      return;
    }
    if (message.type === "message_end") {
      const agentMessage = message.message as
        | { role?: string; stopReason?: string; errorMessage?: string }
        | undefined;
      if (
        agentMessage?.role === "assistant" &&
        agentMessage.stopReason === "error"
      ) {
        this.fail(
          new Error(
            `assistant failed: ${agentMessage.errorMessage ?? "unknown model error"}`,
          ),
        );
        return;
      }
    }
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.type === message.type) {
        this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const waiter of this.eventWaiters) waiter.reject(error);
    this.eventWaiters = [];
  }

  request(
    type: string,
    fields: Record<string, unknown> = {},
  ): Promise<RpcResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = `skill-test-${++this.nextId}`;
    return new Promise<RpcResponse>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.child.stdin.write(
        `${JSON.stringify({ id, type, ...fields })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    }).then((response) => {
      if (!response.success)
        throw new Error(
          `RPC ${type} failed: ${response.error ?? "unknown error"}`,
        );
      return response;
    });
  }

  waitFor(type: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolvePromise, reject) =>
      this.eventWaiters.push({ type, resolve: resolvePromise, reject }),
    );
  }

  async stop(reason = new Error("RPC process stopped")): Promise<void> {
    this.fail(reason);
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.abortSignal && this.abortListener) {
        this.abortSignal.removeEventListener("abort", this.abortListener);
      }
      this.child.stdin.destroy();
      this.stopPromise = terminateProcessGroup(this.child, this.exited);
    }
    await this.stopPromise;
  }
}

async function runScenario(
  scenario: Scenario,
  options: Options,
  outputDirectory: string,
): Promise<ScenarioSummary> {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), `pi-skill-${scenario.name}-`),
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`${scenario.name} exceeded ${scenarioTimeoutMs / 1_000}s`),
      ),
    scenarioTimeoutMs,
  );
  let rpc: RpcProcess | undefined;
  try {
    const fixture = await createFixture(fixtureRoot, controller.signal);
    throwIfAborted(controller.signal);
    const modelSetting = process.env.PI_SKILL_TEST_MODEL;
    if (!modelSetting)
      throw new Error("PI_SKILL_TEST_MODEL=<provider>/<model> is required");
    const slash = modelSetting.indexOf("/");
    if (slash <= 0 || slash === modelSetting.length - 1) {
      throw new Error(
        "PI_SKILL_TEST_MODEL must contain a provider and model separated by the first slash",
      );
    }
    const provider = modelSetting.slice(0, slash);
    const model = modelSetting.slice(slash + 1);
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      provider,
      "--model",
      model,
      "--no-context-files",
      "--no-approve",
      "--offline",
    ];
    if (options.mode === "package") args.push("-e", options.packageArgument!);
    rpc = new RpcProcess(args, fixture.cwd, fixture.env, {
      signal: controller.signal,
    });
    const commandResponse = await rpc.request("get_commands");
    const commands = (
      commandResponse.data as { commands?: RpcCommandEntry[] } | undefined
    )?.commands;
    if (!Array.isArray(commands))
      throw new Error("get_commands returned no command list");
    const discovered = commands.some(
      (command) =>
        command.name === `skill:${scenario.name}` && command.source === "skill",
    );

    if (options.mode === "baseline") {
      return {
        skill: scenario.name,
        discovered,
        passed: !discovered,
        required: [],
        forbidden: [],
      };
    }
    if (!discovered) {
      return {
        skill: scenario.name,
        discovered: false,
        passed: false,
        required: [],
        forbidden: [],
      };
    }

    const settled = rpc.waitFor("agent_settled");
    await rpc.request("prompt", {
      message: `/skill:${scenario.name} ${scenario.prompt}`,
    });
    await settled;
    const textResponse = await rpc.request("get_last_assistant_text");
    const text = (textResponse.data as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || text.trim().length === 0)
      throw new Error(`${scenario.name} returned no final assistant text`);
    await writeFile(
      join(outputDirectory, `${scenario.name}.txt`),
      `${text.trim()}\n`,
    );
    return evaluateScenario(scenario, text);
  } finally {
    clearTimeout(timer);
    await rpc?.stop(
      controller.signal.aborted
        ? abortError(controller.signal, "scenario aborted")
        : new Error("scenario complete"),
    );
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export function baselineExitCode(summaries: ScenarioSummary[]): 0 | 1 {
  return summaries.some((summary) => summary.discovered) ? 0 : 1;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repository = resolve(scriptDirectory, "..");
  const outputDirectory = await prepareOutput(options.output, repository);
  const scenarios = await Promise.all(
    skillNames.map((name) =>
      loadScenario(name, join(scriptDirectory, "skill-scenarios")),
    ),
  );
  const summaries: ScenarioSummary[] = [];
  for (const scenario of scenarios) {
    const summary = await runScenario(scenario, options, outputDirectory);
    summaries.push(summary);
    console.log(
      `${options.mode} ${scenario.name}: ${summary.passed ? "PASS" : "FAIL"}${summary.discovered ? "" : " (not discovered)"}`,
    );
  }
  await writeFile(
    join(outputDirectory, "summary.json"),
    `${JSON.stringify({ mode: options.mode, scenarios: summaries }, null, 2)}\n`,
  );
  if (options.mode === "baseline") {
    const discovered = summaries
      .filter((summary) => summary.discovered)
      .map((summary) => summary.skill);
    if (baselineExitCode(summaries) === 0) {
      console.log(
        `baseline unexpectedly discovered: ${discovered.join(", ")}; returning success so the wrapper fails`,
      );
      return;
    }
    throw new Error(
      "baseline expected nonzero: all requested skills are undiscoverable",
    );
  }
  if (summaries.some((summary) => !summary.passed))
    throw new Error("one or more skill behavior criteria failed");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
