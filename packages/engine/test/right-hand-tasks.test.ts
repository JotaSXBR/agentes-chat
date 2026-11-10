import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  absorbToolData,
  createAgent,
  createIssueToolSource,
  createToolGateway,
  grantScopes,
  insertMessage,
  issueWorkBrief,
  listIssues,
  openPersonAgentDm,
  pumpTasks,
  RIGHT_HAND,
  runAuthorityById,
  setAgentAudience,
  startHeldTasks,
  type ToolContext,
  type ToolSideEffects,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const { agentRuns, agentConsultations, issues, messages, outbox } = schema;

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in their DM with it. */
async function lodiRun(userId: string, body: string): Promise<ToolContext & { dmId: string }> {
  const lodi = await lodiOf();
  const dm = await openPersonAgentDm(f.db, f.org.id, userId, lodi.id);
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: dm.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
    dmId: dm.id,
  };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const gateway = createToolGateway({ sources: [createIssueToolSource(f.artifactDeps)] });
  const res = await gateway.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output as { content: string; isError?: boolean; data?: Record<string, unknown> };
}

/** The reply a run posts with what its tools gathered (`meta.tasks`: the chips and the card). */
async function reply(ctx: ToolContext, effects: ToolSideEffects) {
  return insertMessage(f.db, {
    orgId: f.org.id,
    channelId: ctx.channelId,
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: 2 },
    body: "Done: the tasks are on the board.",
    meta: { tasks: effects.tasks ?? [] },
  });
}

async function agentOf(name: string, handle: string) {
  return createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Ops", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
}

const pump = () => pumpTasks({ db: f.db, pubsub: f.pubsub, ai: { db: f.db, gateway: f.gateway } }, f.org.id);

describe("tasks people ask the right hand for are a list, not a crowd", () => {
  test("ten tasks from one request start nobody and come back as one card; its go starts them as room frees", async () => {
    f = await setup({ rightHand: true });
    const ops = await agentOf("Ops", "ops");
    const ctx = await lodiRun(f.owner.id, "Make one task per account we're moving to the shared vault");
    const effects: ToolSideEffects = {};
    for (let n = 1; n <= 10; n++) {
      const out = await call(ctx, "create_issue", {
        title: `Move account ${n} to the shared vault`,
        assignee: n % 2 ? "@dev" : "@ops",
      });
      expect(out.isError).toBeFalsy();
      expect(out.content).toContain("Começar estas");
      absorbToolData(effects, out.data);
    }
    // Nobody started: no run, and no hand-off a 15-minute timer could call "never got to it".
    expect(await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id))).toEqual([]);
    expect(await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, ops.id))).toEqual([]);
    expect(await f.db.select().from(agentConsultations)).toEqual([]);
    expect(effects.tasks?.length).toBe(10);
    expect(effects.tasks?.every((t) => t.held)).toBe(true);
    // Nothing waits in a queue before the go either.
    expect((await listIssues(f.db, { type: "person", userId: f.owner.id }, f.org.id)).every((i) => !i.queue)).toBe(
      true,
    );
    expect(await pump()).toBe(0);

    const card = await reply(ctx, effects);
    expect(await startHeldTasks({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, card.id)).toBe(10);
    const [marked] = await f.db.select().from(messages).where(eq(messages.id, card.id));
    expect(marked?.meta.tasksStarted).toMatchObject({ byUserId: f.owner.id });
    // Pressed again (another tab, someone else): nothing more.
    expect(await startHeldTasks({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, card.id)).toBe(0);
    expect((await f.db.select().from(outbox).where(eq(outbox.kind, "tasks.pump"))).length).toBeGreaterThan(0);

    // Each agent takes two at once, on behalf of the person who gave the go.
    expect(await pump()).toBe(4);
    const devRuns = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id));
    expect(devRuns.length).toBe(2);
    expect(await runAuthorityById(f.db, f.org.id, devRuns[0]?.id ?? "")).toEqual({
      kind: "person",
      personId: f.owner.id,
    });
    expect((await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, ops.id))).length).toBe(2);
  });

  test("with an agent's queue off, the go starts its tasks at once, in the person's name", async () => {
    f = await setup({ rightHand: true });
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { tasks: false } })
      .where(eq(schema.agents.id, f.agent.id));
    const ctx = await lodiRun(f.owner.id, "make a task for dev to prepare the holiday campaign");
    const effects: ToolSideEffects = {};
    absorbToolData(effects, (await call(ctx, "create_issue", { title: "Holiday campaign", assignee: "@dev" })).data);
    const card = await reply(ctx, effects);
    expect(await startHeldTasks({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, card.id)).toBe(1);
    const [run] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id));
    const [start] = await f.db
      .select()
      .from(messages)
      .where(eq(messages.id, run?.triggerMessageId ?? ""));
    expect(start?.authorUserId).toBe(f.owner.id);
    expect(start?.meta).toMatchObject({ issueWorkStart: true, bodyCode: "issue_work_start" });
  });

  test("Lodi may keep a task unassigned, and the refusal of its own says so", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id, "note this down for later");
    const none = await call(ctx, "create_issue", { title: "Renew the domain" });
    expect(none.isError).toBeFalsy();
    expect(none.data?.handedTask).toBeUndefined();
    const own = await call(ctx, "create_issue", { title: "Check the invoices", assignee: "me" });
    expect(own.isError).toBe(true);
    expect(own.content).toContain('or to nobody ("none")');
  });

  test("an agent the person can't talk to is refused before any task is made, saying who can let them in", async () => {
    f = await setup({ rightHand: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    const out = await call(await lodiRun(bob.id, "ask dev"), "create_issue", { title: "Something", assignee: "@dev" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("its owner or an admin can let them in");
    expect(await f.db.select().from(issues)).toEqual([]);
  });

  test("a repeat of an open task is refused and points to it; a different one is made", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f.owner.id, "tasks for the access migration");
    const first = await call(ctx, "create_issue", { title: "Migrate the billing access", assignee: "@dev" });
    expect(first.isError).toBeFalsy();
    // Another run: the same work in other words, for the same agent.
    const again = await call(await lodiRun(f.owner.id, "and the billing one"), "create_issue", {
      title: "Migrate billing access",
      assignee: "@dev",
    });
    expect(again.isError).toBe(true);
    expect(again.content).toContain("Not created: this task is already open as #1");
    // The same title, whoever has it.
    expect((await call(ctx, "create_issue", { title: "Migrate the billing access" })).isError).toBe(true);
    expect(
      (await call(ctx, "create_issue", { title: "Migrate the support inbox", assignee: "@dev" })).isError,
    ).toBeFalsy();
    expect((await f.db.select().from(issues)).length).toBe(2);
  });

  test("a task knows where it came from, its parent and what was asked with it, and its agent sees those", async () => {
    f = await setup({ rightHand: true });
    await agentOf("Ops", "ops");
    const ctx = await lodiRun(f.owner.id, "Plan the office move: the internet and the furniture");
    expect((await call(ctx, "create_issue", { title: "Office move" })).isError).toBeFalsy();
    const net = await call(ctx, "create_issue", { title: "Order the internet line", assignee: "@dev", parent: "#1" });
    expect(net.isError).toBeFalsy();
    await call(ctx, "create_issue", { title: "Pick the furniture", assignee: "@ops", parent: "#1" });
    const [row] = await f.db.select().from(issues).where(eq(issues.title, "Order the internet line"));
    if (!row) throw new Error("no task");
    expect(row.parentIssueId).not.toBeNull();
    expect(row.source).toMatchObject({ type: "agent", agentId: ctx.agentId, messageId: ctx.triggerMessageId });

    const brief = (await issueWorkBrief(f.db, f.org.id, row.id)) ?? "";
    expect(brief).toContain("## Where it comes from");
    expect(brief).toContain("Made by @");
    expect(brief).toContain("from ana's message");
    // A DM's words stay in it: its agent, given the task from outside, reads only that it came from there.
    expect(brief).toContain("(a private conversation)");
    expect(brief).not.toContain("Plan the office move");
    expect(brief).toContain('A step of #1 "Office move"');
    expect(brief).toContain("#3 Pick the furniture (todo, @ops)");
    // Its reach doesn't widen: from its own conversation it still lists its own task only.
    const dev = { type: "agent" as const, agentId: f.agent.id, channelId: row.conversationChannelId ?? "" };
    expect((await listIssues(f.db, dev, f.org.id)).map((i) => i.title)).toEqual(["Order the internet line"]);
  });

  test("a task made in a public channel quotes the message it came from", async () => {
    f = await setup({ issueTools: true });
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev the checkout page is slow on phones, can you look?",
    });
    const [run] = await f.db
      .insert(agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: said.id,
        triggerMessageId: said.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: said.id,
      triggerMessageId: said.id,
    };
    const out = await call(ctx, "create_issue", { title: "Speed up the checkout page" });
    expect(out.isError).toBeFalsy();
    const [row] = await f.db.select().from(issues).where(eq(issues.title, "Speed up the checkout page"));
    const brief = (await issueWorkBrief(f.db, f.org.id, row?.id ?? "")) ?? "";
    expect(brief).toContain("from ana's message in #general");
    expect(brief).toContain('"@dev the checkout page is slow on phones, can you look?"');
  });
});
