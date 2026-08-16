import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
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

interface Scenario {
  name: SkillName;
  prompt: string;
  required: string[];
  forbidden: string[];
}

interface CriterionResult {
  criterion: string;
  passed: boolean;
}

interface ScenarioSummary {
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

async function loadScenario(
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

function evaluateScenario(scenario: Scenario, text: string): ScenarioSummary {
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

async function linkIfPresent(
  sourceDirectory: string,
  destinationDirectory: string,
  name: string,
): Promise<void> {
  const source = join(sourceDirectory, name);
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await symlink(source, join(destinationDirectory, name));
}

async function createFixture(
  root: string,
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
  await Promise.all([
    linkIfPresent(sourceAgentDirectory, agentDirectory, "auth.json"),
    linkIfPresent(sourceAgentDirectory, agentDirectory, "models.json"),
    linkIfPresent(sourceAgentDirectory, agentDirectory, "models-store.json"),
  ]);

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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    BEADS_DIR: beadsDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: root,
    PATH: `${binDirectory}${sep === "/" ? ":" : ";"}${process.env.PATH ?? ""}`,
  };

  await run("git", ["init", "--initial-branch", "fixture-handoff"], cwd, env);
  await run("git", ["config", "user.name", "Skill Fixture"], cwd, env);
  await run(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    cwd,
    env,
  );
  await writeFile(join(cwd, "fixture-change.txt"), "before\n");
  await run("git", ["add", "fixture-change.txt"], cwd, env);
  await run("git", ["commit", "-m", "Created fixture"], cwd, env);
  await writeFile(join(cwd, "fixture-change.txt"), "before\nafter\n");
  return { cwd, env };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited ${code}: ${stderr}`)),
    );
  });
}

class RpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 0;
  private stderr = "";
  private stopped = false;
  private failure: Error | undefined;
  private pending = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  private eventWaiters: Array<{
    type: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn("pi", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-16_384);
    });
    this.child.once("error", (error) =>
      this.fail(new Error(`failed to start pi: ${error.message}`)),
    );
    this.child.once("exit", (code, signal) => {
      if (!this.stopped)
        this.fail(
          new Error(
            `pi exited before RPC completion (code=${code}, signal=${signal}): ${this.stderr}`,
          ),
        );
    });
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolvePromise) =>
        this.child.once("exit", () => resolvePromise()),
      ),
      new Promise<void>((resolvePromise) =>
        setTimeout(() => {
          this.child.kill("SIGKILL");
          resolvePromise();
        }, 1_000),
      ),
    ]);
  }
}

async function withTimeout<T>(
  name: SkillName,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${name} exceeded ${scenarioTimeoutMs / 1_000}s`)),
          scenarioTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  let rpc: RpcProcess | undefined;
  try {
    return await withTimeout(scenario.name, async () => {
      const fixture = await createFixture(fixtureRoot);
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
      rpc = new RpcProcess(args, fixture.cwd, fixture.env);
      const commandResponse = await rpc.request("get_commands");
      const commands = (
        commandResponse.data as { commands?: RpcCommandEntry[] } | undefined
      )?.commands;
      if (!Array.isArray(commands))
        throw new Error("get_commands returned no command list");
      const discovered = commands.some(
        (command) =>
          command.name === `skill:${scenario.name}` &&
          command.source === "skill",
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
    });
  } finally {
    await rpc?.stop();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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
    throw new Error("baseline skills are intentionally undiscoverable");
  }
  if (summaries.some((summary) => !summary.passed))
    throw new Error("one or more skill behavior criteria failed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
