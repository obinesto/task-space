# Dependency CI implementation

The dependency CI handles Dependabot security updates from validation through PR resolution.
Routine version updates are disabled. Security updates change lockfiles within existing manifest ranges.
Major upgrades require manual review. Alerts can remain open when no compatible fix exists.

## Workflow structure

| Workflow | Responsibility |
| --- | --- |
| `dependency-check.yml` | Evaluates release age, checks peer dependencies, and runs applicable project checks and builds. |
| `dependabot-automerge.yml` | Resolves validated PRs and deletes branches after a merge or confirmed failure. |
| `dependabot-recheck.yml` | Requests retries for eligible held runs daily at 06:31 UTC or through manual dispatch. |

Validation applies to open, non-draft PRs from `dependabot[bot]` within the same repository.
Their branch names start with `dependabot/`. PR changes are limited to supported dependency manifests and lockfiles.
PR updates trigger validation. Security urgency label changes and human review decisions also trigger validation.
Review decisions include approvals, requested changes, and dismissals.
Other labels, review comments, and bot reviews produce skipped runs without installation or builds.
These skipped runs cannot cancel validation or replace its result in resolver and retry decisions.

## Release policy

New direct and transitive package versions require seven days of release age before installation.
The policy reads public registry metadata and compares the proposed lockfile with the base version.
The helpers come from the default branch. Dependency installation follows policy approval.
Dependabot can open security PRs immediately; the release gate delays validation and merging.

Missing dates, unavailable metadata, unsupported sources, and conflicting urgency labels place the PR on hold.
Held PRs and branches remain open. Holds do not count as failed dependency validation.

Without an urgency label, the seven-day policy applies.
`security-urgency:urgent` and `security-urgency:emergency` support reviewed exceptions.
An exception requires written approval of the exact proposed commit from a human with repository write access.
It bypasses release age only. Registry verification and compatibility checks still apply.
Dismissed approvals, changed commits, and requested changes prevent the exception.
`security-urgency:uncertain` places the PR on hold.

The workflows do not calculate urgency from vulnerability scores.
Their `GITHUB_TOKEN` permissions do not provide Dependabot alert details for that assessment.

## Validation and PR outcomes

Validation uses Node.js 26. The peer dependency job installs with lifecycle scripts disabled and checks the dependency tree.
The project job installs normally and runs the repository's applicable lint, test, type-check, and build commands.
Multi-project repositories select projects from changed manifest and lockfile directories.
Selection includes local dependents from both manifest revisions and projects with shared directory ancestry.
Workspaces and unknown dependency boundaries retain full project validation.
Unavailable project metadata places the PR on hold.
Lint warnings remain advisory. Errors and confirmed check failures block merging.

| Result | PR outcome |
| --- | --- |
| Policy approved and checks passed | Automatic approval and merge, followed by branch deletion. |
| Confirmed validation or PR check failure | Closure without merging, followed by branch deletion. |
| Policy hold, API error, cancellation, or stale validation | PR and branch retained. |

The resolver verifies current commits, validation results, and release policy before changing the PR.
Branch deletion also checks that the branch still points to the validated commit.
Closing a security PR leaves its vulnerability unresolved.

## Enforcement and retry limits

Branch protection enforcement depends on three required checks:
`Dependency release policy`, `Peer dependency check`, and `Project checks and build`.
The release status remains pending during a hold. Skipped jobs alone do not enforce the delay.
Automatic approval depends on the repository setting that permits Actions PR approvals.
Repository rules and enabled merge methods still apply.

Daily retries cover held runs that contain the release gate and match the current PR commits.
Reruns retain their original event and commits. A changed base requires fresh validation.
Runs at least 30 days old or at 50 attempts are excluded from automatic retries.
Existing PRs need a fresh event to use a newly introduced workflow.
Disabling routine updates does not close their existing PRs.

All workflows use `GITHUB_TOKEN`; no personal access token is required.
GitHub can suppress downstream workflow triggers for changes made with this token.
Deployment behavior therefore depends on the repository's integration.

## Policy tests

`scripts/dependabot-policy.test.cjs` checks release age, reviewed exceptions, project selection, PR resolution, and retry eligibility.
It uses simulated GitHub and registry responses without network access or dependency installation.
The tests do not change PRs or branches. They run before the release gate in the peer dependency job.
