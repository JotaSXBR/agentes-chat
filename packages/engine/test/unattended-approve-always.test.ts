import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  type ApprovalLevel,
  COMPOSIO_EXECUTOR,
  createAgentRuns,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  ForbiddenError,
  type InvokeResult,
  insertMessage,
  lowRisk,
  postPersonMessage,
  REVIEW_NO_APPROVAL,
  reviewKind,
  setAgentScopes,
  type ToolContext,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "The checks passed on this pull request and the reviewer asked for a short note on it.";
const PR = { owner: "acme", repo: "app", pullNumber: 7 };
const EXECUTOR = `composio_${COMPOSIO_EXECUTOR}`;

async function world(level?: ApprovalLevel) {
  f = await setup();
  const github = fakeGithubMcp({ writes: true });
  const deps = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://agentes.test", connect: github.connect };
  const connection = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "ghp_fake_key_for_tests",
  });
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    ["github:issues.write", "github:pr.write", "github:pr.merge"].map((scope) => ({
      connectionId: connection.id,
      scope,
    })),
  );
  const gateway = createToolGateway({
    sources: [createConnectorToolSource(deps)],
    ...(level ? { approvalLevel: async () => level } : {}),
  });
  return { github, gateway, connectionId: connection.id };
}

const contextOf = (run: { id: string; threadRootId: string; triggerMessageId: string }): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: f.agent.id,
  runId: run.id,
  channelId: f.general.id,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

/** A run a routine's report woke: the chain of a watcher routine handing work on, with nobody behind it. */
async function fedRun() {
  const by = { orgId: f.org.id, channelId: f.general.id };
  const fired = await insertMessage(f.db, {
    ...by,
    author: { type: "person", userId: f.owner.id },
    body: "Watch the open pull requests",
    meta: { routineBrief: { routineId: crypto.randomUUID() } },
  });
  const [routineRun] = await f.db.transaction((tx) =>
    createAgentRuns(tx, fired as never, [f.agent.id], "mention", { background: true }),
  );
  const report = await insertMessage(f.db, {
    ...by,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "PR 7 is green: leave a note and update its description",
    meta: { notice: { kind: "routine_handoff", text: "x", from: "Routine", refs: { runId: routineRun?.id } } },
  });
  const [woken] = await f.db.transaction((tx) => createAgentRuns(tx, report as never, [f.agent.id], "mention", {}));
  if (!woken) throw new Error("no run");
  return contextOf(woken);
}

async function personRun() {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "review PR 7 please",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return contextOf(run);
}

const call = (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext, name: string, input: object) =>
  gateway.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input: input as Record<string, unknown> });

function asked(result: InvokeResult) {
  if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
  return result.approval;
}

const approveForGood = (approvalId: string) =>
  decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approvalId, {
    decision: "approve",
    always: true,
  });

describe("what isn't high risk", () => {
  test("comments, pull request updates and reviews; never merges, sends or deletions, by the tool or an action", () => {
    expect(lowRisk({ name: "github_add_issue_comment", scope: "github:issues.write" })).toBe(true);
    expect(lowRisk({ name: "github_update_pull_request", scope: "github:pr.write" })).toBe(true);
    expect(lowRisk({ name: "github_pull_request_review_write", scope: "github:pr.write" })).toBe(true);
    expect(lowRisk({ name: "github_merge_pull_request", scope: "github:pr.merge" })).toBe(false);
    expect(lowRisk({ name: "github_delete_repository", scope: "github:repo.admin" })).toBe(false);
    expect(lowRisk({ name: EXECUTOR, scope: "custom:x:write" }, ["GITHUB_CREATE_AN_ISSUE_COMMENT"])).toBe(true);
    expect(lowRisk({ name: EXECUTOR, scope: "custom:x:write" }, ["SLACK_SEND_MESSAGE"])).toBe(false);
  });

  test("a review is that kind when it comments, asks for changes or is a draft; one that approves never is", () => {
    expect(reviewKind({ method: "create", event: "COMMENT" })).toBe(REVIEW_NO_APPROVAL);
    expect(reviewKind({ method: "submit_pending", event: "REQUEST_CHANGES" })).toBe(REVIEW_NO_APPROVAL);
    expect(reviewKind({ method: "create" })).toBe(REVIEW_NO_APPROVAL);
    expect(reviewKind({ method: "create", event: "APPROVE" })).toBeNull();
    expect(reviewKind({ method: "submit_pending", event: "APPROVE" })).toBeNull();
    expect(reviewKind({ method: "submit_pending" })).toBeNull();
    expect(reviewKind({ method: "delete_pending" })).toBeNull();
    expect(reviewKind({ method: "create", event: "approve" })).toBeNull();
  });
});

describe("Aprovar sempre on work a routine's report woke", () => {
  test("a comment and a pull request's update offer it; approved for good, the next ones run without a card", async () => {
    const { github, gateway, connectionId } = await world();
    const ctx = await fedRun();
    const comment = asked(
      await call(gateway, ctx, "github_add_issue_comment", { ...PR, issue_number: 7, body: "ok", why: WHY }),
    );
    expect(comment.origin).toEqual({ kind: "unattended" });
    expect(comment.approveAlways).toEqual({ tool: "add_issue_comment", actions: [] });
    const update = asked(
      await call(gateway, ctx, "github_update_pull_request", { ...PR, body: "Fixes the login", why: WHY }),
    );
    expect(update.approveAlways).toEqual({ tool: "update_pull_request", actions: [] });

    await approveForGood(comment.id);
    await approveForGood(update.id);
    expect((await f.db.select().from(schema.approvalRules)).map((r) => [r.connectionId, r.tool, r.action])).toEqual([
      [connectionId, "add_issue_comment", ""],
      [connectionId, "update_pull_request", ""],
    ]);

    // The next run the routine's chain wakes comments and updates with no card and no reason asked.
    const next = await fedRun();
    expect((await call(gateway, next, "github_add_issue_comment", { ...PR, issue_number: 8, body: "ok" })).type).toBe(
      "result",
    );
    expect((await call(gateway, next, "github_update_pull_request", { ...PR, title: "Fix login" })).type).toBe(
      "result",
    );
    expect(github.calls.map((c) => c.tool)).toEqual(["add_issue_comment", "update_pull_request"]);
    // Updating the branch is a kind of its own: it still asks, and offers it too.
    const branch = asked(await call(gateway, next, "github_update_pull_request_branch", { ...PR, why: WHY }));
    expect(branch.approveAlways).toEqual({ tool: "update_pull_request_branch", actions: [] });
  });

  test("a merge never offers it there, and a rule someone put in the table doesn't cover it", async () => {
    const { github, gateway, connectionId } = await world();
    const ctx = await fedRun();
    await f.db.insert(schema.approvalRules).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId,
      tool: "merge_pull_request",
      action: "",
    });
    const merge = asked(await call(gateway, ctx, "github_merge_pull_request", { ...PR, why: WHY }));
    expect(merge.approveAlways).toBeNull();
    expect(github.calls).toEqual([]);
  });

  test("a review that comments offers it on any run; one that approves asks every time, rule or not", async () => {
    const { github, gateway } = await world();
    const ctx = await personRun();
    const review = (event: string, why?: string) =>
      call(gateway, ctx, "github_pull_request_review_write", {
        ...PR,
        method: "create",
        event,
        body: "Looks right",
        ...(why ? { why } : {}),
      });
    const commenting = asked(await review("COMMENT", WHY));
    expect(commenting.approveAlways).toEqual({ tool: "pull_request_review_write", actions: [REVIEW_NO_APPROVAL] });
    const approving = asked(await review("APPROVE", WHY));
    expect(approving.approveAlways).toBeNull();

    await approveForGood(commenting.id);
    expect((await review("REQUEST_CHANGES")).type).toBe("result");
    expect(asked(await review("APPROVE", WHY)).approveAlways).toBeNull();
    expect(github.calls.map((c) => c.args.event)).toEqual(["REQUEST_CHANGES"]);

    // Work a routine's report woke: the kind approved for good covers it too, an approving review still asks.
    const fed = await fedRun();
    const fedReview = (event: string) =>
      call(gateway, fed, "github_pull_request_review_write", { ...PR, method: "create", event, why: WHY });
    expect((await fedReview("COMMENT")).type).toBe("result");
    expect(asked(await fedReview("APPROVE")).approveAlways).toBeNull();
    expect(github.calls.map((c) => c.args.event)).toEqual(["REQUEST_CHANGES", "COMMENT"]);
  });
});

describe("an agent's approval level (a hook, no setting yet)", () => {
  test("at risky, a low-risk write runs without a card and without a reason; a merge still asks", async () => {
    const { github, gateway } = await world("risky");
    const ctx = await fedRun();
    expect((await call(gateway, ctx, "github_add_issue_comment", { ...PR, issue_number: 7, body: "ok" })).type).toBe(
      "result",
    );
    expect(asked(await call(gateway, ctx, "github_merge_pull_request", { ...PR, why: WHY })).tool).toBe(
      "github_merge_pull_request",
    );
    expect(github.calls.map((c) => c.tool)).toEqual(["add_issue_comment"]);
  });

  test("without a level, the same comment asks as before", async () => {
    const { github, gateway } = await world();
    const ctx = await fedRun();
    expect(
      (await call(gateway, ctx, "github_add_issue_comment", { ...PR, issue_number: 7, body: "ok", why: WHY })).type,
    ).toBe("approval");
    expect(github.calls).toEqual([]);
  });
});

describe("Sempre neste repositório", () => {
  test("a merge card offers it; approved, the repository joins the list and its next merges need no card", async () => {
    const { github, gateway } = await world();
    const ctx = await personRun();
    const first = asked(await call(gateway, ctx, "github_merge_pull_request", { ...PR, why: WHY }));
    expect(first.approveAlways).toEqual({ tool: "github_merge_pull_request", actions: [], repo: "acme/app" });
    await approveForGood(first.id);
    const [agent] = await f.db.select({ repos: schema.agents.mergeRepos }).from(schema.agents);
    expect(agent?.repos).toEqual(["acme/app"]);
    const audits = await f.db.select().from(schema.auditLog);
    expect(audits.find((a) => a.action === "agent.merge_repositories_changed")?.details).toEqual({
      repositories: ["acme/app"],
      via: "approval",
    });
    // No rule: the list is the only thing it changed.
    expect(await f.db.select().from(schema.approvalRules)).toEqual([]);

    expect((await call(gateway, ctx, "github_merge_pull_request", { ...PR, pullNumber: 8 })).type).toBe("result");
    expect(github.calls.map((c) => [c.tool, c.args.pullNumber])).toEqual([["merge_pull_request", 8]]);
    // Another repository asks, offering its own.
    const other = asked(await call(gateway, ctx, "github_merge_pull_request", { ...PR, repo: "api", why: WHY }));
    expect(other.approveAlways).toEqual({ tool: "github_merge_pull_request", actions: [], repo: "acme/api" });
  });

  test("only the agent's owner or an admin keeps it: a member can't even decide the merge", async () => {
    const { gateway } = await world();
    const card = asked(await call(gateway, await personRun(), "github_merge_pull_request", { ...PR, why: WHY }));
    const decide = (userId: string) =>
      decideApproval({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, card.id, { decision: "approve", always: true });
    const repos = async () => (await f.db.select({ repos: schema.agents.mergeRepos }).from(schema.agents))[0]?.repos;

    await expect(decide((await addMember(f.db, f.org.id, "member", "bia")).id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await repos()).toEqual([]);
    await decide((await addMember(f.db, f.org.id, "admin", "caio")).id);
    expect(await repos()).toEqual(["acme/app"]);
  });

  test("never on work a routine's report woke: the list doesn't apply there", async () => {
    const { gateway } = await world();
    const merge = asked(await call(gateway, await fedRun(), "github_merge_pull_request", { ...PR, why: WHY }));
    expect(merge.approveAlways).toBeNull();
  });

  test("a merge on the computer offers it only when the command names its repository", async () => {
    f = await setup();
    const ran: string[] = [];
    const computer = {
      name: "computer",
      async tools() {
        return [
          {
            name: "run_code",
            description: "Run code",
            scope: "sandbox:run",
            whyAsks: true,
            inputSchema: {
              type: "object" as const,
              properties: { language: { type: "string" }, code: { type: "string" }, why: { type: "string" } },
              required: ["language", "code"],
            },
            rememberCommand: (input: Record<string, unknown>) => String(input.code),
            async execute(input: Record<string, unknown>) {
              ran.push(String(input.code));
              return { content: "ok" };
            },
          },
        ];
      },
    };
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    const gateway = createToolGateway({ sources: [computer] });
    const ctx = await personRun();
    const bash = (code: string) => ({ language: "bash", code, why: WHY });
    const named = asked(await call(gateway, ctx, "run_code", bash("gh pr merge 7 -R acme/app --squash")));
    expect(named.approveAlways).toEqual({ tool: "run_code", actions: [], repo: "acme/app" });
    expect(asked(await call(gateway, ctx, "run_code", bash("gh pr merge 7 --squash"))).approveAlways).toBeNull();
    await approveForGood(named.id);
    // The computer decides the next one in that repository (here, it just runs).
    expect((await call(gateway, ctx, "run_code", bash("gh pr merge 9 -R acme/app"))).type).toBe("result");
    expect(ran).toEqual(["gh pr merge 9 -R acme/app"]);
  });
});
