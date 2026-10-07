"""Publish space navigation metadata from a serialized Herdr snapshot."""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

SOURCE = "plugin:jp.space-tabs"
COMMAND_SECONDS = 2
REFRESH_SECONDS = 10
# The final event must survive one successful holder's full refresh budget.
LOCK_SECONDS = REFRESH_SECONDS + 1
MAX_REPLY_BYTES = 1024 * 1024
ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")


class HerdrError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def display_text(value):
    text = ANSI.sub("", value)
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", text)
    return " ".join(text.split())[:80]


def records(snapshot, key, id_key):
    values = snapshot.get(key)
    if not isinstance(values, list):
        raise ValueError(f"snapshot {key} must be a list")
    result = {}
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get(id_key), str) or not row[id_key]:
            raise ValueError(f"snapshot {key} contains an invalid {id_key}")
        if row[id_key] in result:
            raise ValueError(f"snapshot {key} contains a duplicate {id_key}")
        result[row[id_key]] = row
    return result


def active_task_labels(snapshot, workspaces, tabs):
    claims = {workspace_id: set() for workspace_id in workspaces}
    unavailable = set()
    now_ms = int(time.time() * 1000)
    for pane in records(snapshot, "panes", "pane_id").values():
        workspace_id, tab_id = pane.get("workspace_id"), pane.get("tab_id")
        if (not isinstance(workspace_id, str) or workspace_id not in workspaces
                or not isinstance(tab_id, str) or tab_id not in tabs
                or tabs[tab_id]["workspace_id"] != workspace_id):
            raise ValueError("snapshot pane has invalid workspace or tab")
        if pane.get("agent") != "pi":
            continue
        data = pane.get("tokens")
        if not isinstance(data, dict):
            unavailable.add(workspace_id)
            continue
        state = data.get("pi_task_state")
        if state in ("unassigned", "expired"):
            continue
        task_id, expires = data.get("pi_task_id"), data.get("pi_task_expires_at")
        if (state != "assigned" or not isinstance(task_id, str) or not task_id
                or display_text(task_id) != task_id or not isinstance(expires, str)
                or not 1 <= len(expires) <= 16 or not expires.isascii() or not expires.isdigit()):
            unavailable.add(workspace_id)
        elif int(expires) > now_ms:
            claims[workspace_id].add(task_id)
    return {workspace_id: "tasks unavailable" if workspace_id in unavailable else f"{len(ids)} in-progress"
            for workspace_id, ids in claims.items()}


def workspace_tokens(snapshot):
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot must be an object")
    workspaces = records(snapshot, "workspaces", "workspace_id")
    tabs = records(snapshot, "tabs", "tab_id")
    counts = {workspace_id: 0 for workspace_id in workspaces}
    for tab in tabs.values():
        workspace_id = tab.get("workspace_id")
        if not isinstance(workspace_id, str) or workspace_id not in workspaces or not isinstance(tab.get("label"), str):
            raise ValueError("snapshot tab has invalid workspace or label")
        counts[workspace_id] += 1
    task_labels = active_task_labels(snapshot, workspaces, tabs)
    result = {}
    for workspace_id, workspace in workspaces.items():
        active_id = workspace.get("active_tab_id")
        if active_id is not None and not isinstance(active_id, str):
            raise ValueError("snapshot space has invalid active_tab_id")
        existing = workspace.get("tokens", {})
        if not isinstance(existing, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in existing.items()):
            raise ValueError("snapshot space has invalid metadata")
        active = tabs.get(active_id)
        label = ""
        if active is not None and active["workspace_id"] == workspace_id:
            normalized = display_text(active["label"])
            if normalized:
                label = display_text(f"tab: {normalized}")
        count = counts[workspace_id]
        result[workspace_id] = {"active_tab": label, "tab_count": f"{count} {'tab' if count == 1 else 'tabs'}", "active_tasks": task_labels[workspace_id]}
    return result


def run_herdr(binary, args, deadline, allow_empty=False):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HerdrError("space metadata refresh deadline exceeded")
    operation = " ".join(args[:3])
    try:
        result = subprocess.run([binary, *args], capture_output=True, text=True, timeout=min(COMMAND_SECONDS, remaining))
    except subprocess.TimeoutExpired as error:
        raise HerdrError(f"herdr {operation} timed out") from error
    except OSError as error:
        raise HerdrError(f"unable to execute herdr {operation}") from error
    output = result.stdout if result.returncode == 0 else result.stderr
    if result.returncode == 0 and allow_empty and not output.strip():
        return {}
    if len(output.encode("utf-8")) > MAX_REPLY_BYTES:
        raise HerdrError(f"herdr {operation} response exceeded limit")
    try:
        reply = json.loads(output)
    except (ValueError, TypeError) as error:
        raise HerdrError(f"herdr {operation} returned invalid JSON") from error
    if not isinstance(reply, dict):
        raise HerdrError(f"herdr {operation} returned an invalid response")
    problem = reply.get("error")
    if result.returncode != 0 or problem is not None:
        code = problem.get("code") if isinstance(problem, dict) else None
        raise HerdrError(f"herdr {operation} failed", code)
    if not isinstance(reply.get("result"), dict):
        raise HerdrError(f"herdr {operation} returned no result")
    return reply["result"]


@contextmanager
def refresh_lock(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir / "sync.lock").open("a") as handle:
        deadline = time.monotonic() + LOCK_SECONDS
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise HerdrError("space metadata refresh lock timed out")
                time.sleep(0.02)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def refresh(binary, state_dir):
    with refresh_lock(state_dir):
        deadline = time.monotonic() + REFRESH_SECONDS
        snapshot = run_herdr(binary, ["api", "snapshot"], deadline).get("snapshot")
        desired = workspace_tokens(snapshot)
        existing = {row["workspace_id"]: row.get("tokens", {}) for row in snapshot["workspaces"]}
        failures = []
        for workspace_id, tokens in desired.items():
            if all(existing[workspace_id].get(key, "") == value for key, value in tokens.items()):
                continue
            args = ["workspace", "report-metadata", workspace_id, "--source", SOURCE]
            for key, value in tokens.items():
                args.extend(["--token", f"{key}={value}"] if value else ["--clear-token", key])
            try:
                run_herdr(binary, args, deadline, allow_empty=True)
            except HerdrError as error:
                # A space can close after the snapshot without invalidating others.
                if error.code != "not_found":
                    failures.append(str(error))
        if failures:
            raise HerdrError("; ".join(failures))


def main():
    state = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_SOCKET_PATH") or not state:
        raise HerdrError("Herdr plugin context is required for space metadata refresh")
    refresh(os.environ.get("HERDR_BIN_PATH") or "herdr", Path(state))


if __name__ == "__main__":
    try:
        main()
    except (HerdrError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
