import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  askAgentToImplement,
  CANCEL_FOLLOW_UP_TOOL,
  cancelFollowUp,
  createAgent,
  createAgentRuns,
  createFakeJudge,
  createIssue,
  drainOutbox,
  FOLLOW_UP_JOB,
  FOLLOW_UP_TOOL,
  insertMessage,
  invokeToolForRun,
  joinChannel,
  openAgentDm,
  openDm,
  openTaskConversation,
  postPersonMessage,
  removeChannelMember,
  runAuthority,
  STRETCH,
  STRETCH_JOB,
  STRETCH_REFUSAL,
  saveAgentStyle,
  stanceQuestion,
  type ToolSource,
  toolPolicy,
  wakeFollowUp,
} from "../src";
import {
  advance,
  continuationVerdict,
  decideTurnEnd,
  personAsk,
  type TurnEnd,
  toolsNamed,
  untriedNudge,
} from "../src/continuation";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Agents follow through (ADR 0037, round 3; ADR 0089): every conversation run's end gets one judge call, in any
 * language, and work it said it would do that nothing keeps gets one more turn, never two; a person's go-ahead
 * they wait for is no unkept promise, nor is one that something the run set up keeps; `follow_up` posts its line,
 * wakes the agent in the same conversation at its time for the same person, and keeps its bounds; a canceled one,
 * or one whose agent or person left the conversation, wakes nobody.
 */

let f: Fixture;
afterEach(async () => {
  // A test without a database leaves the last one's: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const followThroughCalls = (fx: Fixture) =>
  (fx.context.judge as unknown as { calls: { kind: string }[] }).calls.filter((c) => c.kind === "follow_through");

const agentMessages = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );

const ask = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

test("a promise nothing keeps: one more turn to keep it, one to ask, then the reply becomes a question card", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (_request, call) => ({
      chunks: [
        call === 1
          ? "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números."
          : "Ainda rodando: vou checar de novo depois.",
      ],
    }),
  });
  await ask(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls.length).toBe(3);
  const nudge = lastUserText(f.provider.calls[1]?.request as ModelRequest);
  expect(nudge).toContain("You ended saying you would do more");
  // No sentence of it is quoted back: the judge read the whole message, in whatever language.
  expect(nudge).not.toContain("Vou checar");
  // Promising again without doing anything: it is told to ask instead, once (ADR 0097).
  expect(lastUserText(f.provider.calls[2]?.request as ModelRequest)).toContain("Ask them now with ask_user");
  expect(followThroughCalls(f).length).toBe(3);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.filter((s) => s.data.nudged === "promise").length).toBe(1);
  expect(steps.filter((s) => s.data.nudged === "ask").length).toBe(1);
  expect((await agentMessages(f)).map((m) => m.body)).toEqual([
    "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números.",
    "Ainda rodando: vou checar de novo depois.",
    "Ainda rodando: vou checar de novo depois.",
  ]);
  // The last reply is the question a person answers: the run waits on it.
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  expect((await f.db.select().from(schema.agentQuestions)).map((q) => [q.status, q.text])).toEqual([
    ["open", "Ainda rodando: vou checar de novo depois."],
  ]);
});

test("a need only a person can fill, described instead of asked: one nudge to ask, then the reply is the question", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: () => ({ chunks: ["Assim que você me mandar o token do Sentry, vou configurar o alerta."] }),
  });
  await ask(f, "@dev configura o alerta do Sentry");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(2);
  expect(f.provider.calls.length).toBe(2);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  expect((await f.db.select().from(schema.agentQuestions)).map((q) => q.text)).toEqual([
    "Assim que você me mandar o token do Sentry, vou configurar o alerta.",
  ]);
});

test("a reply too long for a question card is posted whole, never cut into one", async () => {
  const long = `Corrijo o que falta no Android. ${"Preencher a classificação de conteúdo, o título, o ícone 512x512 e o AAB assinado. ".repeat(14)}Posso fazer isso agora?`;
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: () => ({ chunks: [long] }),
  });
  await ask(f, "@dev o que falta para o review do android?");
  await drainOutbox(f.db, f.handlers);
  expect(await f.db.select().from(schema.agentQuestions)).toEqual([]);
  expect((await agentMessages(f)).map((m) => m.body)).toEqual([long, long]);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === "ask_long")).toBe(true);
});

test("every run's end is read once by the judge, in any language: a promise in Japanese is caught, a plain answer isn't", async () => {
  const promised = "CIはまだ実行中です。あとでもう一度確認して数字を送ります。";
  f = await setup({
    // The fake judge reads no words: it answers by the run it is asked about.
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply) === promised ? "continue" : "done") : undefined,
    reply: (_request, call) => ({
      chunks: [call === 1 ? promised : call === 2 ? "数字です: テスト9分、lint 2分。" : "O CI levou 12 minutos."],
    }),
  });
  await ask(f, "@dev CIはどうなっていますか？");
  await drainOutbox(f.db, f.handlers);
  // No word list stood in front of the judge: it read the reply and told the run to do it now; the kept promise
  // is read again (done).
  expect(followThroughCalls(f).length).toBe(2);
  expect(f.provider.calls.length).toBe(2);
  expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain("You ended saying you would do more");

  await ask(f, "@dev e o tempo do CI?");
  await drainOutbox(f.db, f.handlers);
  // A plain answer: asked once too, done, no more turns.
  expect(followThroughCalls(f).length).toBe(3);
  expect(f.provider.calls.length).toBe(3);
});

test("the prompt asks to finish what it starts, and names follow_up only when the run has it", async () => {
  f = await setup({ followUps: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const withTool = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(withTool).toContain("Finish what you start.");
  expect(withTool).toContain("set a follow_up to come back to it");
  expect(withTool).toContain("After a person approves or answers what you waited on, go on with the task at once");
  await f.close();

  f = await setup({ react: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const without = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(without).toContain("Finish what you start.");
  expect(without).not.toContain("follow_up");
});

test("follow_up: a line now; at its time the agent wakes in the same thread with its note, for the same person", async () => {
  f = await setup({
    followUps: true,
    // A promise kept by the follow-up just set: nothing to nudge.
    judge: (kind, _id, state) =>
      kind === "follow_through" && String(state.reply).startsWith("Ainda rodando") ? "continue" : undefined,
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: ["O CI ainda está rodando."],
            toolUses: [
              {
                name: FOLLOW_UP_TOOL,
                input: { minutes: 30, note: "Check CI run 42 and give the per-job times.", about: "ver o CI" },
              },
            ],
          }
        : call === 2
          ? { chunks: ["Ainda rodando. Volto em 30 minutos para ver o CI."] }
          : { chunks: ["Terminou: testes 9 min, lint 2 min."] },
  });
  const root = await ask(f, "Deploy de hoje");
  await ask(f, "@dev o CI terminou?", root.id);
  await drainOutbox(f.db, f.handlers);

  const [first] = await f.db.select().from(schema.agentRuns);
  const lines = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up",
  );
  expect(lines.length).toBe(1);
  const line = lines[0];
  expect(line?.threadId).toBe(root.id);
  expect(line?.meta.notice).toMatchObject({
    kind: "follow_up",
    text: "Check CI run 42 and give the per-job times.",
    refs: { runId: first?.id, about: "ver o CI", state: "pending" },
  });
  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  expect(job?.status).toBe("pending");
  const ahead = (job?.nextAttemptAt.getTime() ?? 0) - Date.now();
  expect(ahead).toBeGreaterThan(29 * 60_000);
  expect(ahead).toBeLessThanOrEqual(30 * 60_000);
  // The follow-up keeps the promise: what the run set up brings it back, so the judge isn't asked.
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);

  // Its time comes.
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date() })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);

  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs.length).toBe(2);
  const woken = runs[1];
  const [trigger] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, woken?.triggerMessageId ?? ""));
  expect(trigger?.threadId).toBe(root.id);
  expect(trigger?.meta.notice).toMatchObject({ kind: "follow_up", refs: { wake: "1", followUpId: line?.id } });
  expect(woken?.status).toBe("done");
  if (!woken) throw new Error("no woken run");
  expect(await runAuthority(f.db, woken)).toEqual({ kind: "person", personId: f.owner.id });
  // It read its note as the current message, with what to do now.
  const read = lastUserText(f.provider.calls[2]?.request as ModelRequest);
  expect(read).toContain("Check CI run 42 and give the per-job times.");
  expect(read).toContain("Do what you came back for now");
  const answer = (await agentMessages(f)).at(-1);
  expect(answer?.body).toBe("Terminou: testes 9 min, lint 2 min.");
  expect(answer?.threadId).toBe(root.id);
  const [settled] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, line?.id ?? ""));
  expect(settled?.meta.notice).toMatchObject({ refs: { state: "done" } });
  // The lines notify nobody: the reply they bring does.
  const notified = (await f.db.select().from(schema.notifications)).map((n) => n.source.messageId);
  expect(notified).not.toContain(line?.id);
  expect(notified).not.toContain(trigger?.id);
  expect(notified).toContain(answer?.id);
});

test("a follow-up a person asked for comes at its time even when the agent's last word was a side question", async () => {
  f = await setup({
    followUps: true,
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: ["Combinado."],
            toolUses: [{ name: FOLLOW_UP_TOOL, input: { minutes: 10, note: "Check the deploy.", about: "deploy" } }],
          }
        : call === 2
          ? { chunks: ["Combinado, volto em 10 min. Quer que eu também rode os testes?"] }
          : { chunks: ["Deploy ok."] },
  });
  await ask(f, "@dev confere o deploy em 10 min");
  await drainOutbox(f.db, f.handlers);
  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date() })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(2);
  const [line] = (await f.db.select().from(schema.messages)).filter(
    (m) =>
      (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up" &&
      !(m.meta.notice as { refs?: { wake?: string } }).refs?.wake,
  );
  expect(line?.meta.notice).toMatchObject({ refs: { state: "done" } });
});

test("follow_up bounds: a day ahead at most, two per run, three per conversation, none past the stretch's limit", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  let n = 0;
  const call = (runId: string, input: Record<string, unknown>) =>
    invokeToolForRun(
      deps,
      { orgId: f.org.id, agentId: f.agent.id, runId, machineId: "" },
      {
        id: `fu-${++n}`,
        name: FOLLOW_UP_TOOL,
        input: { note: "Check the deploy.", about: "ver o deploy", ...input },
      },
    );

  expect((await call(run.id, { minutes: 25 * 60 })).result).toMatchObject({ isError: true });
  expect((await call(run.id, { at: new Date(Date.now() + 25 * 3600_000).toISOString() })).result.content).toContain(
    "At most 24 hours ahead",
  );
  expect((await call(run.id, { at: new Date(Date.now() - 60_000).toISOString() })).result.isError).toBe(true);
  expect((await call(run.id, {})).result.isError).toBe(true);
  // A time without its offset would be read in the server's zone, not the person's: refused, a bare date too.
  const local = new Date(Date.now() + 3600_000).toISOString().slice(0, 19);
  expect((await call(run.id, { at: local })).result.content).toContain("offset");
  expect((await call(run.id, { at: local.slice(0, 10) })).result.content).toContain("offset");
  expect((await call(run.id, { minutes: 10 })).result.isError).toBeUndefined();
  expect((await call(run.id, { at: new Date(Date.now() + 3600_000).toISOString() })).result.isError).toBeUndefined();
  expect((await call(run.id, { minutes: 20 })).result.content).toContain("already set 2 follow-ups");

  // Another run of the agent in the same conversation (the channel's timeline): one more fits, then it is full.
  const later = await ask(f, "e o de staging?");
  const [other] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: later.id,
      triggerMessageId: later.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!other) throw new Error("no run");
  expect((await call(other.id, { minutes: 5 })).result.isError).toBeUndefined();
  expect((await call(other.id, { minutes: 6 })).result.content).toContain("3 follow-ups already wait");

  // Its wake is one more run agents start on their own: with the stretch at its limit (ADR 0089), it is refused
  // and the pause card goes out, whatever the hop.
  await f.db.insert(schema.agentRuns).values(
    Array.from({ length: STRETCH.runs }, () => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: later.id,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention" as const,
      hop: 2,
      stretchId: later.id,
      status: "done" as const,
    })),
  );
  const refusedAtLimit = await call(other.id, { minutes: 5 });
  expect(refusedAtLimit.result).toMatchObject({ content: STRETCH_REFUSAL, isError: true });
  expect((await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, STRETCH_JOB))).length).toBe(1);

  // A routine's background work runs again on its own schedule: no follow-ups there.
  const tool = { name: FOLLOW_UP_TOOL, scope: "" };
  expect(toolPolicy({ kind: "routine", personId: null, brief: null }, tool).action).toBe("refuse");
  expect(toolPolicy({ kind: "person", personId: f.owner.id }, tool).action).toBe("allow");
});

test("canceled by the agent or by a person, a follow-up wakes nobody; a second cancel is refused", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev me avisa quando o deploy terminar");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId: "" };
  const set = async (minutes: number) => {
    const out = await invokeToolForRun(deps, id, {
      id: `fu-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    });
    return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
  };
  const byAgent = await set(10);
  const byPerson = await set(20);

  const canceled = await invokeToolForRun(deps, id, { id: "c-1", name: CANCEL_FOLLOW_UP_TOOL, input: { id: byAgent } });
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  await cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson);
  await expect(cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson)).rejects.toMatchObject({
    code: "follow_up.not_pending",
  });
  const states = (await f.db.select().from(schema.messages))
    .filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up")
    .map((m) => (m.meta.notice as { refs: { state: string; canceledBy?: string } }).refs);
  expect(states).toEqual(
    expect.arrayContaining([
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: `agent:${f.agent.id}`,
      },
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: f.owner.id,
      },
    ]),
  );

  // Their time comes: nothing is delivered and no run starts.
  await f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  await drainOutbox(f.db, f.handlers);
  const wakes = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { refs?: { wake?: string } } | undefined)?.refs?.wake,
  );
  expect(wakes).toEqual([]);
  const runs = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.agentId, f.agent.id)));
  expect(runs.length).toBe(1);
});

/** Sets a follow-up from a run, as its tool call would. Returns the line's id. */
async function setFollowUp(fx: Fixture, runId: string, minutes: number) {
  const out = await invokeToolForRun(
    { db: fx.db, pubsub: fx.pubsub, tools: fx.tools },
    { orgId: fx.org.id, agentId: fx.agent.id, runId, machineId: "" },
    {
      id: `fu-${runId}-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    },
  );
  return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
}

const lineState = async (fx: Fixture, id: string) => {
  const [line] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  return (line?.meta.notice as { refs?: { state?: string } } | undefined)?.refs?.state;
};

test("at its time, an agent no longer in the conversation, or for a person who left it, wakes nobody", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const forPerson = await setFollowUp(f, run.id, 10);
  const forAgent = await setFollowUp(f, run.id, 20);

  // The person who asked is no longer in the channel (nobody leaves #general on their own: their row goes).
  await f.db
    .delete(schema.channelMembers)
    .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, f.owner.id)));
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forPerson)).toBeNull();
  expect(await lineState(f, forPerson)).toBe("canceled");

  // Back in it, but the agent was removed.
  await joinChannel(f.db, f.owner.id, f.org.id, f.general.id);
  await removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: f.agent.id });
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forAgent)).toBeNull();
  expect(await lineState(f, forAgent)).toBe("canceled");
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);
});

test("in a task's conversation, read by people who are never its members, a follow-up still comes at its time", async () => {
  f = await setup({ followUps: true });
  const ana = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, ana, f.org.id, {
    title: "Migrar os acessos do notebook da Rita",
    assignee: { type: "agent", id: f.agent.id },
  });
  const at = await openTaskConversation(f.db, ana, f.org.id, issue.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, at.channelId, {
    body: "@dev acompanha a migração e me avisa",
    threadId: at.rootId,
  });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const id = await setFollowUp(f, run.id, 5);
  expect(id).not.toBe("");

  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, id)).not.toBeNull();
  expect(await lineState(f, id)).toBe("done");
});

test("in a channel's timeline the follow-ups are each person's: cancel_follow_up and the limit count only theirs", async () => {
  f = await setup({ followUps: true });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await joinChannel(f.db, bia.id, f.org.id, f.general.id);
  // One run each (a message while the agent works in the timeline joins its run there).
  await ask(f, "@dev acompanha o deploy");
  await drainOutbox(f.db, f.handlers);
  await ask(f, "@dev e o de staging?");
  await drainOutbox(f.db, f.handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev me avisa do build",
  });
  await drainOutbox(f.db, f.handlers);
  const [ana1, ana2, biaRun] = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  if (!ana1 || !ana2 || !biaRun) throw new Error("no runs");
  await setFollowUp(f, ana1.id, 10);
  await setFollowUp(f, ana1.id, 11);
  const anaThird = await setFollowUp(f, ana2.id, 12);
  expect(anaThird).not.toBe("");
  // Ana's three fill her conversation with @dev here; Bia's is her own.
  const biaLine = await setFollowUp(f, biaRun.id, 13);
  expect(biaLine).not.toBe("");

  const canceled = await invokeToolForRun(
    { db: f.db, pubsub: f.pubsub, tools: f.tools },
    { orgId: f.org.id, agentId: f.agent.id, runId: biaRun.id, machineId: "" },
    { id: "c-bia", name: CANCEL_FOLLOW_UP_TOOL, input: {} },
  );
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  expect(await lineState(f, biaLine)).toBe("canceled");
  expect(await lineState(f, anaThird)).toBe("pending");
});

test("a reminder it set to do the work itself keeps the promise: no judgment, no nudge", async () => {
  f = await setup({
    scheduleTools: true,
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
        ? { chunks: ["Agendado: daqui a 2 horas eu confiro o deploy e te passo como ficou."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "schedule_reminder",
                input: { when: "em 2 horas", message: "verifique o deploy e conte aqui", ask_agent: true },
              },
            ],
          },
  });
  await ask(f, "@dev daqui a 2 horas verifica o deploy");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);
});

test("asked to implement an issue: an answer posted before a nudge lands in the task's conversation too", async () => {
  const first = "Fixed in PR #7. CI is running: I'll check it once it finishes.";
  const second = "CI passed: PR #7 is ready to merge.";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (_request, call) => ({ chunks: [call === 1 ? first : second] }),
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const person = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue(deps, person, f.org.id, { title: "Login breaks on Safari" });
  const at = (await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id)).conversation;
  await drainOutbox(f.db, f.handlers);
  // Written there once each (ADR 0145: the conversation is where it works, nothing mirrored).
  const said = (await f.db.select().from(schema.messages))
    .filter((m) => m.authorType === "agent" && m.channelId === at?.channelId && !m.meta.questionId)
    .map((m) => m.body);
  expect(said).toEqual([first, second]);
});

test("a promise is kept by work handed off from this conversation still out, by any run; not another conversation's or a closed one", async () => {
  f = await setup({
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply).startsWith("A Rita") ? "continue" : "done") : undefined,
    reply: (request) => ({
      chunks: [
        lastUserText(request).includes("You ended saying")
          ? "Ok, vou ver agora."
          : "A Rita ainda está nisso, te aviso quando terminar.",
      ],
    }),
  });
  const fx = f;
  const rita = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Rita", handle: "rita", role: "Operations", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  /** An earlier run of Dev in #general, done: on a message of its own, or in a thread. */
  const earlier = async (thread?: string) => {
    const m = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: fx.general.id,
      ...(thread ? { threadId: thread } : {}),
      author: { type: "person", userId: fx.owner.id },
      body: "pedido",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: thread ?? m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  };
  const handedOff = (run: { id: string }, over: Partial<typeof schema.agentConsultations.$inferInsert> = {}) =>
    fx.db.insert(schema.agentConsultations).values({
      orgId: fx.org.id,
      kind: "note",
      askerRunId: run.id,
      askerAgentId: fx.agent.id,
      targetAgentId: rita.id,
      channelId: fx.general.id,
      messageId: Bun.randomUUIDv7(),
      waitId: `async:${Bun.randomUUIDv7()}`,
      question: "Passa a pasta ao Diogo.",
      chain: [fx.agent.id],
      expiresAt: new Date(Date.now() + 60_000),
      ...over,
    });
  const nudges = async () =>
    (await fx.db.select().from(schema.agentRunSteps)).filter((s) => s.data.nudged === "promise").length;

  const thread = await earlier();
  await handedOff(await earlier(thread.triggerMessageId));
  await handedOff(await earlier(), { status: "answered", answer: "Feito.", answeredAt: new Date() });
  await ask(fx, "@dev e a Rita?");
  await drainOutbox(fx.db, fx.handlers);
  expect(await nudges()).toBe(1);

  // Still out from here, handed off by an earlier run: what comes of it wakes the agent here, keeping "te aviso".
  await handedOff(await earlier());
  await ask(fx, "@dev e agora?");
  await drainOutbox(fx.db, fx.handlers);
  expect(followThroughCalls(fx).length).toBe(2);
  expect(await nudges()).toBe(1);
});

describe("between agents (ADR 0095)", () => {
  /** Whose model call it is: its prompt says which agent it is. */
  const youAre = (request: ModelRequest, name: string) =>
    systemText(request.system).includes(`You are ${name} (@${name.toLowerCase()})`);
  const addAgent = (fx: Fixture, name: string) =>
    createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      { name, handle: name.toLowerCase(), role: "Operations", credentialId: fx.credential.id },
      { model: "claude-sonnet-5-5" },
    );
  /** Dev hands Infra the queue when Ana asks; Infra answers with `infra` (by its call), Ops with "Fila limpa.". */
  const handing = (infra: (request: ModelRequest, call: number) => FakeReply) => {
    let infraCalls = 0;
    return (request: ModelRequest): FakeReply => {
      if (youAre(request, "Infra")) return infra(request, ++infraCalls);
      if (youAre(request, "Ops")) return { chunks: ["Fila limpa."] };
      const last = lastUserText(request);
      if (last.includes("did with the work you handed it") || last.includes("Note from @infra"))
        return { chunks: ["Pronto."] };
      if (JSON.stringify(request.messages.at(-1)?.content).includes("tool_result"))
        return { chunks: ["Passei a fila ao Infra."] };
      return {
        chunks: [],
        toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "Limpa a fila de jobs de staging." } }],
      };
    };
  };
  /** The judge reads Infra's replies as an unkept promise, and every note's reply as one the sender needs. */
  let infraId = "";
  const judge = (
    kind: string,
    _id: string,
    state: Record<string, unknown>,
    _q: unknown,
    request: { agentId?: string | null },
  ) =>
    kind === "follow_through" && request.agentId === infraId
      ? String(state.reply).startsWith("Fila limpa")
        ? "done"
        : "continue"
      : kind === "note_reply"
        ? 0.9
        : undefined;
  const infraJudged = (fx: Fixture) =>
    (fx.context.judge as unknown as { calls: { kind: string; agentId?: string }[] }).calls.filter(
      (c) => c.kind === "follow_through" && c.agentId === infraId,
    );
  const dmNudges = (fx: Fixture) =>
    fx.provider.calls.filter((c) => lastUserText(c.request).includes("your answer goes back as it is"));

  test("a run that owes an answer and ends on a promise gets the DM nudge once; one answering nothing gets no check", async () => {
    f = await setup({
      askAgent: true,
      judge,
      reply: handing((_request, call) => ({
        chunks: [call === 1 ? "Vou limpar a fila e te digo." : "Fila limpa: 0 jobs pendentes."],
      })),
    });
    const fx = f;
    const infra = await addAgent(fx, "Infra");
    infraId = infra.id;
    await ask(fx, "@dev pede ao infra para limpar a fila");
    await drainOutbox(fx.db, fx.handlers);
    expect(infraJudged(fx)).toHaveLength(2);
    expect(dmNudges(fx)).toHaveLength(1);
    expect(await fx.db.select().from(schema.agentConsultations)).toMatchObject([
      { status: "answered", answer: "Fila limpa: 0 jobs pendentes." },
    ]);

    // A note from before notes were rows: its run owes no answer, and isn't read.
    const [dev] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, fx.agent.id));
    if (!dev) throw new Error("no run");
    const dm = await openAgentDm(fx.db, fx.org.id, fx.agent.id, infra.id);
    await fx.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: fx.org.id,
        channelId: dm.id,
        author: { type: "agent", agentId: fx.agent.id, runId: dev.id, hop: dev.hop },
        body: "A fila voltou a encher.",
        meta: { agentNote: { runId: dev.id } },
      });
      await createAgentRuns(tx, m, [infra.id], "dm");
    });
    await drainOutbox(fx.db, fx.handlers);
    expect(infraJudged(fx)).toHaveLength(2);
  });

  test("a run that handed part on and ends saying it will come back gets no nudge: what it handed on goes back with its answer", async () => {
    f = await setup({
      askAgent: true,
      judge,
      reply: handing((request) =>
        JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Passei a fila ao Ops; te digo quando ele terminar."] }
          : {
              chunks: [],
              toolUses: [{ name: "tell_agent", input: { agent: "@ops", message: "Limpa a fila de staging." } }],
            },
      ),
    });
    const fx = f;
    const infra = await addAgent(fx, "Infra");
    infraId = infra.id;
    await addAgent(fx, "Ops");
    await ask(fx, "@dev pede ao infra para limpar a fila");
    await drainOutbox(fx.db, fx.handlers);
    // What it handed on brings it back: not judged.
    expect(infraJudged(fx)).toHaveLength(0);
    expect(dmNudges(fx)).toEqual([]);
    const [handed] = (await fx.db.select().from(schema.agentConsultations)).filter((c) => c.targetAgentId === infra.id);
    expect(handed).toMatchObject({
      status: "answered",
      answer:
        "Passei a fila ao Ops; te digo quando ele terminar.\n\n[@ops, to whom @infra handed part of it]: Fila limpa.",
    });
  });
});

describe("a reply that names its own tools to a person", () => {
  const tools = ["request_secret", "vault_list", "remember", "github_createPullRequest"];

  test("found bare, in backticks or behind the bridge's prefix; never a one-word tool, a longer name or one the person wrote", () => {
    expect(toolsNamed("Salve no Vault (vault_list) ou me envie por `request_secret`.", tools, "")).toEqual([
      "request_secret",
      "vault_list",
    ]);
    expect(toolsNamed("Pedi com mcp__agentes__request_secret.", tools, "")).toEqual(["request_secret"]);
    expect(toolsNamed("Abri com github_createPullRequest.", tools, "")).toEqual(["github_createPullRequest"]);
    expect(toolsNamed("I remember: request_secrets and request_secret_card are other names.", tools, "")).toEqual([]);
    const asked = "pra que serve o request_secret?";
    expect(toolsNamed("O `request_secret` abre um campo seguro.", tools, asked)).toEqual([]);
  });

  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Me envie por `request_secret`.",
    mission: false,
    namedTools: ["request_secret"],
    wakesLater: async () => false,
    verdict: async () => "done",
    ...over,
  });

  test("written again once, judge or not; never between agents nor past a bound", async () => {
    const d = await decideTurnEnd(turn());
    expect(d).toMatchObject({ outcome: "continue", rule: "tool_names" });
    expect(d.nudge).toContain("your reply names your tools (`request_secret`)");
    const next = advance({ count: 0 }, d, 0);
    expect(next).toEqual({ count: 0, toolsNudged: true });
    expect(await decideTurnEnd(turn({ state: next }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ verdict: null }))).toMatchObject({ rule: "tool_names" });
    expect(await decideTurnEnd(turn({ kind: "agents_dm" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ bound: "stuck" }))).toMatchObject({ outcome: "done", rule: "stuck" });
  });

  /** Only its name matters here: the secure card's tool. */
  const secrets: ToolSource = {
    name: "secrets",
    tools: async () => [
      {
        name: "request_secret",
        description: "Ask a person for a password or a key on a secure card.",
        scope: "",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "asked" }),
      },
    ],
  };

  test("in a plain chat it is written again in plain words, and only that reply is posted", async () => {
    f = await setup({
      toolSources: [secrets],
      // Told to, the next call uses the tool first, then says what it did.
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: ["Manda a senha do painel. Salve no Vault ou me envie por `request_secret`."] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "request_secret", input: {} }] }
            : { chunks: ["Te mandei um campo seguro para a senha do painel."] },
    });
    const live = f.listen(f.general.id);
    await ask(f, "@dev entra no painel da Acme e baixa o relatório de outubro");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(3);
    expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain(
      "Not posted: your reply names your tools (`request_secret`)",
    );
    expect((await agentMessages(f)).map((m) => m.body)).toEqual(["Te mandei um campo seguro para a senha do painel."]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "tool_names").length).toBe(1);
    // It showed live as it was written: the next call opens with no text before its tool starts, so the apps drop it
    // instead of keeping it as that call's narration.
    const order = live.flatMap((e) =>
      e.type === "agent.delta"
        ? [`${e.turn}:${e.text ? "text" : "open"}`]
        : e.type === "agent.tool" && e.tool
          ? [String(e.tool)]
          : [],
    );
    expect(order).toContain("1:text");
    const opened = order.indexOf("2:open");
    expect(opened).toBeGreaterThan(order.lastIndexOf("1:text"));
    expect(order.indexOf("request_secret")).toBeGreaterThan(opened);
  });

  test("held, it is never the closing line of a later turn that acted and wrote nothing: that turn's own end is", async () => {
    f = await setup({
      toolSources: [secrets],
      reply: (_request, call): FakeReply =>
        call === 1
          ? { chunks: ["Me envie a senha do painel por `request_secret`."] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "request_secret", input: {} }] }
            : { chunks: [] },
    });
    await ask(f, "@dev entra no painel da Acme");
    await drainOutbox(f.db, f.handlers);
    const bodies = (await agentMessages(f)).map((m) => m.body);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("request_secret");
  });

  test("a person who wrote the name, or chose technical replies, gets the reply as it is", async () => {
    const answer = "O `request_secret` abre um campo seguro: você digita a senha ali e eu nunca a vejo.";
    f = await setup({ toolSources: [secrets], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev pra que serve o request_secret?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);

    await saveAgentStyle(f.db, f.org.id, f.owner.id, "technical");
    await ask(f, "@dev e como você me pede uma senha?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([answer, answer]);
  });
});

describe("the turn-end check holds the reply to what the person asked", () => {
  const stepsOf = (fx: Fixture) => fx.db.select().from(schema.agentRunSteps);
  const ruleOf = (s: { data: Record<string, unknown> }) => (s.data.continuation as { rule?: string } | undefined)?.rule;
  const judgedCalls = (fx: Fixture) =>
    followThroughCalls(fx) as unknown as { state: Record<string, unknown>; questions: Record<string, unknown> }[];
  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 1,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Não consegui abrir o relatório.",
    mission: false,
    wakesLater: async () => false,
    verdict: async () => "untried",
    ...over,
  });

  test("asked about itself or what it did, its answer is the whole job, even a plain no", async () => {
    const cases = [
      {
        ask: "@dev por que você abriu o painel de faturamento?",
        reply: "Abri para conferir o plano antes do relatório, mas ninguém pediu isso. Parei por aqui.",
      },
      { ask: "@dev você usa o Mac do Bruno?", reply: "Não, não uso esse Mac." },
      { ask: "@dev did anyone ask you to export the contact list?", reply: "No, nobody did. I stopped there." },
    ];
    for (const c of cases) {
      f = await setup({
        // The verdict alone says ways are left to try; the person only asked about the agent.
        judge: (kind, id) => (kind === "follow_through" ? (id === "stance" ? "questions" : "untried") : undefined),
        reply: () => ({ chunks: [c.reply] }),
      });
      await ask(f, c.ask);
      await drainOutbox(f.db, f.handlers);
      expect(f.provider.calls.length).toBe(1);
      expect((await agentMessages(f)).map((m) => m.body)).toEqual([c.reply]);
      expect((await stepsOf(f)).some((s) => s.data.nudged)).toBe(false);
      expect(await f.db.select().from(schema.agentQuestions)).toEqual([]);
      expect(judgedCalls(f)[0]?.questions.stance).toEqual(stanceQuestion("request"));
      await f.close();
      f = undefined as unknown as Fixture;
    }
  });

  test("on an agent's relay, the judge reads the person's own ask, and the nudge quotes it", async () => {
    const held = "Não tenho acesso ao Instagram da loja.";
    const found = "A pasta com as fotos do evento é https://drive.example.com/fotos-evento.";
    f = await setup({
      judge: (kind, id, state) =>
        kind === "follow_through" && id === "verdict" ? (state.reply === held ? "untried" : "done") : undefined,
      reply: (_request, call) => ({ chunks: [call === 1 ? held : found] }),
    });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Marketing", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "me manda o link da pasta com as fotos do evento",
    });
    const relay = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: ops.id, runId: null, hop: 1, stretchId: asked.id },
      body: "@dev a Ana precisa das fotos do evento, consegue pegar no Instagram?",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, relay, [f.agent.id], "mention"));
    await drainOutbox(f.db, f.handlers);

    const [first] = judgedCalls(f);
    expect(first?.state.request).toBe(relay.body);
    expect(first?.state.ask).toBe(asked.body);
    expect(first?.questions.stance).toEqual(stanceQuestion("ask"));
    const nudge = lastUserText(f.provider.calls[1]?.request as ModelRequest);
    expect(nudge).toContain('Asked: "me manda o link da pasta com as fotos do evento".');
    expect(nudge).toContain("never ask anyone for a sign-in or an access the request doesn't need");
    expect(nudge).toContain("Your last message wasn't posted and nobody sees this note");
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([relay.body, found]);
  });

  test("a reply that carries a question card asked: no nudge to ask, and no second card", async () => {
    const card = {
      title: "Post",
      questions: [
        {
          question: "Publico o post agora ou espero a revisão?",
          options: [{ label: "Publicar agora" }, { label: "Esperar a revisão" }],
        },
      ],
    };
    f = await setup({
      blockTools: true,
      judge: (kind, id) => (kind === "follow_through" && id === "verdict" ? "ask" : undefined),
      reply: (request) =>
        JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Qual dos dois?"] }
          : { chunks: [], toolUses: [{ name: "ask_choices", input: card }] },
    });
    await ask(f, "@dev publica o post da promoção");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(await f.db.select().from(schema.agentQuestions)).toEqual([]);
    expect((await stepsOf(f)).map(ruleOf)).toContain("asked");
    expect((await agentMessages(f)).map((m) => m.body)).toEqual(["Qual dos dois?"]);
  });

  test("copies of one agent in a stretch share three pushes, never two each", async () => {
    f = await setup({
      judge: (kind, id) => (kind === "follow_through" && id === "verdict" ? "untried" : undefined),
      reply: () => ({ chunks: ["Não consigo abrir o relatório de vendas."] }),
    });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Sales", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    const asked = await ask(f, "@dev me manda o relatório de vendas da semana");
    await drainOutbox(f.db, f.handlers);
    for (const n of [1, 2, 3]) {
      const relay = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: ops.id, runId: null, hop: 1, stretchId: asked.id },
        body: `@dev tenta de novo o relatório (${n})`,
      });
      await f.db.transaction((tx) => createAgentRuns(tx, relay, [f.agent.id], "mention"));
      await drainOutbox(f.db, f.handlers);
    }
    const steps = await stepsOf(f);
    expect(steps.filter((s) => s.data.nudged === "untried")).toHaveLength(3);
    expect(steps.filter((s) => ruleOf(s) === "stretch_cap")).toHaveLength(1);
  });

  test("the pushes left in the stretch are read only before a push", async () => {
    expect(await decideTurnEnd(turn({ stretchNudged: async () => 2 }))).toMatchObject({ rule: "untried" });
    expect(await decideTurnEnd(turn({ stretchNudged: async () => 3 }))).toMatchObject({
      outcome: "done",
      rule: "stretch_cap",
    });
    // Its own pushes count with the others'.
    const once = { count: 1, executedAtNudge: 0 };
    expect(await decideTurnEnd(turn({ state: once, stretchNudged: async () => 2 }))).toMatchObject({
      rule: "stretch_cap",
    });
    // A promise or a need past it ends as it is, never pushed into asking.
    for (const verdict of ["continue", "ask"] as const)
      expect(await decideTurnEnd(turn({ verdict: async () => verdict, stretchNudged: async () => 3 }))).toMatchObject({
        outcome: "done",
        rule: "stretch_cap",
      });
    let read = 0;
    const count = async () => {
      read++;
      return 0;
    };
    await decideTurnEnd(turn({ verdict: async () => "done", stretchNudged: count }));
    await decideTurnEnd(turn({ verdict: async () => "secret", stretchNudged: count }));
    expect(read).toBe(0);
    // A secret asked in the chat keeps its rule even beside a card.
    expect(await decideTurnEnd(turn({ asks: true, verdict: async () => "secret" }))).toMatchObject({ rule: "secret" });
  });

  test("questioned with nothing new to do, it is done; corrected and given something else, it follows through", async () => {
    const verdictWith = (verdict: string, stance: string) =>
      continuationVerdict(
        createFakeJudge((_kind, id) => (id === "verdict" ? verdict : id === "stance" ? stance : undefined)),
        {
          orgId: "o",
          agentId: "a",
          runId: "r",
          request: "por que você abriu o painel de cobrança?",
          ask: "por que você abriu o painel de cobrança?",
          reply: "Para conferir o plano. Ninguém pediu, parei.",
          means: [],
          tried: [],
          runKind: "conversation",
        },
      );
    for (const verdict of ["untried", "continue", "ask"]) expect(await verdictWith(verdict, "questions")).toBe("done");
    expect(await verdictWith("secret", "questions")).toBe("secret");
    expect(await verdictWith("continue", "corrects")).toBe("continue");
    expect(await verdictWith("untried", "asks")).toBe("untried");
    // Chased for work it owes ("how come you don't have the link?"): it still goes and gets it.
    expect(await verdictWith("untried", "chases")).toBe("untried");
  });

  test("the judge is asked what the message does only where a person wrote to it, and ask_choices counts as asking", async () => {
    const judge = createFakeJudge(() => "done");
    const base = { orgId: "o", agentId: "a", runId: "r", reply: "ok", means: [], tried: [] };
    const link = "me manda o link";
    await continuationVerdict(judge, { ...base, request: link, ask: link, runKind: "conversation" });
    await continuationVerdict(judge, { ...base, request: "relatório diário de erros", runKind: "routine" });
    await continuationVerdict(judge, { ...base, request: "você tem o login?", ask: link, runKind: "agents_dm" });
    const [own, routine, between] = judge.calls;
    expect(own?.state).not.toHaveProperty("ask");
    expect(own?.questions.stance).toEqual(stanceQuestion("request"));
    expect(routine?.questions).not.toHaveProperty("stance");
    // Between agents it answers the agent that asked: the person's words are context only.
    expect(between?.state.ask).toBe(link);
    expect(between?.questions).not.toHaveProperty("stance");
    const criteria = (own?.questions.verdict as { criteria: Record<string, string> } | undefined)?.criteria ?? {};
    expect(criteria.done).toContain("request_permission, ask_user or ask_choices");
    expect(criteria.done).toContain("A plain answer to a question about itself");
    expect(criteria.untried).toContain("(not when it was only asked whether it has one)");
    expect(criteria.untried).toContain(
      "A sign-in or an access the person's request (`ask`, else `request`) doesn't need is no way left to try.",
    );
  });

  test("going against what the person said is never done, and a 'why didn't you' asks for the work", async () => {
    const refusal = "Não mando as duas planilhas assim: ficam longas demais.";
    f = await setup({
      judge: (kind, id, state) =>
        kind === "follow_through" && id === "verdict" ? (state.reply === refusal ? "untried" : "done") : undefined,
      reply: (_request, call) => ({ chunks: [call === 1 ? refusal : "Mandei as duas planilhas como estão."] }),
    });
    await ask(f, "@dev manda as duas planilhas como estão, sem resumir");
    await drainOutbox(f.db, f.handlers);

    const verdict = judgedCalls(f)[0]?.questions.verdict as { criteria: Record<string, string> } | undefined;
    expect(verdict?.criteria.done).toContain(
      "Going against what the person told it to do (`ask`, else `request`), with no safety, permission or other people's data reason, is not done: that is untried.",
    );
    expect(verdict?.criteria.untried).toContain(
      "Also when it refused or went against what the person told it to do, with no safety, permission or other people's data reason",
    );
    expect(verdict?.criteria.done).toContain(
      "a question about work it was asked for and hasn't delivered ('did you…?', 'why didn't you…?') asks for that work",
    );
    expect((stanceQuestion("request") as { criteria: Record<string, string> }).criteria.chases).toContain(
      "Asks after work it was asked for and hasn't delivered",
    );
    // The refusal is held, never posted; the nudge quotes what was asked.
    expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain(
      'Asked: "@dev manda as duas planilhas como estão, sem resumir".',
    );
    expect((await agentMessages(f)).map((m) => m.body)).toEqual(["Mandei as duas planilhas como estão."]);
  });

  test("the untried nudge quotes the ask, never reaches for an access it doesn't need, and says the reply was held", () => {
    const nudge = untriedNudge([], [], "me manda o link da pasta\n  com as fotos do evento");
    expect(nudge).toContain('Asked: "me manda o link da pasta com as fotos do evento".');
    expect(nudge).toContain("never ask anyone for a sign-in or an access the request doesn't need");
    expect(nudge).toEndWith(
      "Your last message wasn't posted and nobody sees this note: if your answer stands, write it again as it is.",
    );
    expect(untriedNudge([], [])).not.toContain("Asked:");
  });

  test("the person's ask is what opened the stretch; none when an agent opened it", async () => {
    f = await setup();
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "me manda a planilha de custos",
    });
    const relay = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: asked.id },
      body: "@ops tem a planilha?",
    });
    const own = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Bom dia, time.",
    });
    const of = async (m: { id: string; stretchId: string | null }, carried?: string) =>
      (
        await personAsk(
          f.db,
          { orgId: f.org.id, channelId: f.general.id, stretchId: m.stretchId, triggerMessageId: m.id },
          carried,
        )
      ).text;
    expect(await of(relay)).toBe("me manda a planilha de custos");
    expect(await of(asked)).toBe("me manda a planilha de custos");
    expect(await of(own)).toBe("");
    expect(await of(own, "o relatório de vendas")).toBe("o relatório de vendas");
  });

  test("a person's words in a private conversation reach the judge, never the nudge of an agent outside it", async () => {
    const held = "Não tenho acesso ao cofre do escritório.";
    f = await setup({
      judge: (kind, id, state) =>
        kind === "follow_through" && id === "verdict" ? (state.reply === held ? "untried" : "done") : undefined,
      reply: (_request, call) => ({
        chunks: [call === 1 ? held : "Achei: o item do wifi está no cofre, em Escritório."],
      }),
    });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Office", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    // Ana asks Ops in their DM, and Ops relays it to @dev in #general.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: ops.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "a senha do wifi do escritório mudou, a nova está no cofre: me confirma?",
    });
    const relay = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: ops.id, runId: null, hop: 1, stretchId: asked.id },
      body: "@dev consegue conferir o item do wifi no cofre?",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, relay, [f.agent.id], "mention"));
    await drainOutbox(f.db, f.handlers);

    expect(judgedCalls(f)[0]?.state.ask).toBe(asked.body);
    const nudge = lastUserText(f.provider.calls[1]?.request as ModelRequest);
    expect(nudge).toContain("never ask anyone for a sign-in or an access the request doesn't need");
    expect(nudge).not.toContain("Asked:");
    expect(nudge).not.toContain("senha do wifi");
  });
});
