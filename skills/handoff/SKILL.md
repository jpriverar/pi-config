---
name: handoff
description: Generate a concise session handoff for resuming work in a new session or passing context to another agent. Gathers the current Git state, configured Beads work items, and conversation context into a structured resume prompt.
---

# Session Handoff Generator

Generate a handoff prompt that lets a fresh session or another agent resume work with minimal ramp-up.

## Steps

1. **Locate and gather the current Git state.** Never assume a checkout name or path. Run these commands from the current directory and report failures rather than substituting another repository:
   - `git rev-parse --show-toplevel` — actual repository root
   - `git status --short` — modified and untracked files
   - `git diff --stat` — change summary
   - `git log --oneline -5` — recent commits
   - `git branch --show-current` — current branch

2. **Read the configured work state.** Resolve the Beads store without assuming that it lives in the Git checkout:

   ```sh
   beads_dir="${BEADS_DIR:-"$HOME/beads/.beads"}"
   BEADS_DIR="$beads_dir" bd list --status in_progress
   BEADS_DIR="$beads_dir" bd list --status blocked
   ```

   Include relevant in-progress or blocked issue IDs and titles. If Beads is unavailable, say which configured store was checked and report the failure without inventing work items.

3. **Capture conversation state.** Identify the active goal, completed work, remaining work, known bugs, failing tests, and blockers from the current conversation. Do not claim tests passed unless their result is present in the conversation or gathered state.

4. **Generate the handoff prompt** in this format:

```markdown
## Resume — [Date]

### Goal

[What we're working on and why]

### Current State

- Repo: [repository name and actual root]
- Branch: [branch name]
- Modified files: [list]
- Work items: [relevant Beads IDs and titles]
- Test status: [passing, failing, or not run, with details]

### Done

[Completed items this session]

### Remaining

[Pending items, ordered by priority]

### Blockers

[Any bugs, failing tests, or external blockers]

### Key Files

[Files most relevant to the current task, with brief descriptions]

### Next Step

[The exact next action to take]
```

## Notes

- Use only the repository and Beads store discovered from the current environment.
- Keep it concise; a handoff longer than a screen defeats the purpose.
- Reference relevant Beads issues by ID so the receiving session can inspect them.
- Output the handoff in chat unless the user explicitly requests another destination.
