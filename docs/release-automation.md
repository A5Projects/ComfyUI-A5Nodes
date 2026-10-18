# Registry release automation

The `Tests` workflow owns the release gate. Its existing Python matrix (Linux
3.10, Linux 3.13, Windows 3.13) and Node.js 24 frontend job run once per event.
Publishing depends on both test jobs and a successful release eligibility check.
A failed, cancelled, or skipped dependency cannot publish.

## Automatic releases

A push to `main` publishes only when `pyproject.toml` differs between the push's
previous and final commit. The comparison covers multi-commit pushes, not just
the last commit. New branches compare against an empty tree; unavailable previous
history fails the eligibility check rather than allowing publication.

The existing version in `pyproject.toml` and Comfy registry action are retained;
this workflow does not bump versions or create releases. Non-version edits to
`pyproject.toml` still invoke the registry action, matching the old path trigger.
README-only pushes and pull requests still skip the entire Tests workflow.
Other pushes run tests without publishing unless the release condition is met.
Pull requests and non-main branches never publish.

## Manual releases

Use **Actions > Tests > Run workflow**, select **main**, and enable **publish**.
The default is tests only. A manual publish runs all tests before publishing the
selected commit. The separate `Publish to Comfy registry` workflow is now callable
only by another workflow; its former direct dispatch/push entry points are removed.
Do not add callers that bypass the test gate.

## Commit identity and validation

All test and publishing checkouts use `github.sha`. The local reusable workflow
comes from that same commit. The publishing action's internal checkout is disabled
so it cannot replace the explicitly checked-out code. Advancing `main` while a
run is in progress does not change the commit that run tests or publishes.

Validate workflow syntax with `actionlint`. A pull request exercises the existing
Python matrix and frontend suite without publishing. Do not bump the version or
manually request publication just to validate this configuration.

The offline checks in `tests/test_release_automation.py` run with the existing
Python suite; PyYAML is a test-only dependency. They inspect the actual workflow
guards and run the release-detection shell script against temporary local Git
repositories, without registry credentials or network access:

```sh
python -m pip install pyyaml
python -m unittest tests.test_release_automation -v
actionlint .github/workflows/tests.yml .github/workflows/publish_action.yml
```

These checks cover all success/failure/cancelled/skipped dependency combinations,
missing outputs, trigger restrictions, exact-SHA checkouts, multi-commit pushes,
new branches, missing history and the fallback fetch. They do not simulate the
GitHub runner itself; validate the deployed configuration through a non-release
push or pull request, with the version unchanged.

Expected cases:

| Event / outcome | Publish |
| --- | --- |
| Main push changing pyproject; all tests pass | Yes |
| Main push changing pyproject; any Python leg or frontend fails | No |
| Any required job cancelled or skipped | No |
| Release detection fails or cannot read previous history | No |
| README-only push or pull request | No; CI remains skipped |
| Main push changing code but not pyproject | No; tests run |
| Pull request or non-main push, even with pyproject changes | No |
| Manual Tests run with default inputs | No |
| Manual Tests run on main with publish enabled; all tests pass | Yes |
| Manual Tests run on another branch with publish enabled | No |
