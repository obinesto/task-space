"use strict";
/* global require, module */

const policy = require("./dependabot-policy.cjs");

async function resolvePullRequest({ github, context, core, exec }) {
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const eventRun = context.payload.workflow_run;
  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: "dependency-check.yml",
  });
  const { data: run } = await github.rest.actions.getWorkflowRun({
    owner, repo, run_id: eventRun.id,
  });
  if (
    run.workflow_id !== workflow.id ||
    run.display_title === policy.IGNORED_RUN ||
    !policy.EVENTS.includes(run.event) ||
    run.status !== "completed" ||
    !["success", "failure", "timed_out"].includes(run.conclusion) ||
    run.run_attempt !== eventRun.run_attempt ||
    run.head_repository?.full_name !== repository ||
    !run.head_branch?.startsWith("dependabot/")
  ) {
    core.info("This run is not an eligible Dependabot validation.");
    return;
  }

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner, repo, run_id: run.id, filter: "latest", per_page: 100,
  });
  const requiredJobs = policy.VALIDATION_JOBS;
  const approved = name => jobs.find(job => job.name === name)?.steps?.some(
    step => step.name === policy.APPROVED_STEP && step.conclusion === "success",
  );

  const candidates = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: "open", head: `${owner}:${run.head_branch}`, per_page: 100,
  });
  function isEligible(pr) {
    return pr.state === "open" &&
      !pr.draft &&
      pr.user?.login === "dependabot[bot]" &&
      pr.head.repo?.full_name === repository &&
      pr.base.repo?.full_name === repository &&
      pr.head.ref === run.head_branch &&
      pr.head.ref !== pr.base.ref &&
      pr.head.sha === run.head_sha;
  }
  const eligible = candidates.filter(isEligible);
  if (eligible.length !== 1) {
    core.info("No unique open Dependabot PR matches the validated commit.");
    return;
  }
  const pull_number = eligible[0].number;
  const { data: initial } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (!isEligible(initial)) return;
  const baseSha = initial.base.sha;
  const testedBaseSha = run.pull_requests?.find(pr => pr.number === pull_number)?.base?.sha;
  if (!testedBaseSha || testedBaseSha !== baseSha) {
    core.info("The base branch changed or the tested base commit is unavailable.");
    return;
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number, per_page: 100,
  });
  const dependencyFiles = new Set([
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
  ]);
  if (!files.length || files.some(file =>
    !dependencyFiles.has(file.filename.split("/").pop()) ||
    file.status === "renamed"
  )) {
    core.info("The PR includes changes outside dependency manifests and lockfiles.");
    return;
  }

  async function markReleasePolicy(state, description) {
    await github.rest.repos.createCommitStatus({
      owner, repo, sha: run.head_sha, state,
      context: "Dependency release policy", description,
      target_url: run.html_url,
    });
  }

  if (!approved("Peer dependency check")) {
    await markReleasePolicy("pending", "Release policy is held or has not been verified.");
    core.info("The release policy is held or was not verified. The PR remains open.");
    return;
  }

  async function currentPrForResult() {
    const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number });
    const { data: latestRun } = await github.rest.actions.getWorkflowRun({
      owner, repo, run_id: run.id,
    });
    const recentRun = await policy.findLatestValidationRun({
      github, context, workflowId: workflow.id, branch: run.head_branch, headSha: run.head_sha,
    });
    if (
      !isEligible(current) ||
      current.base.sha !== baseSha ||
      latestRun.status !== "completed" ||
      latestRun.conclusion !== run.conclusion ||
      latestRun.run_attempt !== run.run_attempt ||
      recentRun?.id !== run.id
    ) {
      core.info("The PR or its validation changed. Fresh validation is required.");
      return null;
    }
    const releasePolicy = await policy.checkReleaseAge({
      github,
      context: { ...context, eventName: run.event, payload: { pull_request: current } },
      core: { setOutput() { }, info: message => core.info(message) },
    });
    if (releasePolicy.state !== "ready") {
      await markReleasePolicy("pending", "Release policy needs more time or a reviewed exception.");
      return null;
    }
    return current;
  }

  async function deleteValidatedBranch(pr) {
    try {
      const { data: branch } = await github.rest.git.getRef({
        owner, repo, ref: "heads/" + pr.head.ref,
      });
      if (branch.object.sha !== run.head_sha) {
        core.warning("The PR branch changed after validation, so it was kept.");
        return;
      }
      await github.rest.git.deleteRef({
        owner, repo, ref: "heads/" + pr.head.ref,
      });
      core.info("Deleted the Dependabot branch.");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async function closeFailedPr(reason) {
    const current = await currentPrForResult();
    if (!current) return;
    const { data: closed } = await github.rest.pulls.update({
      owner, repo, pull_number, state: "closed",
    });
    if (closed.state !== "closed" || closed.merged || closed.head.sha !== run.head_sha) {
      core.warning("The PR changed during closure, so its branch was kept.");
      return;
    }
    core.info(reason + " Closed the Dependabot PR without merging.");
    await deleteValidatedBranch(closed);
  }

  if (run.conclusion !== "success") {
    const failed = jobs.some(job => requiredJobs.includes(job.name) && approved(job.name) &&
      ["failure", "timed_out"].includes(job.conclusion));
    if (failed) {
      await closeFailedPr("Dependency validation failed.");
    } else {
      await markReleasePolicy("pending", "Validation did not reach an approved release policy.");
      core.info("No failed dependency validation job was confirmed.");
    }
    return;
  }
  for (const name of requiredJobs) {
    if (!approved(name) || !jobs.some(job => job.name === name && job.conclusion === "success")) {
      await markReleasePolicy("pending", "Release policy or project validation is on hold.");
      core.info("Required validation did not pass: " + name);
      return;
    }
  }

  if (!await currentPrForResult()) return;
  await markReleasePolicy("success", "Release age and validation approved for this commit.");

  // Wait for other PR checks without executing or checking out PR code here.
  const checks = await exec.getExecOutput("gh", [
    "pr", "checks", String(pull_number), "--repo", repository,
    "--watch", "--interval", "10", "--fail-fast",
  ], { ignoreReturnCode: true });
  if (checks.exitCode !== 0) {
    // CLI/API errors and cancellations are not evidence of a failed check.
    const report = await exec.getExecOutput("gh", [
      "pr", "checks", String(pull_number), "--repo", repository, "--json", "bucket,name",
    ], { ignoreReturnCode: true });
    if (![0, 1, 8].includes(report.exitCode)) {
      core.setFailed("Could not verify PR checks. The PR branch was kept.");
      return;
    }
    let results;
    try {
      results = JSON.parse(report.stdout);
      if (!Array.isArray(results)) throw new Error("Invalid check report");
    } catch {
      core.setFailed("Could not read PR checks. The PR branch was kept.");
      return;
    }
    if (results.some(check => check.bucket === "fail")) {
      await closeFailedPr("A PR check failed.");
    } else {
      core.setFailed("No failed check was confirmed. The PR branch was kept.");
    }
    return;
  }

  const current = await currentPrForResult();
  if (!current) return;

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner, repo, pull_number, per_page: 100,
  });
  const latestReviews = new Map();
  for (const review of reviews) {
    if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latestReviews.set(review.user.login, review);
    }
  }
  if ([...latestReviews.values()].some(review => review.state === "CHANGES_REQUESTED")) {
    core.info("A reviewer requested changes. Automatic merging is paused.");
    return;
  }
  const approval = latestReviews.get("github-actions[bot]");
  if (approval?.state !== "APPROVED" || approval.commit_id !== run.head_sha) {
    await github.rest.pulls.createReview({
      owner, repo, pull_number, commit_id: run.head_sha, event: "APPROVE",
      body: "Release-age policy, dependency installation, and project checks passed for this commit.",
    });
  }
  const { data: settings } = await github.rest.repos.get({ owner, repo });
  const merge_method = settings.allow_squash_merge ? "squash" :
    settings.allow_merge_commit ? "merge" : settings.allow_rebase_merge ? "rebase" : null;
  if (!merge_method) {
    core.setFailed("No supported merge method is enabled for this repository.");
    return;
  }
  const { data: merged } = await github.rest.pulls.merge({
    owner, repo, pull_number, sha: run.head_sha, merge_method,
  });
  if (!merged.merged) {
    core.setFailed("GitHub did not merge the PR. Its branch was kept.");
    return;
  }
  core.info(`Merged PR #${pull_number} into ${current.base.ref}.`);

  await deleteValidatedBranch(current);
}

module.exports = { resolvePullRequest };
