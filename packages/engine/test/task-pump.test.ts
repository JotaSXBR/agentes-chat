import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, schema } from "@agenteschat/db";
import {
  announceTaskConversation,
  approveTaskStart,
  createAgent,
  createIssue,
  drainOutbox,
  enqueueTaskPumps,
  getIssue,
  type IssueView,
  insertMessage,
  listIssues,
  openTaskConversation,
  personAskedLately,
  pumpTasks,
  runAuthorityById,
  TASK_IDLE_MS,
  updateIssue,
  updateOrgSettings,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const { agentRuns, issues, messages } = schema;
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const person = (userId: string) => ({ type: "person" as const, userId });
const pump = (now = new Date(), startsPerDay?: number) =>
  pumpTasks(
    { ...deps(), ai: { db: f.db, gateway: f.gateway }, ...(startsPerDay !== undefined ? { startsPerDay } : {}) },
    f.org.id,
    now,
  );

/** A task a person gives an agent, as the board does. */
const give = (title: string, agentId = f.agent.id, extra: Record<string, unknown> = {}, by = f.owner.id) =>
  createIssue(deps(), person(by), f.org.id, { title, assignee: { type: "agent", id: agentId }, ...extra });

const runsOf = (agentId = f.agent.id) =>
  f.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, f.org.id), eq(agentRuns.agentId, agentId)));

/** Its runs end (done), `ago` ms back. */
async function finish(runIds: string[], ago = 0) {
  if (runIds.length === 0) return;
  const at = new Date(Date.now() - ago);
  await f.db
    .update(agentRuns)
    .set({ status: "done", finishedAt: at, updatedAt: at })
    .where(inArray(agentRuns.id, runIds));
}

const statusOf = async (id: string) => (await f.db.select().from(issues).where(eq(issues.id, id)))[0]?.status;
const viewOf = (i: IssueView) => getIssue(f.db, person(f.owner.id), f.org.id, { id: i.id });

async function agentOf(name: string, handle: string, brakes: Record<string, unknown> = {}) {
  const a = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Dev", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  if (Object.keys(brakes).length)
    await f.db.update(schema.agents).set({ autonomyBrakes: brakes }).where(eq(schema.agents.id, a.id));
  return a;
}

describe("the task pump: an agent takes its next task as room frees (24h build flow)", () => {
  test("three to-do tasks a person gave start two at once, each in its own conversation, on that person's behalf", async () => {
    f = await setup();
    const a = await give("Ship the login page");
    const b = await give("Write the release notes");
    const c = await give("Fix the flaky upload test");
    expect(await pump()).toBe(2);
    const runs = await runsOf();
    expect(runs.length).toBe(2);
    for (const run of runs) {
      const [task] = await f.db
        .select()
        .from(issues)
        .where(eq(issues.id, run.issueId ?? ""));
      expect(run.channelId).toBe(task?.conversationChannelId ?? "");
      expect(run.status).toBe("queued");
      const [start] = await f.db.select().from(messages).where(eq(messages.id, run.triggerMessageId));
      // Written as the agent, never in the person's name, and theirs.
      expect(start?.authorType).toBe("agent");
      expect(start?.authorAgentId).toBe(f.agent.id);
      expect(start?.meta.notice).toMatchObject({ kind: "task_start", refs: { personId: f.owner.id, line: "start" } });
      expect(await runAuthorityById(f.db, f.org.id, run.id)).toEqual({ kind: "person", personId: f.owner.id });
      // A person's stretch: its runs aren't the guarded "nobody asked" kind, and they go before agents' own work.
      expect(await personAskedLately(f.db, f.org.id, run.stretchId ?? run.triggerMessageId)).toBe(true);
      expect(await statusOf(task?.id ?? "")).toBe("in_progress");
    }
    // The board's order, as people see it: a new task lands on top.
    expect(new Set(runs.map((r) => r.issueId))).toEqual(new Set([b.id, c.id]));
    // The third waits, first in line: "Na fila de Dev · 1º".
    expect((await viewOf(a)).queue).toEqual({ position: 1 });
    expect((await viewOf(c)).queue).toBeNull();
    // Nothing more fits until one ends.
    expect(await pump()).toBe(0);
  });

  test("a run that waits on a person frees its slot; a queued or working one holds it", async () => {
    f = await setup();
    await give("One");
    await give("Two");
    const third = await give("Three");
    await pump();
    const [first] = await runsOf();
    await f.db
      .update(agentRuns)
      .set({ status: "waiting_input" })
      .where(eq(agentRuns.id, first?.id ?? ""));
    expect(await pump()).toBe(1);
    expect((await runsOf()).some((r) => r.issueId === third.id)).toBe(true);
  });

  test("nothing starts while its computer has a line, a plan or budget wait is open, or it has no AI", async () => {
    f = await setup();
    await give("Something to do");
    const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
    if (!machine) throw new Error("no machine");
    await f.db.update(schema.agents).set({ machineId: machine.id }).where(eq(schema.agents.id, f.agent.id));
    const busy = Bun.randomUUIDv7();
    const [line] = await f.db
      .insert(agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: busy,
        triggerMessageId: busy,
        trigger: "mention",
        hop: 1,
        status: "waiting_input",
        waitingMachineId: machine.id,
        transcript: { waitingForBrain: { kind: "claude_code", machineId: machine.id, code: "busy", waitId: busy } },
      })
      .returning();
    expect(await pump()).toBe(0);

    await f.db
      .update(agentRuns)
      .set({ transcript: { waitingForBrain: { kind: "claude_code", code: "plan_limit", waitId: busy } } })
      .where(eq(agentRuns.id, line?.id ?? ""));
    expect(await pump()).toBe(0);

    await f.db.delete(agentRuns).where(eq(agentRuns.id, line?.id ?? ""));
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId: null })
      .where(eq(schema.agents.id, f.agent.id));
    expect(await pump()).toBe(0);

    await f.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, f.agent.id));
    expect(await pump()).toBe(1);
  });

  test("the queue takes high priority first, then the nearest due date, then the board's order", async () => {
    f = await setup();
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { tasksAtOnce: 1 } })
      .where(eq(schema.agents.id, f.agent.id));
    const plain = await give("Plain");
    const low = await give("Low", f.agent.id, { priority: "low" });
    const due = await give("Due soon", f.agent.id, { dueDate: "2026-12-01" });
    const high = await give("Urgent", f.agent.id, { priority: "high" });
    const positions = Object.fromEntries(
      (await listIssues(f.db, person(f.owner.id), f.org.id)).map((i) => [i.title, i.queue?.position ?? null]),
    );
    expect(positions).toEqual({ Urgent: 1, "Due soon": 2, Plain: 3, Low: 4 });
    expect(await pump()).toBe(1);
    expect((await runsOf()).map((r) => r.issueId)).toEqual([high.id]);
    await finish((await runsOf()).map((r) => r.id));
    await f.db.update(issues).set({ status: "done" }).where(eq(issues.id, high.id));
    await pump();
    expect((await runsOf()).map((r) => r.issueId)).toContain(due.id);
    expect((await viewOf(plain)).queue).toEqual({ position: 1 });
    expect((await viewOf(low)).queue).toEqual({ position: 2 });
  });

  test("work left in progress comes back after 15 idle minutes, at most three times a day", async () => {
    f = await setup();
    const task = await give("Migrate the reports");
    await pump();
    let [run] = await runsOf();
    // Its run ended with the task unfinished (its nudges ran out): just now, nothing yet.
    await finish([run?.id ?? ""], 60_000);
    expect(await statusOf(task.id)).toBe("in_progress");
    expect(await pump()).toBe(0);
    expect((await viewOf(task)).queue).toBeNull();
    // A quarter of an hour later its agent picks it up where it left off.
    await finish([run?.id ?? ""], TASK_IDLE_MS + 60_000);
    expect(await pump()).toBe(1);
    const resumed = (await runsOf()).find((r) => r.id !== run?.id);
    const [notice] = await f.db
      .select()
      .from(messages)
      .where(eq(messages.id, resumed?.triggerMessageId ?? ""));
    expect(notice?.meta.notice).toMatchObject({ kind: "task_start", refs: { line: "resume" } });
    expect(notice?.body).toContain("still in progress");
    // Its first start counts: one more comeback today, then it waits for a person.
    await finish(
      (await runsOf()).filter((r) => r.status === "queued").map((r) => r.id),
      TASK_IDLE_MS + 60_000,
    );
    expect(await pump()).toBe(1);
    [run] = (await runsOf()).filter((r) => r.status === "queued");
    await finish([run?.id ?? ""], TASK_IDLE_MS + 60_000);
    expect(await pump()).toBe(0);
    expect((await runsOf()).length).toBe(3);
  });

  test("a task its agent marked blocked waits until a person answers in its conversation", async () => {
    f = await setup();
    const task = await give("Rotate the API keys");
    await pump();
    const [run] = await runsOf();
    await updateIssue(
      deps(),
      { type: "agent", agentId: f.agent.id, channelId: run?.channelId ?? "", runId: run?.id ?? "" },
      f.org.id,
      task.id,
      { blocked: "Needs the new vault password from Ana" },
    );
    await finish([run?.id ?? ""], TASK_IDLE_MS + 60_000);
    expect((await viewOf(task)).blocked).toMatchObject({
      reason: "agent",
      text: "Needs the new vault password from Ana",
    });
    expect(await pump()).toBe(0);

    const conversation = await openTaskConversation(f.db, person(f.owner.id), f.org.id, task.id);
    const answer = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: conversation.channelId,
      threadId: conversation.rootId,
      author: { type: "person", userId: f.owner.id },
      body: "Sent it to you in the vault.",
    });
    await announceTaskConversation(deps(), f.org.id, answer.id);
    expect((await viewOf(task)).blocked).toBeNull();
    expect(await pump()).toBe(1);
  });

  test("whoever gave the task decides: a person's assignment starts it for them, an agent's waits for a person's go", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const bobs = await give("Bob's task", f.agent.id, {}, bob.id);
    const agentMade = await createIssue(
      deps(),
      { type: "agent", agentId: f.agent.id, channelId: f.general.id },
      f.org.id,
      { title: "An agent's own idea", assignee: { type: "agent", id: f.agent.id } },
    );
    const handedOn = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Handed on by an agent" });
    await updateIssue(deps(), { type: "agent", agentId: f.agent.id, channelId: f.general.id }, f.org.id, handedOn.id, {
      assignee: { type: "agent", id: f.agent.id },
    });
    expect(await pump()).toBe(1);
    const [run] = await runsOf();
    expect(run?.issueId).toBe(bobs.id);
    expect(await runAuthorityById(f.db, f.org.id, run?.id ?? "")).toEqual({ kind: "person", personId: bob.id });
    expect((await viewOf(agentMade)).queue).toBeNull();
    expect((await viewOf(handedOn)).queue).toBeNull();

    // A person's go makes it theirs.
    expect(await approveTaskStart(deps(), f.owner.id, f.org.id, agentMade.id, f.agent.id)).not.toBeNull();
    expect(await pump()).toBe(1);
    const started = (await runsOf()).find((r) => r.issueId === agentMade.id);
    expect(await runAuthorityById(f.db, f.org.id, started?.id ?? "")).toEqual({
      kind: "person",
      personId: f.owner.id,
    });

    // Someone who left the workspace is behind nothing any more.
    await f.db.update(agentRuns).set({ status: "done" });
    const gone = await give("Left behind", f.agent.id, {}, bob.id);
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bob.id));
    expect(await pump()).toBe(0);
    expect((await viewOf(gone)).queue).toBeNull();
  });

  test("the workspace's daily ceiling, its switch and the agent's own", async () => {
    f = await setup();
    const ops = await agentOf("Ops", "ops");
    await give("Dev's task");
    await give("Ops' task", ops.id);
    expect(await pump(new Date(), 1)).toBe(1);
    expect(await pump(new Date(), 1)).toBe(0);

    await f.db.delete(agentRuns);
    await f.db.update(issues).set({ status: "todo" });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { taskPump: false });
    expect(await pump()).toBe(0);
    expect(await enqueueTaskPumps(f.db)).toBe(0);

    await updateOrgSettings(f.db, f.owner.id, f.org.id, { taskPump: true });
    await f.db
      .update(schema.agents)
      .set({ autonomyBrakes: { tasks: false } })
      .where(eq(schema.agents.id, ops.id));
    expect(await pump()).toBe(1);
    expect((await runsOf(ops.id)).length).toBe(0);
  });

  test("two pumps at once start each task once", async () => {
    f = await setup();
    for (const title of ["A", "B", "C"]) await give(title);
    const [x, y] = await Promise.all([pump(), pump()]);
    expect((x ?? 0) + (y ?? 0)).toBe(2);
    const runs = await runsOf();
    expect(runs.length).toBe(2);
    expect(new Set(runs.map((r) => r.issueId)).size).toBe(2);
  });

  test("the minute's tick queues a pump only for a workspace with a task its agent may take now", async () => {
    f = await setup();
    expect(await enqueueTaskPumps(f.db)).toBe(0);
    await createIssue(deps(), { type: "agent", agentId: f.agent.id, channelId: f.general.id }, f.org.id, {
      title: "Waits for a go",
      assignee: { type: "agent", id: f.agent.id },
    });
    expect(await enqueueTaskPumps(f.db)).toBe(0);
    await give("Given by a person");
    expect(await enqueueTaskPumps(f.db)).toBe(1);
    await pump();
    expect(await enqueueTaskPumps(f.db)).toBe(0);
  });

  test("a person's assignment wakes the queue by itself: its job starts the task and the agent works on it", async () => {
    f = await setup({ taskPump: true });
    const task = await give("Write the changelog");
    expect((await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "tasks.pump"))).length).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const [run] = await runsOf();
    expect(run?.issueId).toBe(task.id);
    expect(run?.status).toBe("done");
    const [reply] = await f.db
      .select()
      .from(messages)
      .where(and(eq(messages.agentRunId, run?.id ?? ""), eq(messages.authorAgentId, f.agent.id)));
    expect(reply?.channelId).toBe(
      (await f.db.select().from(issues).where(eq(issues.id, task.id)))[0]?.conversationChannelId ?? "",
    );
  });

  test("five tasks given at night are done by morning, two at a time", async () => {
    f = await setup();
    const tasks = [];
    for (const title of ["Night one", "Night two", "Night three", "Night four", "Night five"])
      tasks.push(await give(title));
    let most = 0;
    for (let round = 0; round < 10; round++) {
      await pump();
      const live = (await runsOf()).filter((r) => r.status === "queued" || r.status === "running");
      most = Math.max(most, live.length);
      if (live.length === 0) break;
      // Each run does its task and closes it, as an agent would with update_issue.
      await finish(live.map((r) => r.id));
      await f.db
        .update(issues)
        .set({ status: "done" })
        .where(
          inArray(
            issues.id,
            live.map((r) => r.issueId ?? ""),
          ),
        );
    }
    expect(most).toBe(2);
    for (const t of tasks) expect(await statusOf(t.id)).toBe("done");
    expect((await runsOf()).length).toBe(5);
  });
});
