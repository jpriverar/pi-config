# jp-workflow

`jp-workflow` keeps the current Beads work state available to both the user and
the model. A new, empty session gets a visible task table. Before every agent
turn, the extension also injects a hidden Markdown summary so tracked work does
not have to be restated in the prompt.

## Store selection

The extension uses `BEADS_DIR` when it is non-empty. Otherwise it falls back to
`~/beads/.beads`. The selected directory is passed to every `bd` invocation with
`--db`; reads and mutations therefore use the same store regardless of the
current working directory.

The extension obtains normalized issue data through the shared Beads client.
It runs `bd list` for active issues and `bd ready` for dependency-aware
readiness. An open issue omitted by `bd ready` is **Waiting**, not Ready.

## Display behavior

The startup table is a durable transcript entry created only for a fresh
`startup` or `new` session with no existing conversation. It shows every active
issue exactly once. Unnamed sessions group issues by their first
`workstream:*` label and put unlabeled issues last under **Inbox • no project**.
Named sessions match that primary workstream case-insensitively. Additional
workstream labels retain their source order but do not duplicate an issue into
other groups. The table switches to stacked rows when the terminal is too
narrow for useful columns.

The hidden model context is intentionally smaller than the visible table. Its
sections count the complete matching set but render at most:

| Section         | Unnamed | Named |
| --------------- | ------: | ----: |
| In progress     |      10 |    10 |
| Blocked         |      10 |    10 |
| Needs you       |      10 |     — |
| Ready           |       5 |     8 |
| Inbox           |       8 |     — |
| Stale inbox IDs |       5 |     — |

A truncated section says `showing N`. The visible startup table does not use
these caps.

An empty store produces an explicit empty state. If the CLI, selected store, or
response is unavailable, hidden context contains a stable unavailable state and
the startup hook emits a warning instead of throwing. Failures identify the
operation and selected store, but omit raw process and parser content because
it may contain task data.

## Tools

The extension registers three tools:

- `file_issue` creates an issue. It requires `title` and `why`, maps
  `workstream` to `workstream:<value>`, and maps `needs_jp` to `needs:jp`. The
  model must only call it after explicit user approval.
- `update_issue` changes status, labels, or notes without separate approval.
  An empty mutation is rejected. `in_progress` uses `--claim`; closing is not
  accepted here.
- `close_issue` closes verified work without separate approval. A `reason` is
  required, and `--suggest-next` is always enabled.

All mutations request JSON output and return the decoded JSON response. A
mutation failure reports its operation and selected store without including raw
stdout or stderr.

After compaction, the extension queues a fresh hidden summary for the next
turn. Store failures never interrupt compaction.
