"""Offline adapter tests; injected backends are NOT model/provider results."""
from __future__ import annotations

import ast
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ADAPTER_PATH = Path(__file__).with_name("hermes_adapter.py")


def load_adapter():
    spec = importlib.util.spec_from_file_location("wmm_hermes_adapter", ADAPTER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


TOOL_NAMES = ["wmm_project_read", "wmm_source_read", "wmm_authoring_schema", "wmm_proposal_check", "wmm_proposal_submit"]
ISOLATION = {"contextFiles": False, "memory": False, "skills": False, "soul": False,
             "externalTools": False, "contextEngine": "builtin"}


def initialize():
    return {"type": "initialize", "tools": [
        {"name": name, "description": "Synthetic host schema", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}
        for name in TOOL_NAMES
    ], "maxIterations": 12, "maxTokens": 8192, "maxSeconds": 240}


def frames(*values):
    return b"".join(json.dumps(value).encode("utf-8") + b"\n" for value in values)


class OfflineBackend:
    """Only the network boundary is injected; never represented as real inference."""
    model = "offline-test"
    provider = "offline-test"
    session_id = "offline-session"

    def __init__(self, config, bridge, **options):
        self.config, self.bridge, self.options = config, bridge, options
        self.runs = []
        self.closed = False

    def run(self, message, task_id):
        self.runs.append((message, task_id))
        return {"completed": True, "final_response": "Offline fixture, not model output", "messages": []}

    def close(self):
        self.closed = True


def isolated_fake_sdk(config=None):
    """Constructor boundary double. A separate opt-in test exercises installed Hermes."""
    entries, agents, databases, resolutions = {}, [], [], []

    class Registry:
        def get_entry(self, name):
            return entries.get(name)

        def register(self, **kwargs):
            entries[kwargs["name"]] = SimpleNamespace(**kwargs)

        def deregister(self, name):
            entries.pop(name, None)

    class Compressor:
        pass

    class Database:
        def __init__(self, db_path, read_only=False):
            self.db_path, self.read_only, self.closed = db_path, read_only, False
            databases.append(self)

        def close(self):
            self.closed = True

    class Agent:
        def __init__(self, **kwargs):
            agents.append(self)
            self.kwargs = kwargs
            self.__dict__.update(kwargs)
            self.session_id = "offline-session"
            self._session_db = kwargs["session_db"]
            self.context_compressor = Compressor()
            self._memory_enabled = self._user_profile_enabled = False
            self._memory_store = self._memory_manager = None
            self._context_engine_tool_names = set()
            self._fallback_chain = []
            self._auto_load_skills_result = ("", [], [])
            self._auto_load_skills_resolved = False
            self._session_messages = []
            self._cached_system_prompt = self._cached_system_prompt_static = None
            self.tools = [{"type": "function", "function": entry.schema} for entry in entries.values()]
            self.valid_tool_names = set(entries)
            self.closed = False
            self.conversations = []
            self.interrupts = []

        def _build_system_prompt(self, system_message=None):
            return "ambient-prompt-canary"

        def run_conversation(self, message, **kwargs):
            self.conversations.append((message, kwargs))
            return {"completed": True, "final_response": "Offline boundary fixture, not model output", "messages": []}

        def interrupt(self, **kwargs):
            self.interrupts.append(kwargs)
            return True

        def close(self):
            self.closed = True

    def resolve(**kwargs):
        resolutions.append(kwargs)
        return {"provider": "custom", "model": "offline-model", "api_mode": "chat_completions",
                "base_url": "http://127.0.0.1:1/v1", "api_key": "offline-no-credential",
                "request_overrides": {"tools": ["terminal"], "messages": ["prefill-canary"]}}

    sdk = SimpleNamespace(agent_class=Agent, registry=Registry(), db_class=Database,
                          compressor_class=Compressor, normalize_tools=lambda tools: tools, read_config=lambda: config if config is not None else {
                              "model": {"default": "offline-model"}, "context": {"engine": "compressor"}},
                          resolve_runtime=resolve)
    return sdk, entries, agents, databases, resolutions


class SdkBoundaryTests(unittest.TestCase):
    def test_terminal_bridge_failure_requests_existing_sdk_hard_interrupt(self):
        adapter = load_adapter()
        sdk, _, _, _, _ = isolated_fake_sdk()
        bridge = adapter.ToolBridge(io.BytesIO(), io.BytesIO())
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                backend = adapter.HermesBackend(initialize(), bridge, _sdk=sdk)
            try:
                bridge.activate()
                with self.assertRaises(adapter.AdapterError):
                    bridge.call("terminal", {})
                self.assertEqual(backend.agent.interrupts, [{"hard_cancel": True, "tool_reason": "wmm_harness_protocol_failure"}])
            finally:
                backend.close()

    def test_existing_tool_registration_is_not_shadowed_or_removed(self):
        adapter = load_adapter()
        sdk, entries, agents, databases, _ = isolated_fake_sdk()
        original = SimpleNamespace(name=TOOL_NAMES[0], toolset="other-owner", schema={}, handler=object())
        entries[TOOL_NAMES[0]] = original
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                with self.assertRaisesRegex(adapter.AdapterError, "TOOL_REGISTRY_COLLISION"):
                    adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
            self.assertIs(entries[TOOL_NAMES[0]], original)
            self.assertEqual((agents, databases), ([], []))

    def test_partial_sdk_constructor_failure_still_closes_agent_and_dedicated_database(self):
        adapter = load_adapter()
        sdk, entries, agents, databases, _ = isolated_fake_sdk()
        original = sdk.agent_class

        class FailingAgent(original):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                raise RuntimeError("synthetic constructor failure")

        sdk.agent_class = FailingAgent
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                with self.assertRaisesRegex(RuntimeError, "synthetic constructor failure"):
                    adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
            self.assertTrue(agents[0].closed)
            self.assertTrue(databases[0].closed)
            self.assertEqual(entries, {})

    def test_run_uses_existing_sdk_conversation_once_without_inline_moa_dispatch(self):
        adapter = load_adapter()
        sdk, _, _, _, _ = isolated_fake_sdk()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                backend = adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
            try:
                self.assertTrue(callable(getattr(backend, "run", None)), "SDK conversation forwarding is not implemented")
                result = backend.run("Synthetic selected task", "run-attempt")
                self.assertTrue(result["completed"])
                self.assertEqual(backend.agent.conversations, [("Synthetic selected task", {"task_id": "run-attempt", "moa_config": {}})])
            finally:
                backend.close()

    def test_nonempty_runtime_directory_is_rejected_without_overwriting(self):
        adapter = load_adapter()
        sdk, entries, agents, databases, _ = isolated_fake_sdk()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            sentinel = Path(runtime) / "session.sqlite"
            sentinel.write_bytes(b"existing artifact must remain unchanged")
            with mock.patch("os.getcwd", return_value=runtime):
                with self.assertRaisesRegex(adapter.AdapterError, "UNSAFE_RUNTIME_DIRECTORY"):
                    adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
            self.assertEqual(sentinel.read_bytes(), b"existing artifact must remain unchanged")
            self.assertEqual((entries, agents, databases), ({}, [], []))

    def test_unreviewed_sdk_sources_fail_closed(self):
        adapter = load_adapter()
        self.assertTrue(hasattr(adapter, "verify_sdk_sources"), "SDK source compatibility gate is not implemented")
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as root:
            with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_SDK"):
                adapter.verify_sdk_sources(Path(root))

    def test_external_or_unknown_runtime_transports_are_rejected_before_constructor(self):
        adapter = load_adapter()
        for changed in ({"api_mode": "acp"}, {"api_mode": "codex_app_server"}, {"api_mode": "plugin_mode"},
                        {"provider": "moa"}, {"base_url": "acp://local"}, {"acp_command": "external-binary"}):
            with self.subTest(changed=changed):
                sdk, entries, agents, databases, _ = isolated_fake_sdk()
                resolver = sdk.resolve_runtime
                sdk.resolve_runtime = lambda **kw: {**resolver(**kw), **changed}
                with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_RUNTIME"):
                    adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
                self.assertEqual((entries, agents, databases), ({}, [], []))

    def test_prompt_hook_is_fixed_without_ambient_hints_and_request_dumps_are_disabled(self):
        adapter = load_adapter()
        sdk, _, _, databases, _ = isolated_fake_sdk()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                backend = adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
            try:
                prompt = backend.agent._build_system_prompt()
                self.assertNotIn("ambient-prompt-canary", prompt)
                self.assertEqual(prompt, adapter.SYSTEM_PROMPT)
                self.assertEqual(backend.agent._cached_system_prompt, adapter.SYSTEM_PROMPT)
                for name in TOOL_NAMES:
                    self.assertIn(name, prompt)
                with self.assertRaisesRegex(adapter.AdapterError, "ISOLATION_CHECK_FAILED"):
                    backend.agent._build_system_prompt("ambient system_message")
                self.assertIsNone(backend.agent._dump_api_request_debug({"selected": "canary"}, reason="test"))
                self.assertEqual(databases[0].db_path.name, "session.sqlite")
            finally:
                backend.close()

    def test_constructed_sdk_isolation_is_checked_not_claimed_from_requested_flags(self):
        adapter = load_adapter()
        mutations = [("valid_tool_names", set(TOOL_NAMES) | {"terminal"}), ("tools", []),
                     ("prefill_messages", [{"role": "user", "content": "canary"}]),
                     ("request_overrides", {"messages": ["canary"]}), ("_memory_store", object()),
                     ("_memory_manager", object()), ("_memory_enabled", True), ("_user_profile_enabled", True),
                     ("_session_messages", [{"content": "canary"}]), ("skip_context_files", False),
                     ("load_soul_identity", True), ("skip_background_review", False),
                     ("_context_engine_tool_names", {"canary"}), ("_fallback_chain", [{"model": "canary"}]),
                     ("_auto_load_skills_result", ("canary", [], [])), ("ephemeral_system_prompt", "canary")]
        for attribute, value in mutations + [("context_compressor", None)]:
            with self.subTest(attribute=attribute):
                sdk, entries, agents, databases, _ = isolated_fake_sdk()
                original = sdk.agent_class

                class ChangedAgent(original):
                    def __init__(self, **kwargs):
                        super().__init__(**kwargs)
                        setattr(self, attribute, value)

                sdk.agent_class = ChangedAgent
                with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
                    with mock.patch("os.getcwd", return_value=runtime):
                        with self.assertRaisesRegex(adapter.AdapterError, "ISOLATION_CHECK_FAILED"):
                            adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
                    self.assertTrue(agents[0].closed)
                    self.assertTrue(databases[0].closed)
                    self.assertEqual(entries, {})

    def test_configured_custom_context_engine_fails_before_resolver_or_agent(self):
        adapter = load_adapter()
        sdk, entries, agents, databases, resolutions = isolated_fake_sdk({
            "model": {"default": "offline-model"}, "context": {"engine": "canary-engine"}})
        with self.assertRaisesRegex(adapter.AdapterError, "UNSUPPORTED_CONTEXT_ENGINE"):
            adapter.HermesBackend(initialize(), adapter.ToolBridge(io.BytesIO(), io.BytesIO()), _sdk=sdk)
        self.assertEqual((entries, agents, databases, resolutions), ({}, [], [], []))

    def test_constructs_custom_only_sdk_via_normal_resolver_without_request_overrides(self):
        adapter = load_adapter()
        self.assertTrue(hasattr(adapter, "HermesBackend"), "thin SDK constructor is not implemented")
        sdk, entries, agents, databases, resolutions = isolated_fake_sdk()
        bridge = adapter.ToolBridge(io.BytesIO(), io.BytesIO())
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
            with mock.patch("os.getcwd", return_value=runtime):
                backend = adapter.HermesBackend(initialize(), bridge, model="selected-model", provider="selected-provider", _sdk=sdk)
            self.assertEqual(resolutions, [{"requested": "selected-provider", "target_model": "selected-model"}])
            self.assertEqual(set(entries), set(TOOL_NAMES))
            agent = agents[0]
            self.assertEqual(agent.valid_tool_names, set(TOOL_NAMES))
            self.assertEqual(agent.enabled_toolsets, [backend.toolset])
            self.assertEqual({entry.toolset for entry in entries.values()}, {backend.toolset})
            self.assertTrue(agent.skip_context_files)
            self.assertFalse(agent.load_soul_identity)
            self.assertTrue(agent.kwargs["skip_memory"])
            self.assertTrue(agent.skip_background_review)
            self.assertEqual(agent.prefill_messages, [])
            self.assertEqual(agent.kwargs["fallback_model"], {})
            self.assertEqual(agent.request_overrides, {})
            self.assertEqual(agent.cwd, runtime)
            self.assertEqual(databases[0].db_path.parent, Path(runtime))
            self.assertIs(agent._session_db, databases[0])
            self.assertFalse(agent.save_trajectories)
            self.assertTrue(agent.quiet_mode)
            self.assertFalse(agent.verbose_logging)
            self.assertEqual(agent.max_iterations, 12)
            self.assertEqual(agent.max_tokens, 8192)
            self.assertEqual(agent.run_budget_seconds, 240)
            backend.close()
            self.assertTrue(agent.closed)
            self.assertTrue(databases[0].closed)
            self.assertEqual(entries, {})


@unittest.skipUnless(os.environ.get("WMM_HARNESS_INSTALLED_SDK") == "1", "run with installed hermes launcher to check SDK")
class InstalledSdkTests(unittest.TestCase):
    def _assert_native_terminal_io_failures(self, adapter, sdk, runtime):
        # Only the channel fails. Registry, constructor, session DB and interrupt
        # state are native; the completion below is explicitly NOT model output.
        class FailedChannel(io.BytesIO):
            def __init__(self, operation, closed):
                super().__init__()
                self.operation, self.closed_fixture = operation, closed
                self.operations = []
                if closed and operation != "flush":
                    self.close()

            def readline(self, size: int | None = -1):
                self.operations.append("read")
                if self.operation == "read" and not self.closed_fixture:
                    raise OSError("secret-canary-terminal-read")
                return super().readline(size)

            def write(self, raw):
                self.operations.append("write")
                if self.operation == "write" and not self.closed_fixture:
                    raise BrokenPipeError("secret-canary-terminal-write")
                written = super().write(raw)
                if self.operation == "flush" and self.closed_fixture:
                    self.close()
                return written

            def flush(self):
                self.operations.append("flush")
                if self.operation == "flush" and not self.closed_fixture:
                    raise BrokenPipeError("secret-canary-terminal-flush")
                return super().flush()

        old_cwd = os.getcwd()
        try:
            for operation in ("read", "write", "flush"):
                for closed in (False, True):
                    with self.subTest(operation=operation, closed_stream=closed):
                        attempt = runtime / (operation + ("-closed" if closed else "-oserror"))
                        attempt.mkdir()
                        os.chdir(attempt)
                        output, observed = io.BytesIO(), {}
                        channel = FailedChannel(operation, closed)

                        def factory(config, bridge, **options):
                            backend = adapter.HermesBackend(config, bridge, _sdk=sdk)
                            agent = backend.agent
                            observed["agent"] = agent

                            def dispatch_without_inference(message, task_id):
                                reader, writer = bridge.reader, bridge.writer
                                if operation == "read":
                                    bridge.reader = channel
                                else:
                                    bridge.writer = channel
                                try:
                                    observed["first_result"] = sdk.registry.dispatch(TOOL_NAMES[0], {})
                                    observed["failure"] = bridge.failure
                                    observed["hard_interrupt"] = agent._hard_interrupt_requested.is_set()
                                finally:
                                    bridge.reader, bridge.writer = reader, writer
                                observed["io_after_failure"] = list(channel.operations)
                                observed["later_result"] = sdk.registry.dispatch(TOOL_NAMES[0], {})
                                observed["sequence"] = bridge.sequence
                                try:
                                    bridge.finish()
                                    observed["finish_succeeded"] = True
                                except adapter.AdapterError:
                                    observed["finish_succeeded"] = False
                                return {"completed": True, "final_response": "Synthetic IPC fixture, not model output", "messages": []}

                            backend.run = dispatch_without_inference
                            return backend

                        payload = frames(initialize(), {"type": "start", "userMessage": "Synthetic IPC task", "taskId": "ipc-test"})
                        result = adapter.run_adapter(io.BytesIO(payload), output, backend_factory=factory)
                        self.assertEqual(observed["io_after_failure"], ["write", "flush"] if operation == "flush" else [operation])
                        self.assertIsInstance(observed["failure"], adapter.AdapterError, "native registry swallowed terminal I/O without latching")
                        self.assertEqual(observed["failure"].code, "TOOL_CHANNEL_IO")
                        self.assertTrue(observed["hard_interrupt"])
                        self.assertFalse(observed["finish_succeeded"])
                        self.assertEqual(observed["sequence"], 1, "failed bridge sent a later tool call")
                        self.assertEqual(channel.operations, observed["io_after_failure"])
                        self.assertIn("AdapterError: TOOL_CHANNEL_IO", observed["first_result"])
                        self.assertEqual(observed["later_result"], observed["first_result"])
                        self.assertNotIn("secret-canary", observed["first_result"])
                        self.assertEqual(result, 1)
                        emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                        expected = [{"type": "ready", "tools": TOOL_NAMES, "isolation": ISOLATION,
                                     "runtime": {"adapter": "hermes-sdk", "model": observed["agent"].model,
                                                 "provider": observed["agent"].provider}}]
                        if operation == "read":  # The first call was sent before its reply channel failed.
                            expected.append({"type": "tool_call", "id": 1, "name": TOOL_NAMES[0], "arguments": {}})
                        expected.append({"type": "error", "code": "RUNTIME_ERROR"})
                        self.assertEqual(emitted, expected)
                        self.assertEqual({path.name for path in attempt.iterdir()}, {"session.sqlite"})
        finally:
            os.chdir(old_cwd)

    def test_actual_sdk_construction_and_wire_context_exclude_ambient_canaries_without_network(self):
        import socket
        adapter = load_adapter()
        self.assertTrue(hasattr(adapter, "load_sdk"), "installed SDK loader is not implemented")
        canary = "WMM_AMBIENT_CANARY_NEVER_DISCLOSE_7d42"
        old_cwd = os.getcwd()
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as temporary:
            root = Path(temporary)
            home, project = root / "home", root / "project"
            runtime = project / "runtime"
            (home / "memories").mkdir(parents=True)
            (home / "skills" / "ambient-canary").mkdir(parents=True)
            runtime.mkdir(parents=True)
            for path in (home / "memories/MEMORY.md", home / "memories/USER.md",
                         project / "AGENTS.md", project / "CLAUDE.md", project / ".hermes.md"):
                path.write_text(canary, encoding="utf-8")
            # Public installed template, never a real profile's identity. A cold
            # config load normally upgrades this recognized legacy seed in place.
            sdk_spec = importlib.util.find_spec("run_agent")
            assert sdk_spec is not None and sdk_spec.origin is not None
            soul_source = Path(sdk_spec.origin).parent / "hermes_cli/default_soul.py"
            soul_tree = ast.parse(soul_source.read_bytes())
            scaffold = {node.targets[0].id: ast.literal_eval(node.value) for node in soul_tree.body
                        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id in {"_SCAFFOLD_HEAD", "_SCAFFOLD_TAIL"}}
            soul_bytes = (scaffold["_SCAFFOLD_HEAD"] + scaffold["_SCAFFOLD_TAIL"]).encode("utf-8")
            (home / "SOUL.md").write_bytes(soul_bytes)
            (home / "skills/ambient-canary/SKILL.md").write_text(
                "---\nname: ambient-canary\ndescription: " + canary + "\n---\n" + canary, encoding="utf-8")
            (home / "prefill.json").write_text(json.dumps([{"role": "user", "content": canary}]), encoding="utf-8")
            # Real filesystem and importlib.metadata discovery, not an SDK double.
            # Neither home plugin is selected; even enabled pip providers are ambient.
            markers = [home / (name + ".loaded") for name in ("user-provider", "flat-provider", "pip-provider")]
            for plugin, marker in zip((home / "plugins/model-providers/unselected-canary",
                                       home / "plugins/unselected-flat-canary"), markers):
                plugin.mkdir(parents=True)
                (plugin / "__init__.py").write_text(
                    "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('synthetic import marker')\n", encoding="utf-8")
                (plugin / "plugin.yaml").write_text("name: unselected-canary\nkind: model-provider\n", encoding="utf-8")
            packages = root / "synthetic-packages"
            distribution = packages / "wmm_provider_canary-0.0.0.dist-info"
            distribution.mkdir(parents=True)
            (distribution / "METADATA").write_text("Metadata-Version: 2.1\nName: wmm-provider-canary\nVersion: 0.0.0\n", encoding="utf-8")
            (distribution / "entry_points.txt").write_text(
                "[hermes_agent.plugins]\nwmm-pip-provider-canary = wmm_pip_provider_canary\n", encoding="utf-8")
            (packages / "wmm_pip_provider_canary.py").write_text(
                "from pathlib import Path\nPath(" + repr(str(markers[2])) + ").write_text('synthetic import marker')\n", encoding="utf-8")
            (home / "config.yaml").write_text(json.dumps({
                "model": {"default": "gpt-4.1", "provider": "custom", "api_key": "offline-no-credential",
                          "base_url": "http://127.0.0.1:1/v1", "api_mode": "chat_completions", "context_length": 128000},
                "context": {"engine": "compressor"}, "skills": {"auto_load": ["ambient-canary"]},
                "plugins": {"enabled": ["wmm-pip-provider-canary"], "isolation": "in_process"},
                "toolsets": ["homeassistant"], "security": {"allow_lazy_installs": False},
                "memory": {"provider": "canary-unavailable", "memory_enabled": True, "user_profile_enabled": True},
                "prefill_messages": [{"role": "user", "content": canary}],
                "agent": {"environment_probe": False, "environment_hint": canary},
                "platform_hints": {"cli": {"append": canary}},
            }), encoding="utf-8")
            config_bytes = (home / "config.yaml").read_bytes()

            def outside_attempt():
                return {str(path.relative_to(root)): (path.is_file(), path.read_bytes() if path.is_file() else None)
                        for path in root.rglob("*") if not path.is_relative_to(runtime)}

            wire = io.BytesIO(frames({"type": "tool_result", "id": 1, "result": {"text": "\ufeffSynthetic selected text"}}))
            bridge = adapter.ToolBridge(wire, io.BytesIO())
            backend = None
            try:
                os.chdir(runtime)
                with mock.patch.dict(os.environ, {"HERMES_HOME": str(home), "HERMES_SAFE_MODE": "1",
                                                   "HERMES_ENVIRONMENT_HINT": canary, "TERMINAL_CWD": str(project),
                                                   "HERMES_PREFILL_MESSAGES_FILE": str(home / "prefill.json")}):
                    with mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")) as connect:
                        with mock.patch.object(socket.socket, "connect_ex", side_effect=AssertionError("network forbidden")) as connect_ex:
                            with mock.patch.object(socket, "getaddrinfo", side_effect=AssertionError("DNS forbidden")) as dns:
                                # Offline constructor test has no credentials to load. Do not read the
                                # install tree's project .env as run_agent normally does on import.
                                with mock.patch("hermes_cli.env_loader.load_hermes_dotenv", return_value=[]), mock.patch.object(sys, "path", [str(packages), *sys.path]):
                                    from importlib.metadata import entry_points
                                    self.assertIn("wmm-pip-provider-canary", {ep.name for ep in entry_points(group="hermes_agent.plugins")})
                                    self.assertNotIn("hermes_cli.config", sys.modules, "regression requires the first cold config import")
                                    preexisting_before_load = outside_attempt()
                                    sdk = adapter.load_sdk()
                                    self.assertEqual((home / "SOUL.md").read_bytes(), soul_bytes, "cold config loading rewrote existing profile SOUL.md")
                                    after_load = outside_attempt()
                                    self.assertEqual(sorted(name for name in preexisting_before_load
                                                            if after_load.get(name) != preexisting_before_load[name]), [],
                                                     "cold SDK loading changed preexisting profile artifacts")
                                    # Permit ordinary NEW native caches/backups, not changes to
                                    # preexisting files. Warm only the DB schema cache before the
                                    # stricter constructor/run no-new-artifacts snapshot below.
                                    fixture_db = sdk.db_class(db_path=root / "fixture.sqlite", read_only=False)
                                    fixture_db.close()
                                    self.assertEqual((home / "config.yaml").read_bytes(), config_bytes)
                                    outside_before = outside_attempt()
                                    backend = adapter.HermesBackend(initialize(), bridge, _sdk=sdk)
                                self.assertEqual([marker.name for marker in markers if marker.exists()], [], "ambient model-provider modules executed")
                                self.assertEqual((home / "config.yaml").read_bytes(), config_bytes, "constructor migrated profile config")
                                import providers
                                from agent.safe_worker_policy import safe_worker_enabled, worker_config_snapshot
                                self.assertFalse(safe_worker_enabled())
                                self.assertIsNone(worker_config_snapshot())
                                custom = providers.get_provider_profile("custom")
                                self.assertIsNotNone(custom)
                                self.assertEqual(getattr(custom, "name", None), "custom")
                                self.assertEqual(backend.agent.provider, "custom")
                                self.assertIsInstance(backend.agent, sdk.agent_class)
                                self.assertIs(type(backend.agent.context_compressor), sdk.compressor_class)
                                backend.verify_isolation()
                                self.assertEqual(backend.agent.valid_tool_names, set(TOOL_NAMES))
                                self.assertEqual(backend.agent._cached_system_prompt, adapter.SYSTEM_PROMPT)
                                from agent.turn_context import build_api_messages
                                backend.agent._current_turn_timestamp = 0.0
                                messages, system = build_api_messages(
                                    backend.agent, [{"role": "user", "content": "Synthetic selected task"}],
                                    current_turn_user_idx=0, ext_prefetch_cache="", plugin_user_context="",
                                    moa_config={}, active_system_prompt=backend.agent._cached_system_prompt)
                                self.assertEqual(system, adapter.SYSTEM_PROMPT)
                                self.assertEqual(messages[-1]["content"], "Synthetic selected task")
                                self.assertNotIn(canary, json.dumps([messages, backend.agent.tools, backend.agent.prefill_messages]))
                                # Exercise the FULL native turn prologue and request assembly;
                                # stop at the provider boundary before any inference or I/O.
                                class FirstWireCaptured(BaseException):
                                    pass

                                captured = []

                                def stop_before_provider(api_kwargs, *args, **kwargs):
                                    captured.append(api_kwargs)
                                    raise FirstWireCaptured()

                                with mock.patch.object(backend.agent, "_interruptible_streaming_api_call", side_effect=stop_before_provider), mock.patch.object(
                                        backend.agent, "_interruptible_api_call", side_effect=stop_before_provider):
                                    with self.assertRaises(FirstWireCaptured):
                                        backend.run("Synthetic selected task", "native-first-wire")
                                self.assertEqual(len(captured), 1)
                                self.assertEqual(captured[0]["messages"][0]["content"], adapter.SYSTEM_PROMPT)
                                self.assertEqual(captured[0]["messages"][-1]["content"], "Synthetic selected task")
                                self.assertEqual(captured[0]["tools"], backend.agent.tools)
                                self.assertNotIn(canary, json.dumps(captured[0]))
                                from agent import tool_executor
                                from tools.tool_result_storage import maybe_persist_tool_result, enforce_turn_budget
                                budget = tool_executor._budget_for_agent(backend.agent)
                                self.assertEqual(budget.default_result_size, 512 * 1024)
                                self.assertEqual(budget.turn_budget, 2 * 1024 * 1024)
                                large_result = "Synthetic source: " + "x" * (450 * 1024)
                                self.assertEqual(maybe_persist_tool_result(content=large_result, tool_name=TOOL_NAMES[0],
                                                                        tool_use_id="offline", env=None, config=budget), large_result)
                                batch = [{"role": "tool", "name": name, "content": large_result} for name in TOOL_NAMES[:2]]
                                enforce_turn_budget(batch, env=None, config=budget)
                                self.assertEqual([message["content"] for message in batch], [large_result, large_result])
                                bridge.activate()
                                tool_result = sdk.registry.dispatch(TOOL_NAMES[0], {})
                                self.assertEqual(json.loads(tool_result), {"text": "\ufeffSynthetic selected text"})
                                bridge.finish()
                                database = backend.db
                                backend.close()
                                backend = None
                                self.assertIsNone(database._conn)
                                self.assertFalse(connect.called)
                                self.assertFalse(connect_ex.called)
                                # SDK local-model metadata probing tries the explicit dummy
                                # loopback endpoint. DNS/connect are blocked before ANY I/O;
                                # this test is no-network, not a claim of zero probe attempts.
                                self.assertTrue(all(call.args[0] in {"127.0.0.1", "localhost", "::1"} for call in dns.call_args_list))
                                self.assertEqual({path.name for path in runtime.iterdir()}, {"session.sqlite"})
                                self.assertEqual([p.name for p in home.rglob("*") if p.name.endswith(".log") or p.name.startswith("request_dump_")], [])
                                outside_after = outside_attempt()
                                self.assertEqual(sorted(name for name in set(outside_after) | set(outside_before)
                                                        if outside_after.get(name) != outside_before.get(name)), [],
                                                 "SDK changed artifacts outside its dedicated attempt")
                                self._assert_native_terminal_io_failures(adapter, sdk, runtime)
                                self.assertEqual(outside_attempt(), outside_before)
            finally:
                if backend is not None:
                    backend.close()
                os.chdir(old_cwd)


class ProtocolTests(unittest.TestCase):
    def test_terminal_channel_normalization_preserves_baseexception_cancellation(self):
        adapter = load_adapter()

        class Cancelled(BaseException):
            pass

        for operation in ("readline", "write", "flush"):
            with self.subTest(operation=operation):
                reader, writer, failures = io.BytesIO(), io.BytesIO(), []
                bridge = adapter.ToolBridge(reader, writer)
                bridge.on_failure = lambda: failures.append(True)
                bridge.activate()
                cancellation = Cancelled("synthetic cancellation")
                stream = reader if operation == "readline" else writer
                with mock.patch.object(stream, operation, side_effect=cancellation):
                    with self.assertRaises(Cancelled) as caught:
                        bridge.call(TOOL_NAMES[0], {})
                self.assertIs(caught.exception, cancellation)
                self.assertIsNone(bridge.failure)
                self.assertEqual(failures, [])

    def test_wire_errors_use_parent_static_allowlist(self):
        adapter = load_adapter()
        output = io.BytesIO()
        adapter.run_adapter(io.BytesIO(frames({"type": "start"})), output, backend_factory=OfflineBackend)
        self.assertEqual(json.loads(output.getvalue()), {"type": "error", "code": "PROTOCOL_ERROR"})

    def test_executable_has_protocol_only_stdout_and_closed_flags_without_sdk_import(self):
        for arguments, code in (([], "PROTOCOL_ERROR"), (["--unknown-secret-canary"], "PROTOCOL_ERROR"),
                                (["--model"], "PROTOCOL_ERROR"), (["--model", "a", "--model", "b"], "PROTOCOL_ERROR")):
            with self.subTest(arguments=arguments):
                with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as runtime:
                    result = subprocess.run([sys.executable, "-B", str(ADAPTER_PATH), *arguments], cwd=runtime,
                                            input=frames({"type": "start", "userMessage": "withheld", "taskId": "task"}),
                                            capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, b"")
                self.assertEqual(json.loads(result.stdout), {"type": "error", "code": code})
                self.assertNotIn(b"secret-canary", result.stdout)

    def test_tool_body_budget_excludes_protocol_envelope_at_512_kib_boundary(self):
        adapter = load_adapter()
        exact = "x" * (512 * 1024 - 2)  # JSON string quotes are part of the body budget.
        for body, expected_code in ((exact, None), (exact + "x", "BUDGET_EXCEEDED")):
            with self.subTest(over_budget=expected_code is not None):
                output = io.BytesIO()
                values = []

                class BoundaryBackend(OfflineBackend):
                    def run(self, message, task_id):
                        values.append(self.bridge.call(TOOL_NAMES[0], {}))
                        return super().run(message, task_id)

                payload = frames(initialize(), {"type": "start", "userMessage": "synthetic", "taskId": "task"},
                                 {"type": "tool_result", "id": 1, "result": body})
                result = adapter.run_adapter(io.BytesIO(payload), output, backend_factory=BoundaryBackend)
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                if expected_code is None:
                    self.assertEqual(result, 0)
                    self.assertEqual(json.loads(values[0]), exact)
                else:
                    self.assertEqual(result, 1)
                    self.assertEqual(emitted[-1], {"type": "error", "code": expected_code})

    def test_runtime_chatter_and_exception_details_never_escape(self):
        adapter = load_adapter()
        for failure in ("construct", "run", "close"):
            with self.subTest(failure=failure):
                output, stdout, stderr = io.BytesIO(), io.StringIO(), io.StringIO()
                closed = []

                class NoisyBackend(OfflineBackend):
                    def __init__(self, *args, **kwargs):
                        print("secret-canary-stdout")
                        print("secret-canary-stderr", file=sys.stderr)
                        if failure == "construct":
                            raise RuntimeError("secret-canary-construct")
                        super().__init__(*args, **kwargs)

                    def run(self, message, task_id):
                        if failure == "run":
                            raise RuntimeError("secret-canary-run")
                        return super().run(message, task_id)

                    def close(self):
                        closed.append(True)
                        super().close()
                        if failure == "close":
                            raise RuntimeError("secret-canary-close")

                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    result = adapter.run_adapter(io.BytesIO(frames(initialize(), {
                        "type": "start", "userMessage": "synthetic", "taskId": "task"
                    })), output, backend_factory=NoisyBackend)
                self.assertEqual(result, 1)
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "")
                self.assertNotIn(b"secret-canary", output.getvalue())
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertNotIn("complete", [frame["type"] for frame in emitted])
                self.assertEqual(emitted[-1], {"type": "error", "code": "RUNTIME_ERROR"})
                if failure != "construct":
                    self.assertTrue(closed)

    def test_completion_fails_closed_on_provider_failure_malformed_or_oversized_history(self):
        adapter = load_adapter()
        normal = {"completed": True, "final_response": "offline fixture", "messages": []}
        cases = [({**normal, "completed": False, "error": "secret-canary"}, "RUNTIME_ERROR"),
                 ({**normal, "final_response": None}, "PROTOCOL_ERROR"),
                 ({**normal, "messages": {}}, "PROTOCOL_ERROR"),
                 ({**normal, "messages": [{"content": object()}]}, "PROTOCOL_ERROR"),
                 ({**normal, "messages": [{"content": "r" * (2 * 1024 * 1024)}]}, "BUDGET_EXCEEDED"),
                 ({**normal, "final_response": "r" * (512 * 1024 + 1)}, "BUDGET_EXCEEDED")]
        for completion, code in cases:
            with self.subTest(code=code):
                output = io.BytesIO()

                class CompletionBackend(OfflineBackend):
                    def run(self, message, task_id):
                        return completion

                result = adapter.run_adapter(io.BytesIO(frames(initialize(), {
                    "type": "start", "userMessage": "synthetic", "taskId": "task"
                })), output, backend_factory=CompletionBackend)
                self.assertEqual(result, 1)
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual([frame["type"] for frame in emitted], ["ready", "error"])
                self.assertEqual(emitted[-1], {"type": "error", "code": code})
                self.assertNotIn(b"secret-canary", output.getvalue())

    def test_tool_call_and_cumulative_result_budgets_are_terminal(self):
        adapter = load_adapter()
        for reply_count, body, expected_calls in [(33, None, 32), (5, "r" * (450 * 1024), 5)]:
            with self.subTest(reply_count=reply_count):
                output = io.BytesIO()

                class BudgetBackend(OfflineBackend):
                    def run(self, message, task_id):
                        for _ in range(reply_count + 2):
                            try:
                                self.bridge.call(TOOL_NAMES[0], {})
                            except Exception:
                                pass
                        return super().run(message, task_id)

                payload = frames(initialize(), {"type": "start", "userMessage": "synthetic", "taskId": "task"},
                                 *[{"type": "tool_result", "id": i, "result": body} for i in range(1, reply_count + 1)])
                result = adapter.run_adapter(io.BytesIO(payload), output, backend_factory=BudgetBackend)
                self.assertEqual(result, 1)
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(sum(item["type"] == "tool_call" for item in emitted), expected_calls)
                self.assertEqual(emitted[-1], {"type": "error", "code": "BUDGET_EXCEEDED"})

    def test_tools_refuse_unknown_names_non_object_arguments_and_pre_start_access(self):
        adapter = load_adapter()
        for name, arguments, pre_start, code in [("terminal", {}, False, "ISOLATION_REJECTED"),
                                                  (TOOL_NAMES[0], [], False, "PROTOCOL_ERROR"),
                                                  (TOOL_NAMES[0], {"x": object()}, False, "PROTOCOL_ERROR"),
                                                  (TOOL_NAMES[0], {}, True, "PROTOCOL_ERROR")]:
            with self.subTest(code=code):
                output = io.BytesIO()

                class GuardBackend(OfflineBackend):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        if pre_start:
                            self.invoke()

                    def invoke(self):
                        try:
                            self.bridge.call(name, arguments)
                        except Exception:
                            pass

                    def run(self, message, task_id):
                        self.invoke()
                        return super().run(message, task_id)

                result = adapter.run_adapter(io.BytesIO(frames(initialize(), {
                    "type": "start", "userMessage": "synthetic", "taskId": "task"
                })), output, backend_factory=GuardBackend)
                self.assertEqual(result, 1)
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertNotIn("tool_call", [item["type"] for item in emitted])
                self.assertEqual(emitted[-1], {"type": "error", "code": code})
                if pre_start:
                    self.assertEqual(len(emitted), 1)

    def test_wrong_reordered_or_open_tool_result_remains_terminal_when_sdk_catches_it(self):
        adapter = load_adapter()
        invalid = [{"type": "tool_result", "id": 2, "result": "secret-canary"},
                   {"type": "tool_result", "id": True, "result": None},
                   {"type": "tool_result", "id": 1, "result": {}, "extra": True},
                   {"type": "start", "id": 1, "result": {}}]

        class CatchingBackend(OfflineBackend):
            def run(self, message, task_id):
                try:
                    self.bridge.call(TOOL_NAMES[0], {})
                except Exception:
                    pass  # The real SDK converts handler exceptions to tool errors.
                return super().run(message, task_id)

        for reply in invalid:
            with self.subTest(reply=reply):
                output = io.BytesIO()
                result = adapter.run_adapter(io.BytesIO(frames(initialize(), {
                    "type": "start", "userMessage": "synthetic", "taskId": "task"
                }, reply)), output, backend_factory=CatchingBackend)
                self.assertEqual(result, 1)
                emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual([item["type"] for item in emitted], ["ready", "tool_call", "error"])
                self.assertEqual(emitted[-1], {"type": "error", "code": "PROTOCOL_ERROR"})
                self.assertNotIn(b"secret-canary", output.getvalue())

    def test_parallel_sdk_handlers_serialize_correlated_tool_frames(self):
        adapter = load_adapter()
        output = io.BytesIO()
        returned = []

        class ToolBackend(OfflineBackend):
            def run(self, message, task_id):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    values = list(executor.map(lambda name: self.bridge.call(name, {}), TOOL_NAMES[:2]))
                returned.extend(json.loads(value) for value in values)
                return super().run(message, task_id)

        payload = frames(initialize(), {"type": "start", "userMessage": "synthetic", "taskId": "task"},
                         {"type": "tool_result", "id": 1, "result": {"exact": "\ufefffirst"}},
                         {"type": "tool_result", "id": 2, "result": [2, None]})
        result = adapter.run_adapter(io.BytesIO(payload), output, backend_factory=ToolBackend)
        self.assertEqual(result, 0)
        emitted = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["type"] for item in emitted], ["ready", "tool_call", "tool_call", "complete"])
        self.assertEqual([item["id"] for item in emitted[1:3]], [1, 2])
        self.assertEqual({item["name"] for item in emitted[1:3]}, set(TOOL_NAMES[:2]))
        by_name = dict(zip(TOOL_NAMES[:2], returned))
        self.assertEqual([by_name[item["name"]] for item in emitted[1:3]], [{"exact": "\ufefffirst"}, [2, None]])
        for item in emitted[1:3]:
            self.assertEqual(set(item), {"type", "id", "name", "arguments"})
            self.assertEqual(item["arguments"], {})

    def test_start_is_closed_typed_and_task_identifier_is_not_a_path(self):
        adapter = load_adapter()
        valid = {"type": "start", "userMessage": "Synthetic task", "taskId": "run-attempt"}
        cases = [initialize(), [], {**valid, "extra": True}, {**valid, "userMessage": []},
                 {**valid, "userMessage": ""}, {**valid, "userMessage": "x" * (64 * 1024 + 1)},
                 {**valid, "taskId": "../../outside"}, {**valid, "taskId": ""}]
        for start in cases:
            with self.subTest(start_type=type(start).__name__):
                output = io.BytesIO()
                backends = []

                def factory(*args, **kwargs):
                    backend = OfflineBackend(*args, **kwargs)
                    backends.append(backend)
                    return backend

                result = adapter.run_adapter(io.BytesIO(frames(initialize(), start)), output, backend_factory=factory)
                self.assertEqual(result, 1)
                self.assertEqual(backends[0].runs, [])
                self.assertTrue(backends[0].closed)
                self.assertEqual(json.loads(output.getvalue().splitlines()[-1]), {"type": "error", "code": "PROTOCOL_ERROR"})

    def test_frames_reject_invalid_duplicate_non_scalar_and_oversized_json(self):
        adapter = load_adapter()
        cases = [(b"", "PROTOCOL_ERROR"), (b"{}", "PROTOCOL_ERROR"), (b"\xff\n", "PROTOCOL_ERROR"),
                 (b'{"type":"initialize","type":"start"}\n', "PROTOCOL_ERROR"),
                 (b'{"x":NaN}\n', "PROTOCOL_ERROR"), (b'{"x":1e999}\n', "PROTOCOL_ERROR"),
                 (b'{"x":"\\ud800"}\n', "PROTOCOL_ERROR"),
                 (b"[" * 66 + b"0" + b"]" * 66 + b"\n", "PROTOCOL_ERROR"),
                 (b" " * (512 * 1024) + b"\n", "BUDGET_EXCEEDED")]

        class BoundedReader(io.BytesIO):
            def readline(self, size: int | None = -1):
                if size is None or size <= 0 or size > 512 * 1024 + 1:
                    raise AssertionError("unbounded frame read")
                return super().readline(size)

        for payload, code in cases:
            with self.subTest(code=code, size=len(payload)):
                output = io.BytesIO()
                called = []
                result = adapter.run_adapter(BoundedReader(payload), output,
                                             backend_factory=lambda *a, **k: called.append(True))
                self.assertEqual(result, 1)
                self.assertEqual(called, [])
                self.assertEqual(json.loads(output.getvalue()), {"type": "error", "code": code})

    def test_initialize_is_closed_and_requires_exact_five_tools_and_finite_budgets(self):
        adapter = load_adapter()
        cases = []
        for key, value in (("extra", "not admitted"), ("maxIterations", True), ("maxIterations", 13),
                           ("maxTokens", 8193), ("maxSeconds", 0), ("maxSeconds", 241)):
            frame = initialize()
            frame[key] = value
            cases.append(frame)
        for tools in ([], initialize()["tools"][:-1], initialize()["tools"] * 2):
            cases.append({**initialize(), "tools": tools})
        frame = initialize()
        frame["tools"][0]["name"] = "terminal"
        cases.append(frame)
        frame = initialize()
        frame["tools"][0]["handler"] = "not admitted"
        cases.append(frame)
        for frame in cases:
            with self.subTest(frame=frame):
                output = io.BytesIO()
                called = []
                result = adapter.run_adapter(io.BytesIO(frames(frame)), output,
                                             backend_factory=lambda *a, **k: called.append(True))
                self.assertEqual(result, 1)
                self.assertEqual(called, [])
                self.assertEqual(json.loads(output.getvalue()), {"type": "error", "code": "PROTOCOL_ERROR"})

    def test_ready_precedes_reading_start_then_runs_existing_backend_once(self):
        adapter = load_adapter()
        output = io.BytesIO()
        backends = []

        class Reader(io.BytesIO):
            def readline(self, size: int | None = -1):
                if self.tell():
                    emitted = [json.loads(line) for line in output.getvalue().splitlines()]
                    self.assert_ready(emitted)
                return super().readline(size)

            def assert_ready(self, emitted):
                if len(emitted) != 1 or emitted[0].get("type") != "ready":
                    raise AssertionError("selected input read before verified ready")

        def factory(*args, **kwargs):
            backend = OfflineBackend(*args, **kwargs)
            backends.append(backend)
            return backend

        result = adapter.run_adapter(Reader(frames(initialize(), {
            "type": "start", "userMessage": "Synthetic task", "taskId": "run-attempt"
        })), output, backend_factory=factory, model="chosen-model", provider="chosen-provider")
        self.assertEqual(result, 0)
        emitted = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(emitted[0], {"type": "ready", "tools": TOOL_NAMES, "isolation": ISOLATION,
                                     "runtime": {"adapter": "hermes-sdk", "model": "offline-test", "provider": "offline-test"}})
        self.assertEqual(emitted[1], {"type": "complete", "sessionId": "offline-session",
                                     "finalResponse": "Offline fixture, not model output", "messages": []})
        self.assertEqual(backends[0].runs, [("Synthetic task", "run-attempt")])
        self.assertTrue(backends[0].closed)
        self.assertEqual(backends[0].options, {"model": "chosen-model", "provider": "chosen-provider"})

    def test_initialize_rejects_selected_input_before_sdk_construction(self):
        self.assertTrue(ADAPTER_PATH.is_file(), "bounded IPC adapter is not implemented")
        adapter = load_adapter()
        output = io.BytesIO()
        calls = []
        result = adapter.run_adapter(
            io.BytesIO(b'{"type":"start","userMessage":"withheld","taskId":"t"}\n'),
            output,
            backend_factory=lambda *args, **kwargs: calls.append(args),
        )
        self.assertEqual(result, 1)
        self.assertEqual(calls, [])
        self.assertEqual(json.loads(output.getvalue()), {"type": "error", "code": "PROTOCOL_ERROR"})


if __name__ == "__main__":
    unittest.main()
