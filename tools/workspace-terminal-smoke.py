
"""Bounded macOS/Linux PTY smoke for the already-built workspace CLI.

Run from any directory with `python3 tools/workspace-terminal-smoke.py`.
Uses only the standard library; does not build, install, or touch source fixtures.
Each child owns a controlling terminal/session, has a 20-second lifetime limit,
and is reaped (including on an assertion failure). Machine output is inspected
as emitted, never ANSI-stripped or mixed with the interactive transcript.
"""

import argparse
import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "apps/cli/dist/main.js"
DEMO = ROOT / "fixtures/v3/succession-world"
WAIT_SECONDS = 8.0
CHILD_SECONDS = 20.0
MAX_OUTPUT = 8 * 1024 * 1024

DOWN = b"\x1b[B"
END = b"\x1b[F"
SAVE = b"\x13"  # Ctrl+S, not Enter (which inserts a newline in multiline fields).
ENTER = b"\r"
REASON = "No military seizure; keep civilian rule.\nPrefer diplomacy. 中立"
RATIONALE = "Keep the dynasty.\nThe council governs by consent. 👑"
DIRECTION = (
    "Preserve civilian rule.\nKeep the existing dynasty. Prefer diplomacy.\n"
    "No automatic canon changes."
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def environment(**overrides):
    env = dict(os.environ)
    env.pop("FORCE_COLOR", None)
    env.update(TERM="xterm-256color", NO_COLOR="1", NODE_NO_WARNINGS="1", CI="1")
    env.update(overrides)
    return env


def controlling_terminal():
    # Popen has already duplicated the slave onto fd 0. setsid prevents inheriting
    # the runner's session; TIOCSCTTY makes signals/resizes target this real TTY.
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    os.tcsetpgrp(0, os.getpgrp())


# macOS revokes slave descriptors when the controlling session leader exits.
# Keep a supervisor alive until the parent has checked Node's restored termios;
# the supervisor never changes those attributes or interprets terminal input.
SUPERVISOR = """
import json, os, select, signal, subprocess, sys
report = os.fdopen(int(sys.argv[1]), "w", buffering=1)
release = int(sys.argv[2])
child = subprocess.Popen(sys.argv[3:], close_fds=True)
print(json.dumps({"pid": child.pid, "foreground": os.tcgetpgrp(0)}), file=report)
try:
    code = child.wait(timeout=20)
except subprocess.TimeoutExpired:
    child.kill()
    code = child.wait(timeout=2)
print(json.dumps({"code": code}), file=report)
select.select([release], [], [], 20)
"""


class Terminal:
    def __init__(self, node, args, env=None):
        self.master, self.slave = pty.openpty()
        self.report, report_write = os.pipe()
        release_read, self.release = os.pipe()
        self.output = bytearray()
        self.report_buffer = bytearray()
        self.child_pid = None
        self.foreground = None
        self.exit_code = None
        self.eof = False
        self.report_eof = False
        self.deadline = time.monotonic() + CHILD_SECONDS
        self.original = termios.tcgetattr(self.slave)
        self.resize(120, 36)
        os.set_blocking(self.master, False)
        os.set_blocking(self.report, False)
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-c", SUPERVISOR, str(report_write), str(release_read), node, str(MAIN), *args],
                cwd=ROOT, env=env or environment(), stdin=self.slave, stdout=self.slave, stderr=self.slave,
                preexec_fn=controlling_terminal, pass_fds=(report_write, release_read), close_fds=True,  # noqa: PLW1509 -- this stdlib runner is single-threaded
            )
        except BaseException:
            for fd in (self.master, self.slave, self.report, self.release):
                os.close(fd)
            raise
        finally:
            os.close(report_write)
            os.close(release_read)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            if self.child_pid is not None and self.exit_code is None:
                self.signal(signal.SIGTERM)
                self.drain(0.5)
                if self.exit_code is None:
                    self.signal(signal.SIGKILL)
                    self.drain(0.2)
            os.close(self.release)
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=2)
        finally:
            for fd in (self.master, self.slave, self.report):
                os.close(fd)

    def signal(self, signum):
        pid = self.child_pid
        if pid is None:
            raise AssertionError("PTY supervisor has not reported the Node PID")
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    def resize(self, columns, rows):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        # TIOCSWINSZ sends SIGWINCH to the foreground process group. No simulated
        # stream dimensions or UI/controller imports are involved.

    def pump(self, seconds=0.1):
        descriptors = ([] if self.eof else [self.master]) + ([] if self.report_eof else [self.report])
        ready, _, _ = select.select(descriptors, [], [], max(0, min(seconds, 0.1)))
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO and fd == self.master:
                    self.eof = True  # Linux PTY EOF; macOS may return b"".
                    continue
                if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                raise
            if fd == self.report:
                if not data:
                    self.report_eof = True
                    continue
                self.report_buffer.extend(data)
                require(len(self.report_buffer) < 4096, "Invalid PTY supervisor report")
                while b"\n" in self.report_buffer:
                    line, _, rest = self.report_buffer.partition(b"\n")
                    self.report_buffer = bytearray(rest)
                    message = json.loads(line)
                    if "pid" in message:
                        self.child_pid = message["pid"]
                        self.foreground = message["foreground"]
                    if "code" in message:
                        self.exit_code = message["code"]
            elif not data:
                self.eof = True
            else:
                self.output.extend(data)
                require(len(self.output) <= MAX_OUTPUT, "PTY exceeded the 8 MiB output limit")

    def drain(self, seconds=0.12):
        until = min(time.monotonic() + seconds, self.deadline)
        while time.monotonic() < until:
            self.pump(min(0.05, until - time.monotonic()))

    def expect(self, text, since=0):
        needle = text.encode("utf-8") if isinstance(text, str) else text
        until = min(time.monotonic() + WAIT_SECONDS, self.deadline)
        while needle not in self.output[since:]:
            if time.monotonic() >= until:
                raise AssertionError(f"Timed out waiting for {needle!r}; PTY tail: {bytes(self.output[-3000:])!r}")
            if self.exit_code is not None or self.process.poll() is not None:
                self.drain()
                if needle not in self.output[since:]:
                    raise AssertionError(f"CLI exited {self.exit_code} waiting for {needle!r}; PTY tail: {bytes(self.output[-3000:])!r}")
                break
            self.pump()
        self.drain()

    def write(self, data):
        require(self.exit_code is None and self.process.poll() is None, "Cannot type into an exited CLI")
        until = min(time.monotonic() + 2, self.deadline)
        remaining = memoryview(data)
        while remaining:
            require(time.monotonic() < until, "Timed out writing PTY input")
            _, ready, _ = select.select([], [self.master], [], 0.05)
            if ready:
                try:
                    count = os.write(self.master, remaining)
                    remaining = remaining[count:]
                except BlockingIOError:
                    pass

    def key(self, data, expected=None):
        self.drain(0.04)
        mark = len(self.output)
        self.write(data)
        if expected is not None:
            self.expect(expected, mark)
        else:
            # Wait for a fresh render, not an old match in the accumulated screen.
            until = min(time.monotonic() + WAIT_SECONDS, self.deadline)
            while len(self.output) == mark:
                require(time.monotonic() < until, f"No render after {data!r}")
                require(self.exit_code is None and self.process.poll() is None, f"CLI exited after {data!r}")
                self.pump()
            self.drain()

    def paste(self, text, expected=None):
        self.key(b"\x1b[200~" + text.encode("utf-8") + b"\x1b[201~", expected)

    def ready(self, version):
        self.expect(f"Saved v{version}")
        self.expect("CANON READ-ONLY")
        current = termios.tcgetattr(self.slave)
        require(not current[3] & (termios.ICANON | termios.ECHO), "Ink did not put the actual PTY into raw mode")
        require(not current[0] & termios.IXON, "Raw mode left flow control enabled (Ctrl+S would freeze input)")
        pid = self.child_pid
        if pid is None:
            raise AssertionError("PTY supervisor did not report its child")
        require(os.getsid(pid) == self.process.pid, "PTY child did not enter the supervisor's isolated session")
        require(self.foreground == self.process.pid and os.getpgid(pid) == self.foreground, "Node is not in the controlling terminal's foreground process group")

    def finish(self, code, interactive=True):
        until = min(time.monotonic() + WAIT_SECONDS, self.deadline)
        while self.exit_code is None:
            require(time.monotonic() < until, f"CLI did not exit; PTY tail: {bytes(self.output[-3000:])!r}")
            require(self.process.poll() is None, "PTY supervisor exited without reporting the CLI result")
            self.pump()
        self.drain()
        require(self.exit_code == code, f"Expected exit {code}, got {self.exit_code}; PTY tail: {bytes(self.output[-3000:])!r}")
        require(termios.tcgetattr(self.slave) == self.original, "CLI failed to restore the original termios attributes")
        transcript = bytes(self.output)
        if interactive:
            supported = []
            # Check only modes actually enabled by this Ink/terminal combination.
            for name, start, end in [
                ("cursor", b"\x1b[?25l", b"\x1b[?25h"),
                ("bracketed paste", b"\x1b[?2004h", b"\x1b[?2004l"),
                ("alternate screen", b"\x1b[?1049h", b"\x1b[?1049l"),
                ("alternate screen 1047", b"\x1b[?1047h", b"\x1b[?1047l"),
                ("alternate screen 47", b"\x1b[?47h", b"\x1b[?47l"),
            ]:
                if start in transcript:
                    require(transcript.rfind(end) > transcript.rfind(start), f"Ink did not clean up {name}")
                    supported.append(name)
            require(b"WMM /" in transcript, "Actual Ink never rendered a workspace")
            return supported
        require(b"\x1b" not in transcript, "Plain TTY output contains terminal escapes")
        return []


def run(node, args, input_bytes=b"", env=None):
    child = subprocess.Popen(
        [node, str(MAIN), *args], cwd=ROOT, env=env or environment(),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = child.communicate(input_bytes, timeout=WAIT_SECONDS)
        require(len(stdout) + len(stderr) <= MAX_OUTPUT, "Machine/plain CLI exceeded the output limit")
        require(stderr == b"", f"Unexpected CLI stderr: {stderr[-2000:]!r}")
        require(child.returncode == 0, f"CLI exited {child.returncode}: {stdout[-2000:]!r}")
        return stdout
    finally:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate(timeout=2)


def json_output(raw):
    text = raw.decode("utf-8", errors="strict")
    require(not re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", text), "Machine stdout contains raw terminal controls")
    require(text.endswith("\n") and text.count("\n") == 1, f"Expected one JSON response line, got {text[:300]!r}")
    response = json.loads(text)
    require(response.get("format") == "wmm.response/1", "Machine response format changed")
    require(response.get("apiVersion") == "wmm/1", "Machine API version changed")
    require(response.get("outcome") == "success", f"Machine operation failed: {text[:2000]}")
    require(response.get("execution") == "completed", "Machine operation did not complete")
    canonical = json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    require(text == canonical, "Machine stdout is not the unchanged canonical JSON transport")
    return response


def read(node, directory, version=None):
    payload = {"workspaceId": "main"}
    if version is not None:
        payload["atVersion"] = version
    request = {
        "format": "wmm.request/1", "apiVersion": "wmm/1",
        "requestId": f"pty-read-中立-{version or 'latest'}", "operation": "workspace.read", "payload": payload,
    }
    raw = run(node, ["json", "--workspace-dir", str(directory)], json.dumps(request, ensure_ascii=False).encode("utf-8"))
    response = json_output(raw)
    require(response.get("requestId") == request["requestId"], "JSON requestId correlation changed")
    require(response.get("operation") == request["operation"], "JSON operation correlation changed")
    view = response["data"]
    require(response["resolved"] == view["workspace"]["base"], "JSON resolved base changed")
    require(view["validation"]["status"] == "not-run" and view["approval"] == "unavailable" and view["canon"] == "unchanged", "Editor crossed the draft/canon boundary")
    return view


def plain_output(raw, version):
    text = raw.decode("utf-8", errors="strict")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", text), "Plain output contains terminal controls")
    for heading in ["CANON READ-ONLY", "CHANGES", "WORLD / READ-ONLY", "CONSTRAINTS", "SAVED WORKSPACE DECISIONS", "REVIEW / DRAFT CANDIDATE", "Validation: NOT RUN", "Approval: unavailable", "Canon: unchanged", f"Saved workspace v{version}"]:
        require(heading in text, f"Readable plain inspection is missing {heading!r}")
    require(not any(shortcut in text for shortcut in ["Ctrl+", "Space: select", "q: quit", "[1 Changes]"]), "Plain output contains interactive/readline prompts")
    return text


def workflow(node, directory):
    args = ["--workspace-dir", str(directory)]
    with Terminal(node, ["workspace", "demo", *args]) as terminal:
        terminal.ready(1)
        terminal.key(b" ", "Saved v2")  # Explicit death selection, never implicit prerequisites.
        terminal.key(DOWN)
        terminal.key(b" ", "Saved v3")  # Explicit council selection, after death.
        terminal.key(DOWN)
        terminal.key(b"r", "REJECT PROPOSAL")
        terminal.paste(REASON.split("\n")[0])
        terminal.key(ENTER)
        mark = len(terminal.output)
        terminal.resize(80, 24)  # Resize while a multiline form owns its buffer/cursor.
        terminal.expect("REJECT PROPOSAL", mark)
        terminal.paste(REASON.split("\n")[1])
        terminal.key(SAVE, "Saved v4")
        terminal.key(b"a", "ADD AN EXPLICIT ALTERNATIVE")
        terminal.key(DOWN)
        terminal.key(ENTER, "DEMO REGENCY TEMPLATE")
        terminal.key(b"\t", "Field 2/2: Rationale")
        terminal.paste(RATIONALE)
        mark = len(terminal.output)
        terminal.resize(120, 36)
        terminal.expect("DEMO REGENCY TEMPLATE", mark)
        terminal.key(SAVE, "Saved v5")
        terminal.key(DOWN)  # Intervention remains undecided.
        terminal.key(DOWN)  # The newly added regency is not selected automatically.
        terminal.key(b" ", "Saved v6")
        terminal.key(b"n", "ADVISORY DIRECTION")
        terminal.key(b"\x01")  # Ctrl+A moves to buffer start; it is not select-all.
        terminal.paste("Preserve civilian rule.\n")
        terminal.key(END)
        terminal.key(ENTER)
        mark = len(terminal.output)
        terminal.resize(80, 24)
        terminal.expect("ADVISORY DIRECTION", mark)
        terminal.paste("No automatic canon changes.")
        terminal.key(SAVE, "Saved v7")
        terminal.key(b"2", "BASE WORLD / READ-ONLY")
        terminal.key(b"3", "PINS / ADVISORY")
        terminal.key(b"4", "SAVED WORKSPACE DECISIONS")
        terminal.key(b"5", "REVIEW / DRAFT CANDIDATE")
        terminal.write(b"q")
        supported = terminal.finish(0)

    saved = read(node, directory)
    state = saved["workspace"]
    expected_actions = [
        {"kind": "decide", "groupId": "death", "decision": "selected"},
        {"kind": "decide", "groupId": "council", "decision": "selected"},
        {"kind": "decide", "groupId": "coup", "decision": "rejected", "reason": REASON},
        {"kind": "add-regency", "title": "Negotiate a regency", "rationale": RATIONALE},
        {"kind": "decide", "groupId": "regency", "decision": "selected"},
        {"kind": "set-direction", "text": DIRECTION},
    ]
    require(state["id"] == "main" and state["version"] == 7, "Unexpected saved workspace ID/version")
    require(state["history"] == [{"version": i + 2, "action": action} for i, action in enumerate(expected_actions)], f"Exact saved history differs: {state['history']!r}")
    groups = {group["id"]: group for group in state["proposals"]}
    require({key: group["decision"] for key, group in groups.items()} == {
        "death": "selected", "council": "selected", "coup": "rejected", "intervention": "undecided", "regency": "selected",
    }, "Selections/rejection did not survive the actual keyboard workflow")
    require(groups["coup"]["rejectionReason"] == REASON, "Multiline rejection reason was not preserved on resize")
    require(groups["regency"]["rationale"] == RATIONALE, "Multiline regency rationale was not preserved on resize")
    require(state["direction"] == DIRECTION, f"Multiline direction/cursor editing changed: {state['direction']!r}")
    require(saved["selection"]["requested"] == ["council", "death", "regency"], "Unexpected selected groups")
    require(saved["selection"]["missing"] == [] and saved["selection"]["diagnostics"] == [], "Unexpected selection diagnostics")
    initial = read(node, directory, 1)
    require(initial["workspace"]["history"] == [] and all(group["decision"] == "undecided" for group in initial["workspace"]["proposals"]), "Historical version 1 was replaced by the latest state")
    require(read(node, directory) == saved, "Historical read changed the latest workspace")

    with Terminal(node, ["workspace", "resume", *args]) as terminal:
        terminal.ready(7)
        terminal.expect("[x] Selected")
        terminal.key(b"4", "SAVED WORKSPACE DECISIONS")
        terminal.key(b"\x1b[6~", "No military seizure")
        terminal.write(b"q")
        terminal.finish(0)
    require(read(node, directory) == saved, "Reopening changed saved selections/history/rejection reason")
    text = plain_output(run(node, ["workspace", "resume", *args, "--plain"]), 7)
    for line in [*REASON.split("\n"), *RATIONALE.split("\n"), *DIRECTION.split("\n")]:
        require(line in text, f"Plain inspection lost authored text {line!r}")
    resumed = json_output(run(node, ["workspace", "resume", *args, "--json"]))
    require(resumed["data"] == saved, "Human command JSON differs from machine workspace.read")
    return f"raw mode restored; cleaned up enabled modes: {', '.join(supported) or 'none advertised'}"


def signal_cleanup(node, directory, signum):
    args = ["--workspace-dir", str(directory)]
    json_output(run(node, ["workspace", "demo", *args, "--json"]))
    before = read(node, directory)
    with Terminal(node, ["workspace", "resume", *args]) as terminal:
        terminal.ready(1)
        terminal.key(b"n", "ADVISORY DIRECTION")
        terminal.paste("Unsaved multiline buffer\nMust not persist after signal.")
        terminal.signal(signum)
        supported = terminal.finish(128 + signum)
    require(read(node, directory) == before, "Signal implicitly saved an unfinished form")
    return f"raw mode restored; cleaned up {', '.join(supported) or 'all enabled modes'}"


def fallbacks(node, directory):
    args = ["--workspace-dir", str(directory)]
    plain_output(run(node, ["workspace", "demo", *args]), 1)  # Non-TTY + NO_COLOR.
    saved = read(node, directory)
    for flags, env in [([], environment(TERM="dumb")), (["--plain"], environment())]:
        with Terminal(node, ["workspace", "resume", *args, *flags], env) as terminal:
            terminal.finish(0, interactive=False)
            plain_output(bytes(terminal.output), 1)
    require(read(node, directory) == saved, "Plain/fallback inspection changed workspace state")
    return "non-TTY/NO_COLOR, real TERM=dumb TTY and explicit --plain are readable and escape-free"


def atlas_workflow(node, directory):
    directory.mkdir()
    source, moved, workspace = directory / "bundle", directory / "moved-source", directory / "workspace"
    fixture = ROOT / "fixtures/authoring/atlas-project.json"
    fixture_before = fixture.read_bytes()
    run(node, ["authoring", "build", str(fixture), "--out", str(source)])
    json_output(run(node, ["workspace", "open", str(source), "--workspace-dir", str(workspace), "--json"]))

    def api(operation, payload):
        request = {"format": "wmm.request/1", "apiVersion": "wmm/1", "requestId": "atlas-pty", "operation": operation, "payload": payload}
        return json_output(run(node, ["json", "--workspace-dir", str(workspace)], json.dumps(request).encode("utf-8")))["data"]

    api("workspace.mutate", {"workspaceId": "main", "expectedVersion": 1, "idempotencyKey": "atlas-proposal", "action": {"kind": "put-proposal", "proposal": {
        "id": "transfer", "title": "Transfer a city (not yet applied)", "author": "Synthetic smoke", "rationale": "An explicit draft, not a control fact.", "dependencies": [], "exclusions": [],
        "operations": [{"kind": "write-prose", "path": "prose/proposed-transfer.md", "text": "A proposed transfer of city control.", "beforeSha256": None}],
    }}})
    api("workspace.mutate", {"workspaceId": "main", "expectedVersion": 2, "idempotencyKey": "atlas-selection", "action": {"kind": "decide", "groupId": "transfer", "decision": "selected"}})
    api("workspace.review", {"workspaceId": "main", "expectedVersion": 3})
    before = api("workspace.read", {"workspaceId": "main"})
    require(before["validation"]["status"] == "current" and "review" in before, "Atlas smoke must start with an associated review")
    original_files = {path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in source.rglob("*") if path.is_file()}
    source.rename(moved)
    map_view = api("workspace.map.read", {"workspaceId": "main"})
    require(map_view["worldBasis"] == "base" and map_view["selectedProposalsIncluded"] is False and map_view["factProjection"] == "not-run" and map_view["candidateView"] == "unavailable", "Atlas mode is not the explicit reference/base subset")
    args = ["--workspace-dir", str(workspace)]
    colour_env = environment(FORCE_COLOR="3", COLORTERM="truecolor")
    colour_env.pop("NO_COLOR", None)
    with Terminal(node, ["workspace", "resume", *args], colour_env) as terminal:
        terminal.ready(3)
        terminal.key(b"2", "BASE WORLD / READ-ONLY")
        terminal.key(b"m", "REFERENCE ATLAS")
        terminal.expect(b"\x1b[48;2;")
        terminal.expect("Selected proposals are not shown.")
        terminal.expect("political facts not projected.")
        terminal.expect("Candidate view unavailable.")
        terminal.key(b"j", "Selected: Tiny Islet")
        terminal.key(ENTER, "Feature: Tiny Islet")
        terminal.expect("Feature id: tiny_islet")
        terminal.expect("Precision: exact-as-authored")
        terminal.expect("Source reference: source:wmm_authoring")
        terminal.key(b"\x1b")
        terminal.key(b"f", "CANVAS:")
        # At the fixed 120x36 viewport, move from the frame center into the
        # overlapping ridge/upland cell while keeping the islet selected.
        for _ in range(13):
            terminal.key(b"h")
        terminal.key(ENTER, "CHOOSE REFERENCE FEATURE")
        terminal.expect("Western Ridge | ridge")
        terminal.expect("Stonehaven Upland | upland")
        terminal.key(DOWN)
        terminal.key(ENTER, "Feature: Stonehaven Upland")
        mark = len(terminal.output)
        terminal.resize(80, 24)
        terminal.expect("Feature: Stonehaven Upland", mark)
        terminal.key(b"\x1b[6~", "Precision: approximate")
        terminal.expect("Source reference: source:wmm_authoring")
        mark = len(terminal.output)
        terminal.resize(120, 36)
        terminal.expect("Geometry reference: reference_demo/reference_v1/upland", mark)
        terminal.key(b"m", "BASE WORLD / READ-ONLY")
        terminal.key(b"1", "Transfer a city (not yet applied)")
        terminal.expect("[x] Selected")
        terminal.write(b"q")
        terminal.finish(0)
    for level, expected in [("2", b"\x1b[48;5;"), ("1", b"\x1b[40m"), (None, None)]:
        fallback_env = environment(FORCE_COLOR=level or "3")
        if level is not None:
            fallback_env.pop("NO_COLOR", None)
        with Terminal(node, ["workspace", "resume", *args], fallback_env) as terminal:
            terminal.ready(3)
            terminal.key(b"2", "BASE WORLD / READ-ONLY")
            mark = len(terminal.output)
            terminal.key(b"m", "REFERENCE ATLAS")
            if expected is not None:
                terminal.expect(expected, mark)
            else:
                require(not re.search(rb"\x1b\[[0-9;]*m", bytes(terminal.output[mark:])), "NO_COLOR allowed colour/style escapes")
            terminal.write(b"q")
            terminal.finish(0)
    require(api("workspace.read", {"workspaceId": "main"}) == before, "Map navigation changed workspace/history/decisions/review association")
    require(api("workspace.map.read", {"workspaceId": "main"}) == map_view, "Captured map read changed after navigation")
    plain = run(node, ["workspace", "map", *args, "--plain"])
    require(plain == run(node, ["workspace", "map", *args, "--plain"]), "Plain atlas is nondeterministic")
    require(b"Tiny Islet" in plain and b"REFERENCE ATLAS" in plain and b"\x1b" not in plain, "Plain atlas lost features or contains terminal controls")
    require(json_output(run(node, ["workspace", "map", *args, "--json"], env=colour_env))["data"] == map_view, "Map CLI JSON differs from the service read")
    require(run(node, ["workspace", "map", *args, "--plain"], env=colour_env) == plain, "Forced colour leaked into plain output")
    require({path.relative_to(moved).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in moved.rglob("*") if path.is_file()} == original_files, "Atlas smoke changed source bundle bytes")
    require(fixture.read_bytes() == fixture_before, "Atlas smoke changed the authored fixture")
    return "true-colour/256/16/NO_COLOR, source loss, tiny island/provenance, mixed-cell chooser, wide/narrow/wide, plain/JSON; decisions/history/current review unchanged"


def atlas_dense_workflow(node, directory):
    directory.mkdir()
    project = json.loads((ROOT / "fixtures/authoring/atlas-project.json").read_text(encoding="utf-8"))
    atlas = project["atlases"][0]
    atlas["features"] = []
    project["entities"] = []
    atlas["physicalCoverage"] = [{"surface": "land", "geometry": {"kind": "polygon", "vertices": [[0, 0], [1200, 0], [1200, 800], [0, 800], [0, 0]]}}]
    for i in range(64):
        x, y = i % 8 * 150 + 10, i // 8 * 100 + 10
        entity_id = f"place:region_{i}"
        project["entities"].append({"id": entity_id, "name": f"Region {i}", "sections": []})
        atlas["features"].append({"id": f"region_{i}", "entityId": entity_id, "label": f"Region {i}",
            "geometry": {"kind": "polygon", "vertices": [[x, y], [x + 100, y], [x + 100, y + 60], [x, y + 60], [x, y]]},
            "anchor": [x + 50, y + 30], "precision": "approximate", "locator": "Synthetic dense terminal smoke only."})
    input_path, source, workspace = directory / "project.json", directory / "bundle", directory / "workspace"
    input_path.write_text(json.dumps(project), encoding="utf-8")
    run(node, ["authoring", "build", str(input_path), "--out", str(source)])
    initial = json_output(run(node, ["workspace", "open", str(source), "--workspace-dir", str(workspace), "--json"]))["data"]
    env = environment(FORCE_COLOR="3", COLORTERM="truecolor")
    env.pop("NO_COLOR", None)
    with Terminal(node, ["workspace", "resume", "--workspace-dir", str(workspace)], env) as terminal:
        terminal.resize(240, 80)
        terminal.ready(1)
        terminal.key(b"2", "BASE WORLD / READ-ONLY")
        terminal.key(b"m", "REFERENCE ATLAS")
        terminal.expect(b"\x1b[48;2;")
        terminal.expect("Selected: Region 0")
        terminal.key(b"j", "Selected: Region 1")
        mark = len(terminal.output)
        terminal.resize(80, 24)
        terminal.expect("Selected: Region 1", mark)
        mark = len(terminal.output)
        terminal.resize(240, 80)
        terminal.expect("Selected: Region 1", mark)
        terminal.key(ENTER, "Feature: Region 1")
        terminal.expect("Entity reference: place:region_1")
        terminal.key(b"m", "BASE WORLD / READ-ONLY")
        terminal.write(b"q")
        terminal.finish(0)
    require(json_output(run(node, ["workspace", "resume", "--workspace-dir", str(workspace), "--json"]))["data"] == initial, "Dense atlas navigation changed saved state")
    return "64 admitted regions; true-colour 160x60 canvas at 240x80; narrow/wide resize and selection/provenance preserved; workspace unchanged"


def fixture_hashes():
    return {path.relative_to(DEMO).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in DEMO.rglob("*") if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"), help="Node executable (default: node on PATH)")
    options = parser.parse_args()
    require(sys.platform == "darwin" or sys.platform.startswith("linux"), "PTY smoke supports macOS and Linux")
    require(options.node is not None, "Node is not on PATH")
    require(MAIN.is_file(), "Missing apps/cli/dist/main.js; this smoke requires the parent-provided build")
    snapshot = json.loads((DEMO / "snapshot.json").read_text(encoding="utf-8"))
    require(len(snapshot["manifest"]["files"]) == 47, "Succession fixture must have 47 admitted payload files")
    require(sum(path.is_file() for path in (DEMO / "payload").rglob("*")) == 47, "Succession payload file count differs from its manifest")
    before = fixture_hashes()
    failures = []
    with tempfile.TemporaryDirectory(prefix="wmm-workspace-pty-") as root:
        cases = [
            ("interactive review, resize, normal quit and durable reopen", lambda: workflow(options.node, Path(root) / "review")),
            ("SIGTERM cleanup", lambda: signal_cleanup(options.node, Path(root) / "sigterm", signal.SIGTERM)),
            ("SIGINT cleanup", lambda: signal_cleanup(options.node, Path(root) / "sigint", signal.SIGINT)),
            ("plain inspection and terminal fallbacks", lambda: fallbacks(options.node, Path(root) / "fallback")),
            ("read-only captured reference atlas", lambda: atlas_workflow(options.node, Path(root) / "atlas")),
            ("dense colour atlas at large terminal size", lambda: atlas_dense_workflow(options.node, Path(root) / "atlas-dense")),
        ]
        for name, check in cases:
            try:
                detail = check()
                print(f"PASS {name}: {detail}", flush=True)
            except (AssertionError, OSError, termios.error, ValueError, KeyError, subprocess.SubprocessError) as error:
                failures.append(name)
                print(f"FAIL {name}: {error}", file=sys.stderr, flush=True)
    require(fixture_hashes() == before, "Smoke changed the source world fixture")
    require(not failures, f"Workspace smoke failed: {', '.join(failures)}")
    print("Workspace terminal smoke passed (stdlib PTY, existing build, source fixture unchanged).")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, termios.error, subprocess.SubprocessError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
