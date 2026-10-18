"""Offline release-gate checks. Never call GitHub or the Comfy registry."""

import ast
import itertools
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


def workflow(name):
    # BaseLoader preserves YAML's `on` key instead of treating it as a boolean.
    return yaml.load((ROOT / ".github/workflows" / name).read_text(encoding="utf-8"),
                     Loader=yaml.BaseLoader)


def condition(expression, values):
    """Evaluate only the equality/boolean subset used by these job guards.

    This is not a GitHub runner emulator; actionlint validates Actions syntax.
    Unknown constructs fail the test instead of silently granting publication.
    """
    for key in sorted(values, key=len, reverse=True):
        expression = re.sub(re.escape(key) + r"\b", repr(values[key]), expression)
    tree = ast.parse(expression.replace("&&", " and ").replace("||", " or ").strip(),
                     mode="eval")

    def evaluate(node):
        if isinstance(node, ast.Expression):
            return evaluate(node.body)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.BoolOp):
            items = [evaluate(value) for value in node.values]
            if isinstance(node.op, ast.And):
                return all(items)
            if isinstance(node.op, ast.Or):
                return any(items)
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
            return evaluate(node.left) == evaluate(node.comparators[0])
        raise AssertionError(f"Unsupported gate expression: {ast.dump(node)}")

    return bool(evaluate(tree))


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tests = workflow("tests.yml")
        self.publish = workflow("publish_action.yml")

    def test_readme_only_skip_and_manual_tests_default_are_preserved(self):
        for event in ("push", "pull_request"):
            self.assertEqual(self.tests["on"][event]["paths-ignore"], ["README.md"])
        self.assertEqual(self.tests["on"]["workflow_dispatch"]["inputs"]["publish"]["default"], "false")

    def test_no_independent_publish_trigger_or_duplicate_test_invocation(self):
        self.assertEqual(set(self.publish["on"]), {"workflow_call"})
        self.assertEqual(set(self.publish["jobs"]), {"publish-node"})
        callers = [(name, job) for name, job in self.tests["jobs"].items() if "uses" in job]
        self.assertEqual([name for name, _ in callers], ["publish-node"])
        self.assertEqual(callers[0][1]["uses"], "./.github/workflows/publish_action.yml")
        self.assertEqual(set(callers[0][1]["needs"]),
                         {"release-check", "python-tests", "frontend-tests"})

    def test_all_checkouts_use_same_sha_and_publisher_cannot_replace_it(self):
        for config in (self.tests, self.publish):
            self.assertEqual(config["permissions"], {"contents": "read"})
            for job in config["jobs"].values():
                self.assertNotEqual(job.get("continue-on-error"), "true")
                for step in job.get("steps", []):
                    self.assertNotEqual(step.get("continue-on-error"), "true")
                    if step.get("uses", "").startswith("actions/checkout@"):
                        self.assertEqual(step["with"]["ref"], "${{ github.sha }}")
        steps = self.publish["jobs"]["publish-node"]["steps"]
        publish_step = next(s for s in steps if s.get("uses", "").startswith("Comfy-Org/publish-node-action@"))
        self.assertEqual(publish_step["with"]["skip_checkout"], "true")
        self.assertEqual(self.tests["jobs"]["release-check"]["steps"][1]["env"]["RELEASE_SHA"],
                         "${{ github.sha }}")

    def test_existing_matrix_is_required_in_full(self):
        matrix = self.tests["jobs"]["python-tests"]["strategy"]["matrix"]["include"]
        self.assertEqual({(leg["os"], leg["python-version"]) for leg in matrix}, {
            ("ubuntu-latest", "3.10"), ("ubuntu-latest", "3.13"), ("windows-latest", "3.13"),
        })

    def test_publish_gate_rejects_failure_cancel_skip_and_missing_output(self):
        guard = self.tests["jobs"]["publish-node"]["if"]
        self.assertNotIn("always()", guard)
        results = ("success", "failure", "cancelled", "skipped")
        for outcomes in itertools.product(results, repeat=3):
            for output in ("true", "false", ""):
                with self.subTest(outcomes=outcomes, output=output):
                    values = {"github.ref": "refs/heads/main",
                              "needs.release-check.outputs.publish": output}
                    values.update({f"needs.{job}.result": outcome for job, outcome in zip(
                        ("release-check", "python-tests", "frontend-tests"), outcomes)})
                    self.assertEqual(condition(guard, values),
                                     all(result == "success" for result in outcomes) and output == "true")

    def test_release_eligibility_only_allows_main_push_or_explicit_manual_publish(self):
        guard = self.tests["jobs"]["release-check"]["if"]
        for ref, event, manual in itertools.product(
                ("refs/heads/main", "refs/heads/feature", "refs/pull/1/merge", "refs/tags/v1"),
                ("push", "pull_request", "workflow_dispatch"), (False, True)):
            with self.subTest(ref=ref, event=event, manual=manual):
                self.assertEqual(condition(guard, {"github.ref": ref,
                    "github.event_name": event, "inputs.publish": manual}),
                    ref == "refs/heads/main" and (event == "push" or
                        (event == "workflow_dispatch" and manual)))
        self.assertFalse(condition(self.publish["jobs"]["publish-node"]["if"],
                                   {"github.ref": "refs/heads/feature"}))


class ReleaseDetectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="a5-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.env = os.environ.copy()
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        self.git_exe = shutil.which("git")
        self.assertIsNotNone(self.git_exe, "Git is required for release automation tests")
        if os.name == "nt":
            self.bash = str(Path(self.git_exe).resolve().parents[1] / "bin/bash.exe")
        else:
            self.bash = shutil.which("bash")
        self.assertTrue(self.bash and Path(self.bash).is_file(), "Bash/Git Bash is required")
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.before = self.commit("pyproject.toml", 'version = "0.1.3"\n')
        self.script = next(step["run"] for step in workflow("tests.yml")["jobs"]["release-check"]["steps"]
                           if step.get("id") == "release")

    def git(self, *args):
        return subprocess.run([self.git_exe, *args], cwd=self.repo, env=self.env,
                              text=True, capture_output=True, check=True).stdout.strip()

    def commit(self, name, content):
        (self.repo / name).write_text(content, encoding="utf-8")
        self.git("add", name)
        self.git("-c", "commit.gpgsign=false", "commit", "-m", "Fixture change")
        return self.git("rev-parse", "HEAD")

    def detect(self, before=None, sha=None, event="push"):
        output = self.repo / "output"
        env = dict(self.env, EVENT_NAME=event, BEFORE=self.before if before is None else before,
                   RELEASE_SHA=self.git("rev-parse", "HEAD") if sha is None else sha,
                   GITHUB_OUTPUT=output.as_posix(), RUNNER_TEMP=self.repo.as_posix())
        result = subprocess.run([self.bash, "-e", "-o", "pipefail", "-c", self.script],
                                cwd=self.repo, env=env, capture_output=True, text=True)
        return result, output.read_text().strip() if output.exists() else ""

    def assert_detection(self, expected, **kwargs):
        result, output = self.detect(**kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, f"publish={str(expected).lower()}")

    def test_multi_commit_push_detects_earlier_version_change(self):
        self.commit("pyproject.toml", 'version = "0.1.4"\n')
        self.commit("README.md", "Documentation after version bump\n")
        self.assert_detection(True)

    def test_readme_or_code_only_push_does_not_publish(self):
        self.commit("README.md", "Documentation\n")
        self.commit("node.py", "# Code-only update\n")
        self.assert_detection(False)

    def test_non_version_pyproject_edit_keeps_existing_path_trigger_behavior(self):
        self.commit("pyproject.toml", 'version = "0.1.3"\n# Metadata update\n')
        self.assert_detection(True)

    def test_new_main_branch_compares_to_empty_tree(self):
        self.assert_detection(True, before="0" * 40)

    def test_missing_history_fails_closed(self):
        result, output = self.detect(before="f" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("publish=true", output)

    def test_missing_push_before_sha_fails_closed(self):
        result, output = self.detect(before="")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("publish=true", output)

    def test_previous_tip_can_be_fetched_from_local_origin(self):
        # A separate local repo models history absent from the checkout after
        # a force push. The fallback fetch must not contact any network service.
        origin = self.repo / "origin"
        self.git("init", "-b", "old-main", str(origin))
        (origin / "pyproject.toml").write_text('version = "0.1.2"\n', encoding="utf-8")
        self.git("-C", str(origin), "add", "pyproject.toml")
        self.git("-C", str(origin), "-c", "user.name=Release Test",
                 "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
                 "commit", "-m", "Previous tip")
        previous_tip = self.git("-C", str(origin), "rev-parse", "HEAD")
        self.git("remote", "add", "origin", origin.as_posix())
        self.assert_detection(True, before=previous_tip)

    def test_invalid_release_sha_fails_closed(self):
        result, output = self.detect(sha="e" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("publish=true", output)

    def test_manual_publish_does_not_require_a_push_before_sha(self):
        self.assert_detection(True, event="workflow_dispatch", before="")

    def test_branch_advancing_does_not_change_release_commit_comparison(self):
        tested_sha = self.git("rev-parse", "HEAD")
        self.commit("pyproject.toml", 'version = "0.1.4"\n')
        self.assert_detection(False, sha=tested_sha)


if __name__ == "__main__":
    unittest.main()
