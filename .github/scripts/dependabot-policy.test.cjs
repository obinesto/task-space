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
  assert.equal((await f.run()).state, "held"); assert.equal(f.outputs.ready, "false");
});
test("new transitive versions must also mature", async () => {
  const f = gateFixture();
  f.after = lock({ "node_modules/foo": entry("1.0.1"), "node_modules/foo/node_modules/foo": entry("2.0.0") });
  f.metadata.time["2.0.0"] = new Date(NOW - 8 * DAY).toISOString();
  f.metadata.versions["2.0.0"] = { dist: { tarball: entry("2.0.0").resolved } };
  assert.equal((await f.run()).state, "ready");
  f.metadata.time["2.0.0"] = new Date(NOW - DAY).toISOString();
  assert.equal((await f.run()).state, "held"); assert.equal(f.registryCalls, 2);
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
  const f = gateFixture(); mutate(f); assert.equal((await f.run()).state, "held"); assert.equal(f.outputs.ready, "false");
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
  const f = gateFixture(); approve(f); mutate(f); assert.equal((await f.run()).state, "held");
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
    pr, run, eventRun: structuredClone(run), jobs: policy.VALIDATION_JOBS.map(name => ({ name, conclusion: "success", steps: [{ name: policy.APPROVED_STEP, conclusion: "success" }] })),
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
      repos: { get: async () => ({ data: { allow_squash_merge: true } }), createCommitStatus: async args => { f.statuses.push(args); } },
      git: { getRef: async () => ({ data: { object: { sha: f.branchSha } } }), deleteRef: async args => { f.writes.push(["delete", args]); } },
    }, paginate: async name => name === "pulls" ? [f.pr] : f[name]
  };
  f.context = { repo: { owner: "owner", repo: "repo" }, payload: { workflow_run: f.eventRun } };
  f.core = { info: message => f.messages.push(message), warning: message => f.messages.push(message), setFailed: message => f.messages.push(message) };
  f.exec = { getExecOutput: async (command, args) => { assert.equal(command, "gh"); assert.equal(f.statuses.at(-1)?.state, "success", "release status must clear before watching checks"); f.checks++; return args.includes("--json") ? f.report : { exitCode: f.checkExit }; } };
  return f;
}

test("resolver preserves successful merges, failure cleanup and holds", async () => {
  const original = policy.checkReleaseAge;
  try {
    const scenarios = [
      ["success", () => { }, ["approve", "merge", "delete"]],
      ["held peer policy", f => { f.jobs[0].steps[0].conclusion = "skipped"; }, []],
      ["held project policy", f => { f.jobs[1].steps[0].conclusion = "skipped"; }, []],
      ["withdrawn urgent approval", f => { f.gate = "held"; }, []],
      ["review event", f => { f.run.event = "pull_request_review"; }, ["approve", "merge", "delete"]],
      ["unrelated event", f => { f.run.display_title = policy.IGNORED_RUN; }, []],
      ["newer unrelated queued run", f => { f.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ id: 11, display_title: policy.IGNORED_RUN, status: "queued" }, { id: 10 }] } }); }, ["approve", "merge", "delete"]],
      ["unsupported pnpm lockfile", f => { f.files[0].filename = "pnpm-lock.yaml"; }, []],
      ["failed peer install", f => { f.run.conclusion = "failure"; f.jobs[0].conclusion = "failure"; }, ["close", "delete"]],
      ["failed build", f => { f.run.conclusion = "failure"; f.jobs[1].conclusion = "failure"; }, ["close", "delete"]],
      ["failure before age approval", f => { f.run.conclusion = "failure"; f.jobs[1].conclusion = "failure"; f.jobs[1].steps[0].conclusion = "skipped"; }, []],
      ["external failed check", f => { f.checkExit = 1; }, ["close", "delete"]],
      ["API check error", f => { f.checkExit = 1; f.report = { exitCode: 2, stdout: "error" }; }, []],
      ["cancelled run", f => { f.run.conclusion = "cancelled"; }, []],
      ["stale commit", f => { f.pr = { ...f.pr, head: { ...f.pr.head, sha: "new" } }; }, []],
      ["newer validation", f => { f.recentId = 11; }, []],
      ["changed base", f => { f.current = { ...f.pr, base: { ...f.pr.base, sha: "new" } }; }, []],
      ["merge refused", f => { f.mergeAllowed = false; }, ["approve", "merge"]],
      ["branch advanced", f => { f.branchSha = "new"; }, ["approve", "merge"]],
    ];
    for (const [name, mutate, expected] of scenarios) {
      const f = resolverFixture(); mutate(f); policy.checkReleaseAge = async () => ({ state: f.gate });
      await resolvePullRequest(f); assert.deepEqual(f.writes.map(write => write[0]), expected, name);
      if (name.startsWith("held") || name === "withdrawn urgent approval") {
        assert.equal(f.statuses.at(-1)?.state, "pending", name);
        assert.equal(f.checks, 0, name);
      }
    }
  } finally { policy.checkReleaseAge = original; }
});

test("scheduler rechecks only a held current run with a matching tested base", async () => {
  for (const kind of ["held", "ready", "old-workflow", "new-base", "running", "failed", "expired", "max-attempts", "ignored-newer-run"]) {
    const pr = gateFixture().pr;
    const run = {
      id: 10, event: "pull_request", status: "completed", conclusion: "success", head_sha: "head", run_attempt: 1,
      created_at: new Date(NOW - 2 * DAY).toISOString(), pull_requests: [{ number: 7, base: { sha: "base" } }]
    };
    const jobs = [{ name: "Peer dependency check", conclusion: "success", steps: [{ name: policy.APPROVED_STEP, conclusion: "skipped" }] }];
    if (kind === "ready") jobs[0].steps[0].conclusion = "success";
    if (kind === "old-workflow") jobs[0].steps = [];
    if (kind === "new-base") run.pull_requests[0].base.sha = "old";
    if (kind === "running") run.status = "in_progress";
    if (kind === "failed") run.conclusion = "failure";
    if (kind === "expired") run.created_at = new Date(NOW - 31 * DAY).toISOString();
    if (kind === "max-attempts") run.run_attempt = 50;
    let reruns = 0;
    const github = {
      rest: {
        actions: {
          getWorkflow: async () => ({ data: { id: 20 } }), listWorkflowRuns: async () => ({ data: { workflow_runs: kind === "ignored-newer-run" ? [{ id: 11, display_title: policy.IGNORED_RUN }, run] : [run] } }),
          listJobsForWorkflowRun: "jobs", reRunWorkflow: async () => { reruns++; }
        }, pulls: { list: "pulls" }
      }, paginate: async name => name === "pulls" ? [pr] : jobs
    };
    await policy.recheckHeldPullRequests({ github, context: { repo: { owner: "owner", repo: "repo" } }, core: { info() { }, warning() { } }, now: NOW });
    assert.equal(reruns, ["held", "ignored-newer-run"].includes(kind) ? 1 : 0, kind);
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
  assert.ok(!Object.hasOwn(f.outputs, "policy-state"));
  f.metadata = metadata(1);
  assert.equal((await run()).state, "held");
  assert.deepEqual(JSON.parse(f.outputs.projects), []);
  f.metadata = metadata();
  f.github.rest.repos.getContent = async args => args.path.endsWith("package-lock.json") ? originalRead(args) : Promise.reject(new Error("manifest unavailable"));
  assert.equal((await run()).state, "held");
  assert.deepEqual(JSON.parse(f.outputs.projects), []);
});

test("helper imports only Node built-ins and performs no dependency installation", () => {
  const source = fs.readFileSync(path.join(__dirname, "dependabot-policy.cjs"), "utf8");
  assert.ok(!source.includes("child_process"));
  assert.ok(!source.includes("npm install"));
});
