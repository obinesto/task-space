"use strict";
/* global require, module */

const { Buffer } = require("node:buffer");
const { URL } = require("node:url");
const { posix } = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_AGE_DAYS = 7;
const POLICY_JOB = "Release policy check";
const DECISION_PREFIX = "Policy decision: ";
const FINAL_RETRY_PREFIX = "Policy passed earlier; final verification unavailable.";
const VALIDATION_JOBS = ["Peer dependency check", "Project checks and build"];
const EVENTS = ["pull_request", "pull_request_review"];
const IGNORED_RUN = "Unrelated dependency event";
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]);
const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i;

class ManualReviewError extends Error {}

function isDependabotPullRequest(pr, repository) {
  return pr.state === "open" && !pr.draft &&
    pr.user?.login === "dependabot[bot]" &&
    pr.head.repo?.full_name === repository && pr.base.repo?.full_name === repository &&
    pr.head.ref.startsWith("dependabot/") && pr.head.ref !== pr.base.ref;
}

function packageRecord(record, fallbackName) {
  let name = record.name || fallbackName;
  let unsupported;
  try {
    const source = new URL(record.resolved);
    if (source.protocol !== "https:" || source.username || source.password || source.search || source.port ||
      !["registry.npmjs.org", "registry.yarnpkg.com"].includes(source.hostname)) {
      throw new Error("The package is not pinned to a public npm registry tarball.");
    }
    const parts = decodeURIComponent(source.pathname).slice(1).split("/-/");
    if (parts.length !== 2 || !parts[1]) throw new Error("The tarball path is unsupported.");
    name = parts[0];
    if (!PACKAGE_NAME.test(name) || !VERSION.test(record.version || "")) {
      throw new Error("The package name or version is unsupported.");
    }
  } catch (error) {
    unsupported = error.message;
  }
  return {
    name, version: record.version, resolved: record.resolved, integrity: record.integrity,
    unsupported,
    identity: JSON.stringify([name, record.version, record.resolved, record.integrity]),
  };
}

function parseNpmLock(text) {
  if (!text) return [];
  const lock = JSON.parse(text);
  const records = [];
  if ([2, 3].includes(lock.lockfileVersion) && lock.packages && typeof lock.packages === "object") {
    for (const [location, record] of Object.entries(lock.packages)) {
      if (!location || record.link || record.inBundle) continue;
      if (!record.version) throw new ManualReviewError("A lockfile entry has no version.");
      const name = location.split("node_modules/").at(-1);
      records.push(packageRecord(record, name));
    }
  } else if (lock.lockfileVersion === 1 && lock.dependencies) {
    const visit = dependencies => {
      for (const [name, record] of Object.entries(dependencies)) {
        if (!record.bundled) records.push(packageRecord(record, name));
        if (record.dependencies) visit(record.dependencies);
      }
    };
    visit(lock.dependencies);
  } else {
    throw new ManualReviewError("The npm lockfile format is unsupported. Manual review is required.");
  }
  return records;
}

// Read only the top-level records in the generated Yarn Classic v1 format.
// Unexpected formats are held instead of being treated as an empty dependency set.
function parseYarnLock(text) {
  if (!text) return [];
  if (!text.includes("# yarn lockfile v1")) throw new ManualReviewError("Only Yarn Classic v1 lockfiles are supported.");
  const records = [];
  let entry;
  function finish() {
    if (!entry) return;
    if (!entry.version) throw new ManualReviewError("A Yarn lockfile entry has no version.");
    records.push(packageRecord(entry, entry.selector));
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      if (!line.endsWith(":")) throw new ManualReviewError("The Yarn lockfile contains an unsupported record.");
      finish();
      entry = { selector: line.slice(0, -1) };
    } else if (/^ {2}(version|resolved|integrity) /.test(line)) {
      if (!entry) throw new ManualReviewError("The Yarn lockfile contains a field without a record.");
      const [, field, value] = line.match(/^ {2}(version|resolved|integrity) (.+)$/);
      entry[field] = value.startsWith('"') ? JSON.parse(value) : value;
    } else if (!entry) {
      throw new ManualReviewError("The Yarn lockfile contains an unsupported header.");
    }
  }
  finish();
  if (!records.length) throw new ManualReviewError("The Yarn lockfile contains no package records.");
  return records;
}

function findNewReleases(before, after) {
  const existing = new Set(before.map(record => record.identity));
  return [...new Map(after.filter(record => !existing.has(record.identity))
    .map(record => [record.identity, record])).values()];
}

async function readFile(github, context, filename, ref) {
  const { data } = await github.rest.repos.getContent({
    ...context.repo, path: filename, ref,
    headers: { accept: "application/vnd.github.raw+json" },
  });
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf8");
  if (!Array.isArray(data) && (data.lockfileVersion || data.name || data.dependencies)) return JSON.stringify(data);
  throw new Error("The pinned dependency file could not be read.");
}

async function changedReleases(github, context, pr) {
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo, pull_number: pr.number, per_page: 100,
  });
  const basename = filename => filename.split("/").at(-1);
  const directory = filename => filename.slice(0, filename.lastIndexOf("/") + 1);
  if (!files.length || files.some(file =>
    !["package.json", ...LOCKFILES].includes(basename(file.filename)) || file.status === "renamed")) {
    throw new ManualReviewError("The PR contains changes outside supported dependency manifests and lockfiles.");
  }
  const locks = files.filter(file => LOCKFILES.has(basename(file.filename)));
  if (files.some(file => basename(file.filename) === "package.json" &&
    !locks.some(lock => directory(lock.filename) === directory(file.filename)))) {
    throw new ManualReviewError("A manifest changed without its lockfile. Manual review is required.");
  }
  const result = [];
  for (const file of locks) {
    if (file.status === "removed") throw new ManualReviewError("A lockfile was removed. Manual review is required.");
    let before = "";
    if (file.status !== "added") before = await readFile(github, context, file.filename, pr.base.sha);
    const after = await readFile(github, context, file.filename, pr.head.sha);
    const parse = basename(file.filename) === "yarn.lock" ? parseYarnLock : parseNpmLock;
    result.push(...findNewReleases(parse(before), parse(after)));
  }
  return { files, releases: [...new Map(result.map(record => [record.identity, record])).values()] };
}

function affectedProjects(projects, files, manifests) {
  const all = [...new Set(projects)];
  const selected = new Set();
  for (const file of files) {
    const directory = posix.dirname(file.filename);
    if (!all.includes(directory)) return all;
    selected.add(directory);
  }
  const related = new Map(all.map(directory => [directory, new Set()]));
  for (const directory of all) {
    const records = manifests[directory];
    if (!records?.length) return all;
    for (const manifest of records) {
      if (manifest.workspaces) return all;
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies,
        ...manifest.peerDependencies, ...manifest.optionalDependencies };
      for (const [name, value] of Object.entries(dependencies)) {
        if (typeof value !== "string") return all;
        if (value.startsWith("workspace:")) return all;
        const targets = all.filter(target => target !== directory &&
          manifests[target]?.some(record => record.name === name));
        if (/^(file:|link:)/.test(value)) {
          const target = posix.join(directory, value.replace(/^(file:|link:)/, ""));
          if (!all.includes(target)) return all;
          targets.push(target);
        }
        for (const target of targets) related.get(target).add(directory);
      }
    }
    // Nested projects can share dependency resolution through ancestor node_modules.
    for (const other of all) {
      if (directory !== other && (directory === "." || other.startsWith(directory + "/"))) {
        related.get(directory).add(other);
        related.get(other).add(directory);
      }
    }
  }
  for (const directory of selected) {
    for (const dependent of related.get(directory)) selected.add(dependent);
  }
  return all.filter(directory => selected.has(directory));
}

async function findLatestValidationRun({ github, context, workflowId, branch, headSha }) {
  for (let page = 1; ; page++) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo, workflow_id: workflowId, branch, head_sha: headSha, per_page: 100, page,
    });
    const run = data.workflow_runs.find(candidate => candidate.display_title !== IGNORED_RUN);
    if (run || data.workflow_runs.length < 100) return run;
  }
}

async function inspectReleases(records, { now = Date.now(), fetchMetadata } = {}) {
  const metadata = new Map();
  const getMetadata = fetchMetadata || (async name => {
    const response = await globalThis.fetch("https://registry.npmjs.org/" + encodeURIComponent(name), {
      headers: { accept: "application/json" }, redirect: "error",
      signal: globalThis.AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("The npm registry could not verify " + name + ".");
    return response.json();
  });
  const results = [];
  for (let offset = 0; offset < records.length; offset += 8) {
    const batch = await Promise.all(records.slice(offset, offset + 8).map(async record => {
      if (record.unsupported) throw new ManualReviewError(record.name + ": " + record.unsupported);
      if (!metadata.has(record.name)) metadata.set(record.name, Promise.resolve().then(() => getMetadata(record.name)));
      const info = await metadata.get(record.name);
      const published = Date.parse(info.time?.[record.version]);
      const version = info.versions?.[record.version];
      if (!version || !Number.isFinite(published) || published > now) {
        throw new Error("The publication date of " + record.name + "@" + record.version + " could not be verified.");
      }
      const tarball = version.dist?.tarball;
      if (!tarball || new URL(tarball).pathname !== new URL(record.resolved).pathname) {
        throw new ManualReviewError("The registry tarball of " + record.name + "@" + record.version + " does not match the lockfile.");
      }
      const integrity = version.dist?.integrity;
      if (record.integrity && integrity && !record.integrity.split(/\s+/).includes(integrity)) {
        throw new ManualReviewError("The registry integrity of " + record.name + "@" + record.version + " does not match the lockfile.");
      }
      const eligibleAt = published + MINIMUM_AGE_DAYS * DAY_MS;
      return { name: record.name, version: record.version, eligibleAt, mature: now >= eligibleAt };
    }));
    results.push(...batch);
  }
  return results;
}

async function reviewedUrgency(github, context, pr) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo, pull_number: pr.number, per_page: 100,
  });
  const latest = new Map();
  for (const review of reviews) {
    if (review.user?.type === "User" && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user.login, review);
    }
  }
  if ([...latest.values()].some(review => review.state === "CHANGES_REQUESTED")) return false;
  for (const review of latest.values()) {
    if (review.state !== "APPROVED" || review.commit_id !== pr.head.sha || !review.body?.trim()) continue;
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...context.repo, username: review.user.login,
    });
    if (["admin", "maintain", "write"].includes(data.permission) || data.user?.permissions?.push) return true;
  }
  return false;
}

async function checkReleaseAge({ github, context, core, now = Date.now(), fetchMetadata, projects }) {
  core.setOutput("projects", "[]");
  let selected = [];
  async function finish(state, reason, details = []) {
    core.setOutput("state", state);
    core.setOutput("reason", reason);
    core.setOutput("projects", JSON.stringify(state === "ready" ? selected : []));
    core.info(reason);
    if (core.summary) {
      await core.summary.addHeading("Dependency release policy").addRaw(reason + "\n\n" + details.join("\n")).write();
    }
    return { state, reason };
  }
  try {
    const event = context.payload.pull_request;
    if (!event || !EVENTS.includes(context.eventName)) return finish("manual", "A supported Dependabot PR event is required.");
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: event.number });
    const repository = context.repo.owner + "/" + context.repo.repo;
    if (!isDependabotPullRequest(pr, repository) || pr.head.sha !== event.head.sha || pr.base.sha !== event.base.sha) {
      return finish("stale", "The PR changed. Rebase or reopen it to validate its current commits.");
    }
    const labels = pr.labels.map(label => typeof label === "string" ? label : label.name)
      .filter(name => name.startsWith("security-urgency:"));
    const urgency = labels.length ? labels[0].slice("security-urgency:".length) : "standard";
    if (labels.length > 1 || !["standard", "urgent", "emergency"].includes(urgency)) {
      return finish("manual", "Urgency is uncertain or conflicting. A repository writer must review it.");
    }
    const changes = await changedReleases(github, context, pr);
    const inspected = await inspectReleases(changes.releases, { now, fetchMetadata });
    if (projects) {
      if (!Array.isArray(projects) || !projects.length || projects.some(directory =>
        typeof directory !== "string" || directory === ".." || posix.normalize(directory) !== directory || directory.startsWith("../") || posix.isAbsolute(directory))) {
        throw new ManualReviewError("The configured project directories are invalid.");
      }
      if (projects.length === 1) {
        selected = projects;
      } else {
        const manifests = {};
        for (const directory of projects) {
          manifests[directory] = [];
          for (const ref of [pr.base.sha, pr.head.sha]) {
            manifests[directory].push(JSON.parse(await readFile(github, context, posix.join(directory, "package.json"), ref)));
          }
        }
        selected = affectedProjects(projects, changes.files, manifests);
      }
      if (!selected.length) throw new ManualReviewError("No affected project could be selected.");
      core.info("Affected projects: " + selected.join(", "));
    }
    const expedited = urgency === "urgent" || urgency === "emergency";
    if (expedited && !await reviewedUrgency(github, context, pr)) {
      return finish("approval", "Waiting for written approval of this commit from a repository writer for the urgent exception.");
    }
    const young = inspected.filter(record => !record.mature);
    if (young.length && !expedited) {
      const eligibleAt = new Date(Math.max(...young.map(record => record.eligibleAt))).toISOString();
      return finish("waiting", "Waiting for seven-day release age. Eligible at " + eligibleAt + ".", young.slice(0, 30)
        .map(record => "- " + record.name + "@" + record.version + ": " + new Date(record.eligibleAt).toISOString()));
    }
    return finish("ready", expedited ? "A repository writer approved this urgent release-age exception." :
      "All " + inspected.length + " new registry package versions meet the seven-day release-age policy.");
  } catch (error) {
    const manual = error instanceof ManualReviewError || error instanceof SyntaxError;
    return finish(manual ? "manual" : "retry", (manual ? "Manual review required: " : "Verification unavailable; retry needed: ") + error.message);
  }
}

async function publishPolicyStatus({ github, context, core, sha, url, state, reason }) {
  core.info(reason);
  if (core.summary) await core.summary.addHeading("Dependency automation").addRaw(reason).write();
  const description = reason.replace(/\s+/g, " ").slice(0, 140);
  const { data } = await github.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: sha });
  if (data.statuses.some(status => status.context === "Dependency release policy" &&
    status.state === state && status.description === description && status.target_url === url)) return;
  await github.rest.repos.createCommitStatus({
    ...context.repo, sha, state, context: "Dependency release policy",
    description, target_url: url,
  });
}

function policyStatus(state) {
  return state === "ready" ? "success" : ["manual", "stale"].includes(state) ? "failure" : "pending";
}

function readPolicyDecision(job) {
  const step = job?.steps?.find(item => item.name.startsWith(DECISION_PREFIX) && item.conclusion === "success");
  const match = step?.name.slice(DECISION_PREFIX.length).match(/^(ready|waiting|approval|retry|manual|stale)\. ([\s\S]+)$/);
  return match ? { state: match[1], reason: match[2] } : undefined;
}

async function recheckHeldPullRequests({ github, context, core, now = Date.now() }) {
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: "dependency-check.yml" });
  const pulls = await github.paginate(github.rest.pulls.list, { ...context.repo, state: "open", per_page: 100 });
  const repository = context.repo.owner + "/" + context.repo.repo;
  for (const pr of pulls.filter(candidate => isDependabotPullRequest(candidate, repository))) {
    try {
      const run = await findLatestValidationRun({
        github, context, workflowId: workflow.id, branch: pr.head.ref, headSha: pr.head.sha,
      });
      async function isCurrent() {
        const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
        if (!isDependabotPullRequest(current, repository) || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) return false;
        const latest = await findLatestValidationRun({ github, context, workflowId: workflow.id, branch: pr.head.ref, headSha: pr.head.sha });
        return latest?.id === run?.id && latest?.run_attempt === run?.run_attempt && latest?.status === run?.status;
      }
      async function report(state, reason) {
        if (!await isCurrent()) return;
        await publishPolicyStatus({ github, context, core, sha: pr.head.sha, url: run?.html_url || pr.html_url, state, reason });
      }
      if (!run) {
        await report("failure", "No validation found for this commit. Rebase or reopen the PR to start validation.");
        continue;
      }
      if (!EVENTS.includes(run.event) || run.status !== "completed" || run.head_sha !== pr.head.sha) continue;
      if (run.conclusion === "cancelled") {
        await report("failure", "Validation was cancelled. Rerun all jobs to complete the release policy and project checks.");
        continue;
      }
      const testedBase = run.pull_requests?.find(item => item.number === pr.number)?.base?.sha;
      if (testedBase !== pr.base.sha) {
        await report("failure", "The base branch changed. Rebase the PR to validate the current base; rerunning the old run cannot refresh it.");
        continue;
      }
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo, run_id: run.id, filter: "latest", per_page: 100,
      });
      if (jobs.some(job => VALIDATION_JOBS.includes(job.name) && ["failure", "timed_out"].includes(job.conclusion))) {
        await report("failure", "Project validation failed. The PR and branch remain open. Fix the failure, then rerun validation.");
        continue;
      }
      const gate = jobs.find(job => job.name === POLICY_JOB);
      if (!gate) {
        await report("failure", "This run uses an older workflow. Rebase the PR to use the current dependency checks.");
        continue;
      }
      const decision = readPolicyDecision(gate);
      if (decision && ["manual", "stale", "approval"].includes(decision.state)) {
        await report(policyStatus(decision.state), decision.reason);
        continue;
      }
      if (!decision && gate.conclusion === "success") {
        await report("failure", "The policy result is unavailable. Rebase the PR to use the current dependency workflow.");
        continue;
      }
      let retry = ["waiting", "retry"].includes(decision?.state) || ["failure", "timed_out"].includes(gate.conclusion);
      if (decision?.state === "ready") {
        const { data } = await github.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: pr.head.sha });
        retry = data.statuses.some(status => status.context === "Dependency release policy" &&
          status.state === "pending" && status.description?.startsWith(FINAL_RETRY_PREFIX));
      }
      if (!retry) continue;
      if (run.run_attempt >= 50 || !Number.isFinite(Date.parse(run.created_at)) || now - Date.parse(run.created_at) >= 30 * DAY_MS) {
        await report("failure", "Automatic retries reached GitHub's age or attempt limit. Reopen the PR to start a fresh validation run.");
        continue;
      }
      if (!await isCurrent()) continue;
      await github.rest.actions.reRunWorkflow({ ...context.repo, run_id: run.id });
      await report("pending", "Automatic retry requested. Release policy and project validation will run again.");
      core.info("Rechecking held Dependabot PR #" + pr.number + ".");
    } catch (error) {
      core.warning("PR #" + pr.number + " could not be rechecked: " + error.message);
      core.setFailed("A Dependabot PR could not be rechecked. See the job log for the error and retry this workflow.");
    }
  }
}

module.exports = {
  POLICY_JOB, DECISION_PREFIX, FINAL_RETRY_PREFIX, VALIDATION_JOBS, EVENTS, MINIMUM_AGE_DAYS, IGNORED_RUN,
  isDependabotPullRequest, parseNpmLock, parseYarnLock, findNewReleases,
  inspectReleases, reviewedUrgency, checkReleaseAge, recheckHeldPullRequests,
  affectedProjects, findLatestValidationRun, publishPolicyStatus, policyStatus, readPolicyDecision,
};
