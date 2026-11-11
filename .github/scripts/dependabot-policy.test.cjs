"use strict";
/* global require, __dirname */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { test } = require("node:test");
const policy = require("./dependabot-policy.cjs");
const { resolvePullRequest } = require("./resolve-dependabot.cjs");

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 7);
const entry = (version, extra = {}) => ({ version, resolved: "https://registry.npmjs.org/foo/-/foo-" + version + ".tgz", ...extra });
const lock = packages => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } });
const oldLock = lock({ "node_modules/foo": entry("1.0.0") });
const newLock = lock({ "node_modules/foo": entry("1.0.1") });
const metadata = (age = 8) => ({ time: { "1.0.1": new Date(NOW - age * DAY).toISOString() }, versions: { "1.0.1": { dist: { tarball: entry("1.0.1").resolved } } } });

function gateFixture() {
  const pr = {
    number: 7, state: "open", draft: false, labels: [], user: { login: "dependabot[bot]" },
    head: { ref: "dependabot/npm/foo", sha: "head", repo: { full_name: "owner/repo" } },
    base: { ref: "main", sha: "base", repo: { full_name: "owner/repo" } }
  };
  const f = {
    pr, event: structuredClone(pr), eventName: "pull_request", files: [{ filename: "package-lock.json", status: "modified" }],
    before: oldLock, after: newLock, metadata: metadata(), reviews: [], permission: "write", outputs: {}, messages: [], registryCalls: 0
  };
  f.github = {
    rest: {
      pulls: { get: async () => ({ data: f.pr }), listFiles: "files", listReviews: "reviews" },
      repos: {
        getContent: async args => ({ data: { encoding: "base64", content: Buffer.from(args.ref === "base" ? f.before : f.after).toString("base64") } }),
        getCollaboratorPermissionLevel: async () => ({ data: { permission: f.permission } })
      },
    }, paginate: async name => f[name]
  };
  f.context = { repo: { owner: "owner", repo: "repo" }, eventName: f.eventName, payload: { pull_request: f.event } };
  f.core = { setOutput: (key, value) => { f.outputs[key] = value; }, info: message => f.messages.push(message) };
  f.run = () => policy.checkReleaseAge({
    github: f.github, context: f.context, core: f.core, now: NOW,
    fetchMetadata: async () => { f.registryCalls++; if (f.registryError) throw new Error("registry unavailable"); return f.metadata; }
  });
  return f;
}

test("npm v3 finds new direct and nested versions without executing packages", () => {
  const before = policy.parseNpmLock(oldLock);
  const after = policy.parseNpmLock(lock({
    "node_modules/foo": entry("1.0.1"),
    "node_modules/foo/node_modules/foo": entry("1.0.1")
  }));
  assert.equal(policy.findNewReleases(before, after).length, 1);
  assert.equal(policy.parseNpmLock(lock({ "node_modules/foo": { link: true }, "node_modules/bar": { inBundle: true } })).length, 0);
});
test("npm v1 nested dependencies and scoped aliases are parsed", () => {
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { foo: { ...entry("1.0.0"), dependencies: { foo: entry("1.0.1") } } } });
  assert.equal(policy.parseNpmLock(v1).length, 2);
  const scoped = policy.parseNpmLock(lock({ "node_modules/alias": { version: "2.0.0", resolved: "https://registry.npmjs.org/@scope/name/-/name-2.0.0.tgz" } }));
  assert.equal(scoped[0].name, "@scope/name");
});
test("unsupported npm versions and malformed lockfiles are held", () => {
  assert.throws(() => policy.parseNpmLock('{"lockfileVersion":4}'));
  assert.throws(() => policy.parseNpmLock("{"));
  assert.throws(() => policy.parseNpmLock(lock({ "node_modules/foo": {} })));
});
test("Yarn Classic grouped selectors, scopes and integrity are parsed", () => {
  const yarn = '# yarn lockfile v1\n\n"@scope/name@^2", "@scope/name@~2":\n  version "2.0.0"\n  resolved "https://registry.yarnpkg.com/@scope/name/-/name-2.0.0.tgz"\n  integrity sha512-example\n  dependencies:\n    foo "^1"\n';
  const result = policy.parseYarnLock(yarn);
  assert.equal(result.length, 1); assert.equal(result[0].name, "@scope/name");
  assert.equal(result[0].integrity, "sha512-example");
  assert.throws(() => policy.parseYarnLock("__metadata:\n  version: 8"));
  assert.throws(() => policy.parseYarnLock("# yarn lockfile v1\nfoo:\n  resolved \"x\""));
});
test("existing non-registry dependencies are not newly adopted", () => {
  const text = lock({ "node_modules/foo": { version: "git-sha", resolved: "git+https://example.test/foo" } });
  const entries = policy.parseNpmLock(text);
  assert.ok(entries[0].unsupported);
  assert.equal(policy.findNewReleases(entries, entries).length, 0);
});
test("exactly seven days is eligible; younger versions are held", async () => {
  const f = gateFixture(); f.metadata = metadata(7);
  assert.equal((await f.run()).state, "ready");
  f.metadata = metadata(7 - 1 / DAY);
  assert.notEqual((await f.run()).state, "ready"); assert.notEqual(f.outputs.state, "ready");
});
test("new transitive versions must also mature", async () => {
  const f = gateFixture();
  f.after = lock({ "node_modules/foo": entry("1.0.1"), "node_modules/foo/node_modules/foo": entry("2.0.0") });
  f.metadata.time["2.0.0"] = new Date(NOW - 8 * DAY).toISOString();
  f.metadata.versions["2.0.0"] = { dist: { tarball: entry("2.0.0").resolved } };
  assert.equal((await f.run()).state, "ready");
  f.metadata.time["2.0.0"] = new Date(NOW - DAY).toISOString();
  assert.notEqual((await f.run()).state, "ready"); assert.equal(f.registryCalls, 2);
});
for (const [name, mutate] of Object.entries({
  "missing publication date": f => { f.metadata.time = {}; },
  "future publication date": f => { f.metadata = metadata(-1); },
  "missing registry version": f => { f.metadata.versions = {}; },
  "mismatched registry tarball": f => { f.metadata.versions["1.0.1"].dist.tarball = entry("2.0.0").resolved; },
  "missing registry tarball": f => { delete f.metadata.versions["1.0.1"].dist.tarball; },
  "registry outage": f => { f.registryError = true; },
  "integrity mismatch": f => { f.after = lock({ "node_modules/foo": entry("1.0.1", { integrity: "sha512-old" }) }); f.metadata.versions["1.0.1"].dist.integrity = "sha512-other"; },
  "non-registry tarball": f => { f.after = lock({ "node_modules/foo": entry("1.0.1", { resolved: "https://example.test/foo.tgz" }) }); },
  "plain HTTP tarball": f => { f.after = lock({ "node_modules/foo": entry("1.0.1", { resolved: "http://registry.npmjs.org/foo/-/foo.tgz" }) }); },
  "untrusted source changes": f => { f.files.push({ filename: ".github/scripts/policy.cjs", status: "modified" }); },
  "manifest without changed lockfile": f => { f.files = [{ filename: "package.json", status: "modified" }]; },
  "removed lockfile": f => { f.files[0].status = "removed"; },
  "renamed lockfile": f => { f.files[0].status = "renamed"; },
  "human PR": f => { f.pr.user.login = "human"; },
  "fork PR": f => { f.pr.head.repo.full_name = "fork/repo"; },
  "draft PR": f => { f.pr.draft = true; },
  "new head commit": f => { f.pr.head.sha = "new"; },
  "new base commit": f => { f.pr.base.sha = "new"; },
  "uncertain urgency": f => { f.pr.labels = [{ name: "security-urgency:uncertain" }]; },
  "conflicting urgency": f => { f.pr.labels = [{ name: "security-urgency:urgent" }, { name: "security-urgency:standard" }]; },
})) test(name + " is held without failing or installing", async () => {
  const f = gateFixture(); mutate(f); assert.notEqual((await f.run()).state, "ready"); assert.notEqual(f.outputs.state, "ready");
});

function approve(f, extra = {}) {
  f.pr.labels = [{ name: "security-urgency:urgent" }]; f.metadata = metadata(1);
  f.reviews = [{ state: "APPROVED", commit_id: "head", body: "Reachable exploit affects production. Urgent patch reviewed.", user: { login: "reviewer", type: "User" }, ...extra }];
}
test("urgent and emergency fixes require a written human approval of the exact commit", async () => {
  const f = gateFixture(); approve(f); assert.equal((await f.run()).state, "ready");
  f.pr.labels = [{ name: "security-urgency:emergency" }]; assert.equal((await f.run()).state, "ready");
});
for (const [name, mutate] of Object.entries({
  "no approval": f => { f.reviews = []; },
  "old commit approval": f => { f.reviews[0].commit_id = "old"; },
  "empty justification": f => { f.reviews[0].body = " "; },
  "bot approval": f => { f.reviews[0].user.type = "Bot"; },
  "read-only reviewer": f => { f.permission = "read"; },
  "dismissed approval": f => { f.reviews.push({ ...f.reviews[0], state: "DISMISSED" }); },
  "requested changes": f => { f.reviews.push({ state: "CHANGES_REQUESTED", user: { login: "other", type: "User" } }); },
  "unverifiable publication date": f => { f.metadata.time = {}; },
})) test("urgent fix with " + name + " stays held", async () => {
  const f = gateFixture(); approve(f); mutate(f); assert.notEqual((await f.run()).state, "ready");
});
test("review events can release the same Dependabot PR", async () => {
  const f = gateFixture(); approve(f); f.context.eventName = "pull_request_review";
  assert.equal((await f.run()).state, "ready");
});

function resolverFixture() {
  const pr = gateFixture().pr;
  const run = {
    id: 10, workflow_id: 20, status: "completed", event: "pull_request", conclusion: "success", run_attempt: 1,
    head_repository: { full_name: "owner/repo" }, head_branch: pr.head.ref, head_sha: "head", pull_requests: [{ number: 7, base: { sha: "base" } }]
  };
  const f = {
    pr, run, eventRun: structuredClone(run), jobs: [{ name: policy.POLICY_JOB, conclusion: "success", steps: [{ name: policy.DECISION_PREFIX + "ready. Specific gate reason", conclusion: "success" }] },
      ...policy.VALIDATION_JOBS.map(name => ({ name, conclusion: "success" }))],
    files: [{ filename: "package-lock.json", status: "modified" }], reviews: [], writes: [], checks: 0,
    gate: "ready", checkExit: 0, report: { exitCode: 1, stdout: '[{"bucket":"fail"}]' }, recentId: 10, branchSha: "head", messages: [], statuses: []
  };
  let gets = 0, runs = 0;
  f.github = {
    rest: {
      actions: { getWorkflow: async () => ({ data: { id: 20 } }), getWorkflowRun: async () => ({ data: runs++ ? f.latestRun || f.run : f.run }), listJobsForWorkflowRun: "jobs", listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: f.recentId }] } }) },
      pulls: {
        list: "pulls", listFiles: "files", listReviews: "reviews", get: async () => ({ data: gets++ ? f.current || f.pr : f.pr }),
        createReview: async args => { f.writes.push(["approve", args]); }, merge: async args => { f.writes.push(["merge", args]); return { data: { merged: f.mergeAllowed !== false } }; },
        update: async args => { f.writes.push(["close", args]); return { data: { ...f.pr, state: "closed", merged: false } }; }
      },
      repos: { get: async () => ({ data: { allow_squash_merge: true } }), createCommitStatus: async args => { f.statuses.push(args); },
        getCombinedStatusForRef: async () => ({ data: { statuses: f.statuses.length ? [f.statuses.at(-1)] : [] } }) },
      git: { getRef: async () => ({ data: { object: { sha: f.branchSha } } }), deleteRef: async args => { f.writes.push(["delete", args]); } },
    }, paginate: async name => name === "pulls" ? [f.pr] : f[name]
  };
  f.context = { repo: { owner: "owner", repo: "repo" }, payload: { workflow_run: f.eventRun } };
  f.core = { info: message => f.messages.push(message), warning: message => f.messages.push(message), setFailed: message => f.messages.push(message) };
  f.exec = { getExecOutput: async (command, args) => { assert.equal(command, "gh"); assert.equal(f.statuses.at(-1)?.state, "success", "release status must clear before watching checks"); f.checks++; return args.includes("--json") ? f.report : { exitCode: f.checkExit }; } };
  return f;
}

test("resolver merges only complete current validations and preserves failed PRs", async () => {
  const original = policy.checkReleaseAge;
  try {
    const scenarios = [
      ["success", () => {}, ["approve", "merge", "delete"]],
      ["held policy", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "waiting. Specific gate reason"; f.gate = "waiting"; f.jobs[1].conclusion = f.jobs[2].conclusion = "skipped"; }, []],
      ["missing project validation", f => { f.jobs[2].conclusion = "skipped"; }, []],
      ["withdrawn urgent approval", f => { f.gate = "approval"; }, []],
      ["final registry outage", f => { f.gate = "retry"; }, []],
      ["final integrity mismatch", f => { f.gate = "manual"; }, []],
      ["review event", f => { f.run.event = "pull_request_review"; }, ["approve", "merge", "delete"]],
      ["unrelated event", f => { f.run.display_title = policy.IGNORED_RUN; }, []],
      ["newer unrelated queued run", f => { f.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ id: 11, display_title: policy.IGNORED_RUN, status: "queued" }, { id: 10 }] } }); }, ["approve", "merge", "delete"]],
      ["unsupported lockfile", f => { f.files[0].filename = "pnpm-lock.yaml"; }, []],
      ["failed peer install", f => { f.run.conclusion = "failure"; f.jobs[1].conclusion = "failure"; }, []],
      ["failed build", f => { f.run.conclusion = "failure"; f.jobs[2].conclusion = "failure"; }, []],
      ["failed build and registry outage", f => { f.run.conclusion = "failure"; f.jobs[2].conclusion = "failure"; f.gate = "retry"; }, []],
      ["policy job failed", f => { f.run.conclusion = "failure"; f.jobs[0].conclusion = "failure"; f.jobs[0].steps = []; }, []],
      ["external failed check", f => { f.checkExit = 1; }, []],
      ["API check error", f => { f.checkExit = 1; f.report = { exitCode: 2, stdout: "error" }; }, []],
      ["cancelled run", f => { f.run.conclusion = "cancelled"; }, []],
      ["stale commit", f => { f.pr = { ...f.pr, head: { ...f.pr.head, sha: "new" } }; }, []],
      ["newer validation", f => { f.recentId = 11; }, []],
      ["newer attempt", f => { f.latestRun = { ...f.run, run_attempt: 2 }; }, []],
      ["changed base", f => { f.current = { ...f.pr, base: { ...f.pr.base, sha: "new" } }; }, []],
      ["reviewer objection", f => { f.reviews = [{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }]; }, []],
      ["merge refused", f => { f.mergeAllowed = false; }, ["approve", "merge"]],
      ["branch advanced", f => { f.branchSha = "new"; }, ["approve", "merge"]],
    ];
    for (const [name, mutate, expected] of scenarios) {
      const f = resolverFixture(); mutate(f);
      let gateCalls = 0;
      policy.checkReleaseAge = async () => { gateCalls++; return { state: f.gate, reason: "Specific policy reason" }; };
      await resolvePullRequest(f);
      assert.deepEqual(f.writes.map(write => write[0]), expected, name);
      if (name.startsWith("failed")) {
        assert.equal(f.statuses.at(-1)?.state, "failure", name);
        assert.match(f.statuses.at(-1).description, /remain open/, name);
        assert.equal(gateCalls, 0, "a later policy error must not obscure " + name);
      }
      if (name === "held policy") {
        assert.equal(f.statuses.at(-1).description, "Specific gate reason");
        assert.equal(gateCalls, 0, "preserve the original hold reason without checking the policy again");
      }
      if (name.startsWith("final") || name === "withdrawn urgent approval") {
        assert.match(f.statuses.at(-1).description, /Policy passed earlier; final verification.*Specific policy reason/, name);
        assert.equal(f.statuses.at(-1).state, name === "final integrity mismatch" ? "failure" : "pending", name);
        assert.equal(f.checks, 0, name);
      }
      if (["newer validation", "newer attempt", "stale commit", "cancelled run"].includes(name)) {
        assert.equal(f.statuses.length, 0, name + " must not overwrite current status");
      }
    }
  } finally { policy.checkReleaseAge = original; }
});

function recheckFixture() {
  const pr = gateFixture().pr;
  const f = {
    pr, run: { id: 10, event: "pull_request", status: "completed", conclusion: "success", head_sha: "head", run_attempt: 1,
      created_at: new Date(NOW - 2 * DAY).toISOString(), pull_requests: [{ number: 7, base: { sha: "base" } }] },
    jobs: [{ name: policy.POLICY_JOB, conclusion: "success", steps: [{ name: policy.DECISION_PREFIX + "waiting. Specific gate reason", conclusion: "success" }] },
      ...policy.VALIDATION_JOBS.map(name => ({ name, conclusion: "skipped" }))],
    reruns: 0, statuses: [], combined: [], errors: [],
  };
  f.github = {
    rest: {
      actions: {
        getWorkflow: async () => ({ data: { id: 20 } }),
        listWorkflowRuns: async () => ({ data: { workflow_runs: f.latest ? [f.latest] : f.run ? [f.run] : [] } }),
        listJobsForWorkflowRun: "jobs", reRunWorkflow: async () => { if (f.retryError) throw new Error("retry unavailable"); f.reruns++; },
      }, pulls: { list: "pulls", get: async () => ({ data: f.current || f.pr }) },
      repos: { createCommitStatus: async args => { f.statuses.push(args); }, getCombinedStatusForRef: async () => ({ data: { statuses: f.statuses.length ? [f.statuses.at(-1)] : f.combined } }) },
    }, paginate: async name => name === "pulls" ? [pr] : f[name],
  };
  f.context = { repo: { owner: "owner", repo: "repo" } };
  f.core = { info() {}, warning() {}, setFailed: reason => f.errors.push(reason) };
  return f;
}

test("scheduler retries holds and transient failures, and flags PRs that need action", async () => {
  const cases = [
    ["release age", () => {}, 1, "pending", /retry requested/],
    ["registry unavailable", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "retry. Specific gate reason"; }, 1, "pending", /retry requested/],
    ["policy job failed", f => { f.jobs[0].conclusion = "failure"; f.jobs[0].steps = []; f.run.conclusion = "failure"; }, 1, "pending", /retry requested/],
    ["waiting approval", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "approval. Specific gate reason"; }, 0, "pending", /Specific gate reason/],
    ["manual review", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "manual. Specific gate reason"; }, 0, "failure", /Specific gate reason/],
    ["missing decision", f => { f.jobs[0].steps = []; }, 0, "failure", /policy result is unavailable/],
    ["ready", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "ready. Specific gate reason"; }, 0],
    ["final verification outage", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "ready. Specific gate reason"; f.combined = [{ context: "Dependency release policy", state: "pending", description: policy.FINAL_RETRY_PREFIX + " Registry unavailable" }]; }, 1, "pending", /retry requested/],
    ["final approval withdrawn", f => { f.jobs[0].steps[0].name = policy.DECISION_PREFIX + "ready. Specific gate reason"; f.combined = [{ context: "Dependency release policy", state: "pending", description: "Policy passed earlier; final verification held. Waiting for approval" }]; }, 0],
    ["new base", f => { f.run.pull_requests[0].base.sha = "old"; }, 0, "failure", /Rebase/],
    ["running", f => { f.run.status = "in_progress"; }, 0],
    ["cancelled", f => { f.run.conclusion = "cancelled"; }, 0, "failure", /cancelled/],
    ["failed build", f => { f.jobs[2].conclusion = "failure"; f.run.conclusion = "failure"; }, 0, "failure", /remain open/],
    ["expired", f => { f.run.created_at = new Date(NOW - 31 * DAY).toISOString(); }, 0, "failure", /Reopen/],
    ["max attempts", f => { f.run.run_attempt = 50; }, 0, "failure", /Reopen/],
    ["old workflow", f => { f.jobs[0].name = "Old job"; }, 0, "failure", /older workflow/],
    ["missing validation", f => { f.run = null; }, 0, "failure", /No validation/],
    ["retry error", f => { f.retryError = true; }, 0],
  ];
  for (const [name, mutate, reruns, state, reason] of cases) {
    const f = recheckFixture(); mutate(f);
    await policy.recheckHeldPullRequests({ ...f, now: NOW });
    assert.equal(f.reruns, reruns, name);
    assert.equal(f.statuses.at(-1)?.state, state, name);
    if (reason) assert.match(f.statuses.at(-1).description, reason, name);
    assert.equal(f.errors.length, name === "retry error" ? 1 : 0, name);
  }
});

test("policy outcomes distinguish release age, approval, manual review, stale commits and verification errors", async () => {
  const cases = [
    ["waiting", f => { f.metadata = metadata(1); }, /Eligible at/],
    ["approval", f => { approve(f); f.reviews = []; }, /written approval/],
    ["retry", f => { f.registryError = true; }, /Verification unavailable/],
    ["manual", f => { f.files.push({ filename: "source.js" }); }, /Manual review required/],
    ["stale", f => { f.pr.base.sha = "changed"; }, /Rebase or reopen/],
  ];
  for (const [state, mutate, reason] of cases) {
    const f = gateFixture(); mutate(f);
    const result = await f.run();
    assert.equal(result.state, state);
    assert.equal(f.outputs.state, state);
    assert.equal(f.outputs.reason, result.reason);
    assert.match(result.reason, reason);
    assert.deepEqual(JSON.parse(f.outputs.projects), []);
  }
});

test("policy approval withdrawn while waiting for other checks prevents merging", async () => {
  const original = policy.checkReleaseAge;
  try {
    const f = resolverFixture();
    policy.checkReleaseAge = async () => ({ state: f.gate, reason: "Waiting for written approval of this commit." });
    const check = f.exec.getExecOutput;
    f.exec.getExecOutput = async (...args) => {
      const result = await check(...args);
      f.gate = "approval";
      return result;
    };
    await resolvePullRequest(f);
    assert.deepEqual(f.writes, []);
    assert.equal(f.statuses.at(-1).state, "pending");
    assert.match(f.statuses.at(-1).description, /Policy passed earlier; final verification held.*written approval/);
  } finally { policy.checkReleaseAge = original; }
});

test("status descriptions are bounded while logs retain the complete reason", async () => {
  const f = resolverFixture();
  const reason = "Manual review required: " + "long detail ".repeat(30);
  await policy.publishPolicyStatus({ ...f, sha: "head", state: "failure", reason });
  assert.equal(f.statuses[0].description.length, 140);
  assert.equal(f.messages.at(-1), reason);
  await policy.publishPolicyStatus({ ...f, sha: "head", state: "failure", reason });
  assert.equal(f.statuses.length, 1, "identical status updates must not be posted again");
});

test("scheduler does not overwrite or retry a validation that changed during inspection", async () => {
  for (const change of ["head", "base", "run", "attempt"]) {
    const f = recheckFixture();
    const paginate = f.github.paginate;
    f.github.paginate = async name => {
      const result = await paginate(name);
      if (name === "jobs") {
        if (change === "head" || change === "base") f.current = { ...f.pr, [change]: { ...f.pr[change], sha: "changed" } };
        else f.latest = { ...f.run, ...(change === "run" ? { id: 11 } : { run_attempt: 2 }) };
      }
      return result;
    };
    await policy.recheckHeldPullRequests({ ...f, now: NOW });
    assert.equal(f.reruns, 0, change);
    assert.equal(f.statuses.length, 0, change);
  }
});

test("latest validation skips unrelated queued runs and searches older pages", async () => {
  const real = { id: 7, display_title: "Dependency validation", status: "in_progress" };
  let calls = 0;
  const github = { rest: { actions: { listWorkflowRuns: async ({ page }) => {
    calls++;
    return { data: { workflow_runs: page === 1 ? Array.from({ length: 100 }, () => ({ display_title: policy.IGNORED_RUN, status: "queued" })) : [real] } };
  } } } };
  assert.equal(await policy.findLatestValidationRun({ github, context: { repo: {} }, workflowId: 1, branch: "dependabot/foo", headSha: "head" }), real);
  assert.equal(calls, 2);
  github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ display_title: policy.IGNORED_RUN }] } });
  assert.equal(await policy.findLatestValidationRun({ github, context: { repo: {} } }), undefined);
});

test("independent projects are selected by exact lockfile directory", () => {
  const projects = ["api", "app", "other"];
  const manifests = Object.fromEntries(projects.map(name => [name, [{ name }]]));
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "app/package-lock.json" }], manifests), ["app"]);
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "app/package-lock.json" }, { filename: "api/package.json" }], manifests), ["api", "app"]);
});

test("local dependents are included transitively across both manifest revisions", () => {
  const projects = ["shared", "api", "app", "other"];
  const manifests = {
    shared: [{ name: "shared" }],
    api: [{ name: "api", optionalDependencies: { shared: "file:../shared" } }, { name: "api" }],
    app: [{ name: "app", devDependencies: { api: "^1.0.0" } }],
    other: [{ name: "other" }],
  };
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "shared/package-lock.json" }], manifests), ["shared", "api", "app"]);
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "app/package-lock.json" }], manifests), ["app"]);
});

test("nested projects stay together without selecting unrelated siblings", () => {
  const projects = ["task_1", "task_4", "task_4/dashboard"];
  const manifests = Object.fromEntries(projects.map(name => [name, [{ name }]]));
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "task_4/dashboard/package-lock.json" }], manifests), ["task_4", "task_4/dashboard"]);
});

test("workspace and unknown dependency boundaries retain full validation", () => {
  const projects = ["a", "b"];
  for (const manifests of [
    { a: [{ name: "a", workspaces: ["*"] }], b: [{ name: "b" }] },
    { a: [{ name: "a", dependencies: { shared: "workspace:*" } }], b: [{ name: "b" }] },
    { a: [{ name: "a", dependencies: { shared: "file:../missing" } }], b: [{ name: "b" }] },
    { a: [{ name: "a" }] },
  ]) assert.deepEqual(policy.affectedProjects(projects, [{ filename: "a/package-lock.json" }], manifests), projects);
  assert.deepEqual(policy.affectedProjects(projects, [{ filename: "package-lock.json" }], {}), projects);
});

test("the gate exposes affected projects only after release approval", async () => {
  const f = gateFixture();
  f.files[0].filename = "app/package-lock.json";
  const originalRead = f.github.rest.repos.getContent;
  f.github.rest.repos.getContent = async args => args.path.endsWith("package-lock.json") ? originalRead(args) :
    { data: { name: args.path.split("/")[0] } };
  const run = () => policy.checkReleaseAge({ github: f.github, context: f.context, core: f.core, now: NOW,
    projects: ["api", "app"], fetchMetadata: async () => f.metadata });
  assert.equal((await run()).state, "ready");
  assert.deepEqual(JSON.parse(f.outputs.projects), ["app"]);
  assert.equal(f.outputs.state, "ready");
  f.metadata = metadata(1);
  assert.notEqual((await run()).state, "ready");
  assert.deepEqual(JSON.parse(f.outputs.projects), []);
  f.metadata = metadata();
  f.github.rest.repos.getContent = async args => args.path.endsWith("package-lock.json") ? originalRead(args) : Promise.reject(new Error("manifest unavailable"));
  assert.notEqual((await run()).state, "ready");
  assert.deepEqual(JSON.parse(f.outputs.projects), []);
});

test("helper imports only Node built-ins and performs no dependency installation", () => {
  const source = fs.readFileSync(path.join(__dirname, "dependabot-policy.cjs"), "utf8");
  assert.ok(!source.includes("child_process"));
  assert.ok(!source.includes("npm install"));
});
