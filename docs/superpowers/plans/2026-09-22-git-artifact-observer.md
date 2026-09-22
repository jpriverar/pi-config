# Git Artifact Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically attach verified branch, commit, and pull-request artifacts to the session-owned Active task after successful ordinary Bash Git operations.

**Architecture:** A deterministic classifier turns bounded Bash `git` and `gh` commands into process-local observation intents. A post-state observer resolves those intents through injected `git`/`gh` executors, and lifecycle hooks correlate `tool_call` with successful `tool_result` before one locked service mutation records the verified artifacts.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 with NodeNext `.js` imports, Pi extension hooks, `pi.exec`, Beads lifecycle metadata V1, `tsx --test`, and Prettier.

**Spec:** `docs/superpowers/specs/2026-09-22-git-artifact-observer-design.md`

## Global Constraints

- Observe only Pi's standard `bash` tool in V1; `ctx_execute`, custom tools, IDEs, and external processes remain explicit gaps.
- Support direct unambiguous `git commit`, `git commit --amend`, `git push`, and `gh pr create` command shapes only.
- Reuse `extensions/shared/shell-command.ts`; do not add a regex-only parser, model call, runtime dependency, or Bun.
- Never block, rewrite, or convert the underlying Bash result into an error because artifact observation failed.
- Treat Bash input, command output, Git state, GitHub output, and task metadata as untrusted.
- Never expose raw commands, stdout, stderr, credentials, task content, or provider responses in diagnostics.
- Associate artifacts with exactly one Active task owned by the session captured at `tool_call`; recheck ownership under the lifecycle lock before persistence.
- Keep lifecycle metadata at version 1 and preserve locked full-object read/merge/write plus read-back verification through the existing store.
- Automatically observed artifacts use existing `branch`, `commit`, and `pull_request` kinds, fixed compatibility role `evidence`, empty `sourceArtifactIds`, and `supersededAt: null`.
- No V1 behavior may infer importance from the compatibility role or add source relationships, reachability, supersession, or completion semantics.
- Keep `task_attach_artifact` available for non-Git artifacts and observation gaps.
- Use focused RED/GREEN TDD, NodeNext `.js` imports, curated errors, and small logical commits.

## Review Focus

- **Shell success ambiguity:** `git commit || true`, pipelines, heredocs, substitutions, and multi-command programs must remain allowed but produce no observation intent; Task 1 pins this.
- **Push ref differs from `HEAD`:** a supported `git push -u origin topic` must resolve `topic`, while multi-ref or dynamic refspecs produce no intent; Tasks 1 and 2 pin this.
- **Ownership changes between hooks:** a command captured for one task/session must not mutate another task after waiting, closing, reload loss, or lease replacement; Tasks 3 and 4 pin this.
- **Untrusted repository and GitHub data:** credential-bearing remotes, malformed SHAs, forged URLs, and malformed JSON must attach nothing and must not appear in diagnostics; Task 2 pins this.
- **Existing branch identity:** observing a branch already attached by worktree acquisition must preserve the existing artifact ID instead of creating a duplicate kind/URI identity; Task 3 pins this.

---

## File Structure

### New files

- `extensions/task-lifecycle/git-artifact-command.ts` — pure deterministic Bash command classification and effective Git working-directory/ref extraction.
- `extensions/task-lifecycle/git-artifact-command.test.ts` — accepted and rejected command-shape coverage.
- `extensions/task-lifecycle/git-artifact-observer.ts` — injected Git/GitHub post-state resolution, validation, and minimal `ArtifactInput` construction.
- `extensions/task-lifecycle/git-artifact-observer.test.ts` — temporary-repository Git tests and stubbed GitHub verification tests.
- `extensions/task-lifecycle/git-artifact-hooks.ts` — process-local `toolCallId` correlation and non-blocking Pi hook registration.
- `extensions/task-lifecycle/git-artifact-hooks.test.ts` — hook interleaving, ownership, failure, warning, and cleanup tests.

### Modified files

- `lib/task-lifecycle/service.ts` — one atomic `recordObservedArtifacts` service operation.
- `lib/task-lifecycle/service.test.ts` — batch insertion, deduplication, ownership, retry, and atomic-failure tests.
- `extensions/task-lifecycle/index.ts` — production observer construction with `pi.exec` and hook registration at the composition boundary.
- `extensions/task-lifecycle/index.test.ts` — verify observer wiring while preserving the public task tool list and existing worktree hooks.
- `docs/task-lifecycle.md` — document automatic Git coverage, non-blocking behavior, and explicit V1 gaps.

---

### Task 1: Deterministic Git and GitHub command classification

**Files:**
- Create: `extensions/task-lifecycle/git-artifact-command.ts`
- Create: `extensions/task-lifecycle/git-artifact-command.test.ts`
- Read: `extensions/shared/shell-command.ts`
- Read: `extensions/worktree-pool/command-policy.ts`

**Interfaces:**
- Consumes: `splitShellCommands(command: string): ShellCommand[]` and `unwrapExecutable(command: ShellCommand): { executable: string; args: string[] } | undefined`.
- Produces:

```ts
export type GitArtifactObservationIntent =
  | {
      kind: "git-head";
      operation: "commit" | "push";
      cwd: string;
      ref: string;
    }
  | {
      kind: "github-pr";
      operation: "pr-create";
      cwd: string;
      repository?: string;
      head?: string;
    };

export interface GitArtifactCommandClassifier {
  classify(command: string, cwd: string): GitArtifactObservationIntent[];
}

export function createDeterministicGitArtifactClassifier(): GitArtifactCommandClassifier;
```

- [ ] **Step 1: Write failing tests for accepted direct commands**

Create table-driven tests that require these exact classifications:

```ts
const classifier = createDeterministicGitArtifactClassifier();

assert.deepEqual(classifier.classify("git commit -m 'ship it'", "/repo"), [
  { kind: "git-head", operation: "commit", cwd: "/repo", ref: "HEAD" },
]);
assert.deepEqual(
  classifier.classify("git -C ../other commit --amend --no-edit", "/repo/sub"),
  [{
    kind: "git-head",
    operation: "commit",
    cwd: "/repo/other",
    ref: "HEAD",
  }],
);
assert.deepEqual(
  classifier.classify("GH_TOKEN=x gh pr create --repo DataDog/dd-go --head topic", "/repo"),
  [{
    kind: "github-pr",
    operation: "pr-create",
    cwd: "/repo",
    repository: "DataDog/dd-go",
    head: "topic",
  }],
);
```

Also cover `/usr/bin/git`, `command git`, `env -u UNUSED git`, `git push`, `git push origin`, and `git push -u origin topic`.

- [ ] **Step 2: Write failing tests for ambiguous and unsafe shapes**

Require an empty intent list for:

```ts
for (const command of [
  "git status --short",
  "git commit --dry-run",
  "git push --dry-run origin topic",
  "git push origin one two",
  "git push origin HEAD:refs/heads/topic",
  "git commit || true",
  "git add . && git commit -m ship",
  "git commit | tee output",
  "bash -lc 'git commit -m ship'",
  "cat <<'EOF'\ngit commit -m ship\nEOF",
  "git $(printf commit) -m ship",
  "gh pr create --dry-run",
  "gh pr view 123",
]) {
  assert.deepEqual(classifier.classify(command, "/repo"), [], command);
}
```

These tests deliberately choose high precision over partial shell interpretation.

- [ ] **Step 3: Run the classifier test and verify RED**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/git-artifact-command.test.ts
```

Expected: FAIL because `git-artifact-command.ts` and its exports do not exist.

- [ ] **Step 4: Implement the minimal classifier**

Implement a single-segment classifier:

```ts
export function createDeterministicGitArtifactClassifier(): GitArtifactCommandClassifier {
  return {
    classify(command, cwd) {
      if (command.length === 0 || command.length > 16_384) return [];
      if (containsOpaqueShell(command)) return [];
      const segments = splitShellCommands(command);
      if (segments.length !== 1) return [];
      const executable = unwrapExecutable(segments[0]);
      if (executable === undefined) return [];
      const name = basename(executable.executable);
      if (name === "git") return classifyGit(executable.args, cwd);
      if (name === "gh") return classifyGh(executable.args, cwd);
      return [];
    },
  };
}
```

Use an argv scanner, not command regexes, to:

- apply repeated `git -C <path>` relative to the preceding effective directory;
- skip supported Git global options with and without attached arguments using the same option set as `worktree-pool/command-policy.ts`;
- identify the first Git subcommand;
- accept `commit` unless `--dry-run` is present;
- accept `push` with no positional args, one remote, or one remote plus one simple local branch/`HEAD` ref;
- reject refspecs containing `:`, multiple refs, `--all`, `--mirror`, and `--dry-run`;
- parse `gh pr create` plus optional `--repo`/`-R` and `--head` values;
- reject all other `gh` commands and `--dry-run`.

Conservatively reject raw command strings containing heredoc markers, command substitution, backticks, or more than one shell segment. This check is a safety filter around the tokenizer, not artifact authority.

- [ ] **Step 5: Run classifier tests and typecheck**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/git-artifact-command.test.ts
npm run typecheck
```

Expected: classifier tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the classifier**

```bash
git add extensions/task-lifecycle/git-artifact-command.ts \
  extensions/task-lifecycle/git-artifact-command.test.ts
git diff --cached --name-only
git commit -m "task: classify Git artifact commands"
```

Expected staged files: only the two classifier files.

---

### Task 2: Verified Git and GitHub post-state observation

**Files:**
- Create: `extensions/task-lifecycle/git-artifact-observer.ts`
- Create: `extensions/task-lifecycle/git-artifact-observer.test.ts`
- Read: `lib/task-lifecycle/checks.ts`
- Read: `lib/task-lifecycle/model.ts:332-405`

**Interfaces:**
- Consumes: `GitArtifactObservationIntent` from Task 1 and `ArtifactInput` from `lib/task-lifecycle/types.ts`.
- Produces:

```ts
export interface GitArtifactExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitArtifactExecutor {
  run(
    executable: "git" | "gh",
    args: readonly string[],
    cwd: string,
  ): Promise<GitArtifactExecutionResult>;
}

export interface GitArtifactObserver {
  observe(
    intents: readonly GitArtifactObservationIntent[],
  ): Promise<ArtifactInput[]>;
}

export function createGitArtifactObserver(deps: {
  executor: GitArtifactExecutor;
}): GitArtifactObserver;
```

- [ ] **Step 1: Write failing temporary-repository tests for commit observation**

Create a helper that initializes a temporary repository with branch `topic`, configures an origin fetch URL such as `https://github.com/DataDog/example.git`, and commits a fixture file. Assert:

```ts
assert.deepEqual(await observer.observe([
  { kind: "git-head", operation: "commit", cwd: repo, ref: "HEAD" },
]), [
  {
    id: `branch:example:refs/heads/topic`,
    kind: "branch",
    uri: "git://example/refs/heads/topic",
    title: "example topic",
    role: "evidence",
    sourceArtifactIds: [],
    supersededAt: null,
  },
  {
    id: `commit:example:${head}`,
    kind: "commit",
    uri: `git://example/commit/${head}`,
    title: `example ${head.slice(0, 12)}`,
    role: "evidence",
    sourceArtifactIds: [],
    supersededAt: null,
  },
]);
```

Add a detached-HEAD case that returns only the commit artifact and an amend case that returns the new SHA without interpreting the old SHA.

- [ ] **Step 2: Write failing push-ref and validation tests**

Use a local bare push URL while keeping the GitHub fetch URL as repository identity. Verify `ref: "topic"` resolves that branch even when another branch is checked out.

Require an empty result for:

- missing repository;
- missing or credential-bearing remote identity;
- nonzero Git query result;
- malformed branch ref;
- malformed SHA;
- SHA or output longer than the configured bounds.

Assert thrown executor errors are converted to one curated observer error without including fixture secrets, stdout, or stderr.

- [ ] **Step 3: Write failing GitHub PR verification tests**

Stub `gh` so the observer runs an argv-only verification command equivalent to:

```bash
gh pr view topic --repo DataDog/dd-go --json number,url,headRefName
```

Return:

```json
{"number":15955,"url":"https://github.com/ddoghq/dd-go/pull/15955","headRefName":"topic"}
```

Assert one `pull_request` artifact plus the verified branch artifact. Add malformed JSON, non-GitHub URL, repository mismatch, invalid number, oversized output, nonzero exit, and secret-bearing stderr cases; each must attach nothing or throw only the curated observer error.

- [ ] **Step 4: Run observer tests and verify RED**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/git-artifact-observer.test.ts
```

Expected: FAIL because the observer does not exist.

- [ ] **Step 5: Implement repository and PR observation**

Implement Git queries through `GitArtifactExecutor.run`, never through a shell:

```ts
await executor.run("git", ["rev-parse", "--show-toplevel"], intent.cwd);
await executor.run("git", ["config", "--get", "remote.origin.url"], root);
await executor.run(
  "git",
  ["rev-parse", "--symbolic-full-name", "--verify", intent.ref],
  root,
);
await executor.run(
  "git",
  ["rev-parse", "--verify", `${intent.ref}^{commit}`],
  root,
);
```

For `ref: "HEAD"`, use `git symbolic-ref --quiet --short HEAD` to discover an attached branch. For an explicit push ref, accept the `rev-parse --symbolic-full-name` result only when it is a full `refs/heads/...` ref. A detached `HEAD` is valid and produces only a commit artifact.

Normalize only credential-free repository identities. For GitHub-style remotes, remove `.git` and use the repository basename for V1 `git://<repository>/...` compatibility with worktree branch artifacts. Reject local paths, embedded credentials, query strings, fragments, NULs, and identities outside the bounded character set.

For PRs, run `gh pr view` with the parsed `--repo` and `--head` hints, request JSON, decode a strict object, and use the canonical GitHub URL as authority. Never include executor output in an exception.

Return artifacts in stable `branch`, `commit`, then `pull_request` order and deduplicate identical kind/URI observations within one call.

- [ ] **Step 6: Run observer and classifier tests**

Run:

```bash
npm run test:file -- \
  extensions/task-lifecycle/git-artifact-command.test.ts \
  extensions/task-lifecycle/git-artifact-observer.test.ts
npm run typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit the observer**

```bash
git add extensions/task-lifecycle/git-artifact-observer.ts \
  extensions/task-lifecycle/git-artifact-observer.test.ts
git diff --cached --name-only
git commit -m "task: observe Git artifacts"
```

Expected staged files: only the observer and observer test.

---

### Task 3: Atomic lifecycle persistence for observed artifacts

**Files:**
- Modify: `lib/task-lifecycle/service.ts:191-214`
- Modify: `lib/task-lifecycle/service.test.ts`

**Interfaces:**
- Consumes: validated `readonly ArtifactInput[]` from Task 2.
- Produces:

```ts
async recordObservedArtifacts(
  taskId: string,
  inputs: readonly ArtifactInput[],
  owner: LockOwner,
  operationId: string,
): Promise<LifecycleIssue>;
```

- [ ] **Step 1: Write failing service tests for atomic insertion and retry**

Create an Active task owned by `s1`. Call `recordObservedArtifacts` with branch and commit inputs and assert:

```ts
assert.deepEqual(
  saved.lifecycle?.artifacts.map(({ kind, uri }) => ({ kind, uri })),
  [
    { kind: "branch", uri: "git://example/refs/heads/topic" },
    { kind: "commit", uri: `git://example/commit/${sha}` },
  ],
);
assert.equal(
  saved.lifecycle?.transitionHistory.at(-1)?.type,
  "observe_artifacts",
);
```

Call again with the same `operationId` and assert no additional artifact or transition is added.

- [ ] **Step 2: Write failing ownership, atomicity, and branch-dedup tests**

Cover:

- zero inputs reject with `observed artifacts must not be empty`;
- foreign or expired ownership rejects before mutation;
- a valid first artifact plus malformed second artifact leaves the store unchanged;
- an existing worktree-created branch with ID `branch:claim-1` and the same kind/URI remains the sole branch artifact after observation;
- a same deterministic ID with contradictory kind/URI rejects without partial mutation;
- errors do not contain artifact titles, URIs, or injected secret text.

- [ ] **Step 3: Run the service test and verify RED**

Run:

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts
```

Expected: FAIL because `recordObservedArtifacts` does not exist.

- [ ] **Step 4: Implement one locked batch mutation**

Implement beside `attachArtifact`:

```ts
async recordObservedArtifacts(
  taskId: string,
  inputs: readonly ArtifactInput[],
  owner: LockOwner,
  operationId: string,
): Promise<LifecycleIssue> {
  if (inputs.length === 0) {
    throw new Error("observed artifacts must not be empty");
  }
  const now = this.nowIso();
  return this.deps.store.mutate(taskId, owner, (issue) => {
    const lifecycle = requireManaged(issue);
    requireCurrentOwner(taskId, lifecycle, owner);
    if (hasOperation(lifecycle, operationId)) {
      return this.mutation(issue, operationId, issue.status, lifecycle);
    }
    const artifacts = inputs.map((input) =>
      canonicalizeArtifact(input, now, owner.sessionId),
    );
    const attached = artifacts.reduce(attachArtifactToLifecycle, lifecycle);
    const next = recordOperation(
      attached,
      operationId,
      "observe_artifacts",
      now,
      owner.sessionId,
    );
    return this.mutation(issue, operationId, issue.status, next);
  });
}
```

Use the existing imported model function name (`attachArtifact` is currently aliased as `attachArtifactToLifecycle`) and canonicalize the full batch before reducing so malformed later inputs cannot create a partial in-memory result.

- [ ] **Step 5: Run service, model, and type tests**

Run:

```bash
npm run test:file -- \
  lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.test.ts
npm run typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit atomic persistence**

```bash
git add lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts
git diff --cached --name-only
git commit -m "task: record observed artifacts"
```

Expected staged files: only the service and service test.

---

### Task 4: Non-blocking Bash hook correlation and production wiring

**Files:**
- Create: `extensions/task-lifecycle/git-artifact-hooks.ts`
- Create: `extensions/task-lifecycle/git-artifact-hooks.test.ts`
- Modify: `extensions/task-lifecycle/index.ts:35-110,620-760,1000-1045`
- Modify: `extensions/task-lifecycle/index.test.ts`

**Interfaces:**
- Consumes: `GitArtifactCommandClassifier`, `GitArtifactObserver`, `TaskLifecycleService.activeTasksForSession`, and `TaskLifecycleService.recordObservedArtifacts`.
- Produces:

```ts
export interface GitArtifactHookService {
  activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
  recordObservedArtifacts(
    taskId: string,
    artifacts: readonly ArtifactInput[],
    owner: LockOwner,
    operationId: string,
  ): Promise<LifecycleIssue>;
}

export function registerGitArtifactHooks(
  pi: {
    on(
      event: "tool_call" | "tool_result",
      handler: (event: any, context: GitArtifactHookContext) => unknown,
    ): void;
  },
  deps: {
    service: GitArtifactHookService;
    classifier: GitArtifactCommandClassifier;
    observer: GitArtifactObserver;
  },
): void;
```

`GitArtifactHookContext` contains `cwd`, `sessionManager.getSessionId()`, and `ui.notify(message, "warning")`.

- [ ] **Step 1: Write failing hook tests for capture and successful finalization**

Use a fake Pi event registry. Set one Active task, classify one commit intent, and return branch plus commit artifacts from the fake observer.

Assert:

- `tool_call` returns `undefined` and does not mutate its input;
- `tool_result` returns `undefined`, preserving the original Bash result;
- `recordObservedArtifacts` receives the task captured at call time, artifact batch, captured session owner, and operation ID `git-artifacts:<toolCallId>`;
- a later result with the same call ID performs no second write.

- [ ] **Step 2: Write failing hook tests for passive gaps and races**

Cover:

- non-Bash tools, missing command, unclassified Bash, and zero Active tasks do nothing;
- multiple Active tasks or lookup failure emit only `Git artifact observation skipped; use task_attach_artifact if needed.` and never block;
- failed Bash results do not invoke the observer;
- observer or service failures emit only `Git artifact observation failed; use task_attach_artifact if needed.`;
- warning text excludes fake raw command, stdout, stderr, provider error, and task content;
- interleaved calls finalize against their own captured task and intent;
- ownership changes are delegated to service recheck and never redirect artifacts;
- unmatched results and reload-created fresh hook registries do nothing;
- every matched result clears its pending map entry even when observation throws.

- [ ] **Step 3: Run hook tests and verify RED**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/git-artifact-hooks.test.ts
```

Expected: FAIL because the hook registrar does not exist.

- [ ] **Step 4: Implement process-local correlation**

Implement a private pending map:

```ts
type PendingGitArtifactObservation = {
  taskId: string;
  owner: LockOwner;
  intents: readonly GitArtifactObservationIntent[];
  operationId: string;
};

const pending = new Map<string, PendingGitArtifactObservation>();
```

At `tool_call`, only inspect `toolName === "bash"`, a string `input.command`, and a string `toolCallId`. Classify before task lookup so unrelated Bash calls do not query Beads. Capture only when exactly one Active task belongs to the current session.

At `tool_result`, delete the pending entry before awaiting any adapter. Skip `isError === true`. Observe and persist nonempty artifacts. Catch all observer and persistence errors, notify with the curated warning, and return `undefined` so the Bash result is never replaced.

- [ ] **Step 5: Wire production executors in `index.ts`**

Construct the classifier and observer at the composition boundary:

```ts
const gitArtifactObserver = createGitArtifactObserver({
  executor: {
    async run(executable, args, cwd) {
      const result = await pi.exec!(executable, [...args], {
        cwd,
        timeout: 10_000,
      });
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  },
});

registerGitArtifactHooks(pi, {
  service,
  classifier: createDeterministicGitArtifactClassifier(),
  observer: gitArtifactObserver,
});
```

Keep `extensions/task-lifecycle/index.ts` as composition only; do not merge hook logic into the existing worktree handler. Preserve all ten public `task_*` tools unchanged.

- [ ] **Step 6: Extend extension composition tests**

Update the harness service fake with `recordObservedArtifacts`. Assert hook registration does not change the public tool list and the existing worktree acquire/release tests remain unchanged.

Add one composition test proving the production dependency shape accepts `pi.exec` with `{ cwd, timeout: 10_000 }` and does not invoke it for unrelated Bash.

- [ ] **Step 7: Run extension-focused tests and typecheck**

Run:

```bash
npm run test:file -- \
  extensions/task-lifecycle/git-artifact-command.test.ts \
  extensions/task-lifecycle/git-artifact-observer.test.ts \
  extensions/task-lifecycle/git-artifact-hooks.test.ts \
  extensions/task-lifecycle/index.test.ts
npm run typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 8: Commit hook integration**

```bash
git add extensions/task-lifecycle/git-artifact-hooks.ts \
  extensions/task-lifecycle/git-artifact-hooks.test.ts \
  extensions/task-lifecycle/index.ts \
  extensions/task-lifecycle/index.test.ts
git diff --cached --name-only
git commit -m "task: correlate Git artifact hooks"
```

Expected staged files: only hook, composition, and corresponding test files.

---

### Task 5: Documentation, repository verification, and live acceptance preparation

**Files:**
- Modify: `docs/task-lifecycle.md`
- Test: all files changed in Tasks 1-4 plus repository gates

**Interfaces:**
- Consumes: the complete observer feature from Tasks 1-4.
- Produces: documented operator behavior and a branch ready for integration and live verification.

- [ ] **Step 1: Add lifecycle documentation**

Document:

- automatic observation of Bash `git commit`, `git push`, and `gh pr create`;
- association with the one session-owned Active task, independent of worktree/repository;
- minimal branch/commit/PR facts and fixed compatibility metadata;
- non-blocking behavior and curated warnings;
- unsupported compound/dynamic commands and Bash-only scope;
- continued availability of `task_attach_artifact`;
- the fact that observation does not determine completion evidence or artifact importance.

Include this recovery guidance exactly:

```text
Git artifact observation failed; use task_attach_artifact if needed.
```

- [ ] **Step 2: Format changed files and check diff hygiene**

Run:

```bash
npx prettier --write \
  extensions/task-lifecycle/git-artifact-command.ts \
  extensions/task-lifecycle/git-artifact-command.test.ts \
  extensions/task-lifecycle/git-artifact-observer.ts \
  extensions/task-lifecycle/git-artifact-observer.test.ts \
  extensions/task-lifecycle/git-artifact-hooks.ts \
  extensions/task-lifecycle/git-artifact-hooks.test.ts \
  extensions/task-lifecycle/index.ts \
  extensions/task-lifecycle/index.test.ts \
  lib/task-lifecycle/service.ts \
  lib/task-lifecycle/service.test.ts

git diff --check
```

Expected: Prettier exits 0 and `git diff --check` prints nothing.

- [ ] **Step 3: Run the complete affected suite**

Run:

```bash
npm run test:file -- \
  extensions/shared/shell-command.test.ts \
  extensions/worktree-pool/command-policy.test.ts \
  extensions/task-lifecycle/git-artifact-command.test.ts \
  extensions/task-lifecycle/git-artifact-observer.test.ts \
  extensions/task-lifecycle/git-artifact-hooks.test.ts \
  extensions/task-lifecycle/index.test.ts \
  lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.test.ts \
  tests/task-lifecycle-integration.test.ts \
  tests/package-load.test.ts
```

Expected: all affected tests PASS.

- [ ] **Step 4: Run repository-wide gates**

Run each command independently so an unrelated timeout does not hide later evidence:

```bash
npm test
npm run typecheck
npm run format:check
npm run verify:portable
npm run licenses:check
npm run verify:smoke
node --test tests/manifest.test.mjs
```

Expected: all commands exit 0. If the known bounded-allocation lock timeout or RPC smoke shutdown hang recurs, preserve the exact output, run only the focused owning test once, and report the discrepancy rather than claiming a clean full run.

- [ ] **Step 5: Commit documentation and final branch state**

```bash
git add docs/task-lifecycle.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: explain Git artifact observer"
git status --short --branch
```

Expected staged file: only `docs/task-lifecycle.md`; final checkout is clean.

- [ ] **Step 6: Prepare live verification checklist without mutating `main`**

Record these acceptance operations for post-integration execution on `jp-5mey`:

```text
1. Install the integrated package and /reload.
2. Run a direct Bash git commit; verify one branch and one commit artifact.
3. Run the same observer path again; verify deterministic deduplication.
4. Run a direct Bash git push; verify no duplicate branch/commit artifacts.
5. Run a direct Bash gh pr create; verify one canonical pull_request artifact.
6. Run a failed commit and an unsupported compound command; verify no artifact mutation.
7. Compare every persisted ID and URI against Git/GitHub state.
8. Close jp-5mey only after automatic artifacts provide the selected evidence and task_close releases its worktree.
```

Do not push, install, create a live PR, or close the task without JP's explicit integration approval.
