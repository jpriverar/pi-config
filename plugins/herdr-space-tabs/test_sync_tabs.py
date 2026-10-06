import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from sync_tabs import workspace_tokens

SCRIPT = Path(__file__).with_name("sync_tabs.py")


def snapshot():
    return {
        "workspaces": [
            {"workspace_id": "w1", "active_tab_id": "w1:t2", "tokens": {}},
            {"workspace_id": "w2", "active_tab_id": "w2:t1", "tokens": {}},
        ],
        "tabs": [
            {"tab_id": "w1:t1", "workspace_id": "w1", "label": "shell"},
            {"tab_id": "w1:t2", "workspace_id": "w1", "label": "review"},
            {"tab_id": "w2:t1", "workspace_id": "w2", "label": "research"},
        ],
    }


class TokenTests(unittest.TestCase):
    def test_counts_all_tabs_and_uses_each_spaces_active_id(self):
        self.assertEqual(workspace_tokens(snapshot()), {
            "w1": {"active_tab": "tab: review", "tab_count": "2 tabs"},
            "w2": {"active_tab": "tab: research", "tab_count": "1 tab"},
        })

    def test_missing_foreign_and_zero_tab_states_never_guess(self):
        for active in [None, "missing", "w2:t1"]:
            value = snapshot()
            value["workspaces"][0]["active_tab_id"] = active
            self.assertEqual(workspace_tokens(value)["w1"]["active_tab"], "")
        value = snapshot()
        value["tabs"] = []
        self.assertEqual(workspace_tokens(value)["w1"], {"active_tab": "", "tab_count": "0 tabs"})

    def test_sanitizes_control_sequences_and_caps_the_complete_label(self):
        value = snapshot()
        value["tabs"][1]["label"] = "\x1b]0;secret\x07review\n auth\x1b[31m"
        self.assertEqual(workspace_tokens(value)["w1"]["active_tab"], "tab: review auth")
        value["tabs"][1]["label"] = "😀" * 100
        self.assertEqual(workspace_tokens(value)["w1"]["active_tab"], "tab: " + "😀" * 75)

    def test_rejects_malformed_snapshots_instead_of_clearing_good_metadata(self):
        for value in [{}, {"workspaces": [], "tabs": None}, {"workspaces": [None], "tabs": []}, {"workspaces": [{"workspace_id": "w1"}], "tabs": [{}]}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                workspace_tokens(value)
        value = snapshot()
        value["tabs"].append(copy.deepcopy(value["tabs"][0]))
        with self.assertRaises(ValueError):
            workspace_tokens(value)


FAKE = r'''
import json, os, sys, time
from pathlib import Path
path = Path(os.environ["FIXTURE"])
log = Path(os.environ["CALLS"])
args = sys.argv[1:]
if args == ["api", "snapshot"]:
    if os.environ.get("HANG"):
        time.sleep(20)
    if os.environ.get("MALFORMED"):
        print("not json")
        sys.exit(0)
    value = json.loads(path.read_text())
    with log.open("a") as f: f.write(json.dumps(["snapshot", value["tabs"][1]["label"]]) + "\n")
    print(json.dumps({"result": {"snapshot": value}}))
elif args[:2] == ["workspace", "report-metadata"]:
    if os.environ.get("DISAPPEAR") == args[2]:
        print(json.dumps({"error": {"code": "not_found"}}), file=sys.stderr)
        sys.exit(1)
    if os.environ.get("BLOCK"):
        Path(os.environ["BLOCK"]).touch()
        while not Path(os.environ["RELEASE"]).exists(): time.sleep(0.01)
    value = json.loads(path.read_text())
    row = next(w for w in value["workspaces"] if w["workspace_id"] == args[2])
    for i, item in enumerate(args):
        if item == "--token":
            key, text = args[i + 1].split("=", 1)
            row["tokens"][key] = text
        elif item == "--clear-token": row["tokens"].pop(args[i + 1], None)
    path.write_text(json.dumps(value))
    with log.open("a") as f: f.write(json.dumps(args) + "\n")
    print(json.dumps({"result": {"type": "workspace_metadata"}}))
else:
    raise RuntimeError(args)
'''


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-tabs-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture = self.root / "snapshot.json"
        self.fixture.write_text(json.dumps(snapshot()))
        self.log = self.root / "calls.jsonl"
        self.binary = self.root / "fake-herdr"
        self.binary.write_text("#!" + sys.executable + "\n" + FAKE)
        self.binary.chmod(0o700)
        self.state = self.root / "state"
        self.state.mkdir()
        self.env = {**os.environ, "HERDR_ENV": "1", "HERDR_SOCKET_PATH": str(self.root / "test.sock"), "HERDR_BIN_PATH": str(self.binary), "HERDR_PLUGIN_STATE_DIR": str(self.state), "FIXTURE": str(self.fixture), "CALLS": str(self.log)}

    def run_refresh(self, **extra):
        return subprocess.run([sys.executable, "-B", str(SCRIPT)], env={**self.env, **extra}, capture_output=True, text=True, timeout=12)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_publishes_changed_values_only_and_clears_missing_active_tab(self):
        first = self.run_refresh()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(self.calls()), 3)
        self.assertEqual(self.run_refresh().returncode, 0)
        self.assertEqual(len(self.calls()), 4)
        value = json.loads(self.fixture.read_text())
        value["workspaces"][0]["active_tab_id"] = "missing"
        self.fixture.write_text(json.dumps(value))
        self.assertEqual(self.run_refresh().returncode, 0)
        self.assertIn("--clear-token", self.calls()[-1])
        self.assertNotIn("active_tab", json.loads(self.fixture.read_text())["workspaces"][0]["tokens"])

    def test_malformed_response_and_timeout_make_no_metadata_writes(self):
        malformed = self.run_refresh(MALFORMED="1")
        self.assertNotEqual(malformed.returncode, 0)
        started = time.monotonic()
        hung = self.run_refresh(HANG="1")
        self.assertNotEqual(hung.returncode, 0)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(self.calls(), [])

    def test_closed_space_does_not_prevent_other_spaces_refreshing(self):
        result = self.run_refresh(DISAPPEAR="w1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.fixture.read_text())["workspaces"][1]["tokens"]["active_tab"], "tab: research")

    def test_lock_contention_is_bounded_and_does_not_query_before_lock(self):
        with (self.state / "sync.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            result = self.run_refresh()
            self.assertNotEqual(result.returncode, 0)
            self.assertLess(time.monotonic() - started, 6)
            self.assertEqual(self.calls(), [])

    def test_concurrent_events_take_their_snapshot_after_serialization(self):
        block, release = self.root / "blocked", self.root / "release"
        first = subprocess.Popen([sys.executable, "-B", str(SCRIPT)], env={**self.env, "BLOCK": str(block), "RELEASE": str(release)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: first.kill() if first.poll() is None else None)
        deadline = time.monotonic() + 4
        while not block.exists() and time.monotonic() < deadline: time.sleep(0.01)
        self.assertTrue(block.exists())
        second = subprocess.Popen([sys.executable, "-B", str(SCRIPT)], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: second.kill() if second.poll() is None else None)
        value = json.loads(self.fixture.read_text())
        value["tabs"][1]["label"] = "new review"
        self.fixture.write_text(json.dumps(value))
        release.touch()
        first.communicate(timeout=8); second.communicate(timeout=8)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(json.loads(self.fixture.read_text())["workspaces"][0]["tokens"]["active_tab"], "tab: new review")
        self.assertEqual([call for call in self.calls() if call[0] == "snapshot"], [["snapshot", "review"], ["snapshot", "new review"]])

    def test_refuses_missing_plugin_context_instead_of_targeting_live_default(self):
        result = self.run_refresh(HERDR_ENV="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
