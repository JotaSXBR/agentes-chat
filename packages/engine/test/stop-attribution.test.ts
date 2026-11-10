import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  canceledBy,
  cancelRun,
  continueRun,
  createMissionEngine,
  drainOutbox,
  joinChannel,
  personStopOf,
  postPersonMessage,
  RIGHT_HAND,
  runErrorDetail,
  setStopRestarted,
  stopError,
  stoppedText,
  stopRun,
  taskManager,
} from "../src";
import { answerNoTurn } from "../src/live-steer";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string, extra: { threadId?: string; steer?: "now" } = {}) =>
  postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body, ...extra });
const runOf = async (triggerMessageId: string) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, triggerMessageId));
  if (!run) throw new Error("no run");
  return run;
};
const runById = async (id: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
const messageById = async (id: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];
/** The `run_stopped` notices' refs. */
const refsOf = (m: { meta: Record<string, unknown> } | undefined) =>
  (m?.meta.notice as { refs?: Record<string, string> } | undefined)?.refs ?? {};
const stopNotices = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "run_stopped",
  );
const audits = () =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "run.canceled")));

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A message's meta as a live event carries it. */
const metaOf = (e: RealtimeEvent) => e.message as { id: string; meta?: Record<string, unknown> } | undefined;

/**
 * Ana asks Dev to read the logs; the model holds after its first words until `stop` lands, then the run posts its
 * stopped reply. `events`: what the channel heard from the start.
 */
async function stoppedWhileWriting(stop: (runId: string) => Promise<unknown>, options: { rightHand?: boolean } = {}) {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f = await setup({
    ...options,
    reply: (_req: ModelRequest, call: number) =>
      call > 1 ? { chunks: ["Pronto."] } : { chunks: ["Lendo os logs. ", "nunca chega"], hold },
  });
  const events = f.listen(f.general.id);
  const question = await ask("@dev analisa os logs");
  let seen = false;
  f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
    if (seen || event.type !== "agent.typing") return;
    seen = true;
    void stop(String(event.runId)).finally(release);
  });
  await drainOutbox(f.db, f.handlers);
  const run = await runOf(question.id);
  const reply = run.replyMessageId ? await messageById(run.replyMessageId) : undefined;
  return { question, run, reply, events };
}

describe("who or what stopped a run, as its row keeps it", () => {
  test("a person, the agent at their word, a restart from their message, or the system's reason", () => {
    const person = stopError({ type: "person", id: "user_ana" });
    const agent = stopError({ type: "person", id: "user_ana", agentId: "agent-lodi" });
    const restarted = stopError({ type: "person", id: "user_ana", restarted: true });
    expect([person, agent, restarted]).toEqual([
      "canceled_by:user_ana",
      "canceled_by:user_ana|agent:agent-lodi",
      "canceled_by:user_ana|restarted",
    ]);
    expect(personStopOf(agent)).toEqual({ userId: "user_ana", agentId: "agent-lodi", restarted: false });
    expect(personStopOf(restarted)).toEqual({ userId: "user_ana", agentId: null, restarted: true });
    // Whoever reads the person alone (Continuar, routines, the task manager) gets the person, never the rest.
    for (const error of [person, agent, restarted]) {
      expect(canceledBy(error)).toBe("user_ana");
      expect(runErrorDetail(error)).toEqual({ errorCode: "run.canceled", errorParams: { byUserId: "user_ana" } });
    }
    expect(stopError({ type: "system", reason: "agent_archived" })).toBe("agent_archived");
    expect(personStopOf("agent_archived")).toBeNull();
    expect(canceledBy(null)).toBeNull();
  });
});

describe("a person's stop", () => {
  test("their name on the stop, on the notice the agent reads and on the live event; no agent, no cause", async () => {
    const { run, reply, events } = await stoppedWhileWriting((id) => cancelRun(deps(), f.owner.id, f.org.id, id));
    expect(run).toMatchObject({ status: "canceled", error: `canceled_by:${f.owner.id}` });
    expect(reply?.meta.canceled).toEqual({ byUserId: f.owner.id, text: "Lendo os logs." });
    expect(reply?.body).toBe("Lendo os logs.\n\n_Stopped by ana._");
    const [notice] = await stopNotices();
    expect(notice?.meta.notice).toMatchObject({ refs: { runId: run.id, byUserId: f.owner.id, byName: "ana" } });
    expect(refsOf(notice).byAgentId).toBeUndefined();
    const canceled = events.find((e) => e.type === "run.canceled");
    expect(canceled).toMatchObject({ runId: run.id, byUserId: f.owner.id });
    expect(canceled).not.toHaveProperty("byAgentId");
    expect(canceled).not.toHaveProperty("restarted");
    const [audit] = await audits();
    expect(audit).toMatchObject({ actorType: "person", actorId: f.owner.id });
    expect(audit?.details).toEqual({ agentId: f.agent.id, from: "running" });
  });
});

describe("the right hand's stop at a person's word", () => {
  test("the stop, its reply and the notice name the right hand; the person stays who may say why", async () => {
    const { run, reply, events } = await stoppedWhileWriting(
      async (id) => cancelRun(deps(), f.owner.id, f.org.id, id, { byAgentId: (await lodiOf()).id }),
      { rightHand: true },
    );
    const lodi = await lodiOf();
    expect(run.error).toBe(`canceled_by:${f.owner.id}|agent:${lodi.id}`);
    expect(reply?.meta.canceled).toEqual({ byUserId: f.owner.id, byAgentId: lodi.id, text: "Lendo os logs." });
    expect(reply?.body).toBe(`Lendo os logs.\n\n_Stopped by ${lodi.name} for ana._`);
    expect(events.find((e) => e.type === "run.canceled")).toMatchObject({
      byUserId: f.owner.id,
      byAgentId: lodi.id,
    });
    const [notice] = await stopNotices();
    expect(refsOf(notice)).toMatchObject({
      byUserId: f.owner.id,
      byName: "ana",
      byAgentId: lodi.id,
      byAgentName: lodi.name,
    });
    expect(notice?.body).toStartWith(`${lodi.name}, at ana's word, stopped your task`);
    expect(stoppedText({ runId: "r", byUserId: "u", byName: "", label: "", was: "queued" })).toStartWith(
      "A person stopped your task before it started.",
    );
    const [audit] = await audits();
    expect(audit).toMatchObject({ actorType: "agent", actorId: lodi.id, onBehalfOfUserId: f.owner.id });
    // Continuar still picks it up, for the same people as any stop.
    expect((await continueRun(deps(), f.owner.id, f.org.id, run.id)).runId).toBeString();
    // The task manager names it too, with the person it stopped it for.
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.ended.find((e) => e.runId === run.id)?.stoppedBy).toEqual({
      userId: f.owner.id,
      name: "ana",
      agentId: lodi.id,
    });
  });
});

describe('"Parar e mandar" to a computer brain starts it again: no stop to show', () => {
  test("its stop is kept as a restart from their message, the live event says so, and the agent is told nothing", async () => {
    f = await setup();
    const question = await ask("@dev revisa o PR");
    const run = await runOf(question.id);
    // At work on Claude Code, whose turn takes no message now.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", brain: "claude_code", startedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    const off = answerNoTurn(f.pubsub, run.id);
    const events = f.listen(f.general.id);
    await ask("só o arquivo de testes", { threadId: question.id, steer: "now" });
    off();
    expect((await runById(run.id))?.error).toBe(`canceled_by:${f.owner.id}|restarted`);
    expect(events.find((e) => e.type === "run.canceled")).toMatchObject({ runId: run.id, restarted: true });
    expect(await stopNotices()).toEqual([]);
    const [audit] = await audits();
    expect(audit?.details).toMatchObject({ restarted: true });
  });

  test("a restart that finds nothing to start from shows its stop after all, with Continuar", async () => {
    // The model brain read the message already: nothing starts again from it.
    const { run, reply, events } = await stoppedWhileWriting((id) =>
      cancelRun(deps(), f.owner.id, f.org.id, id, { tell: false, restarted: true }),
    );
    expect(reply?.meta.canceled).toEqual({ byUserId: f.owner.id, text: "Lendo os logs." });
    const posted = events.filter((e) => e.type === "message.created" && metaOf(e)?.id === reply?.id);
    expect(posted.map((e) => (metaOf(e)?.meta?.canceled as { restarted?: boolean } | undefined)?.restarted)).toEqual([
      true,
      undefined,
    ]);
    expect((await continueRun(deps(), f.owner.id, f.org.id, run.id)).runId).toBeString();
  });

  test("the reply says again whether it started over, for clients that drew it", async () => {
    const { reply } = await stoppedWhileWriting((id) => cancelRun(deps(), f.owner.id, f.org.id, id));
    if (!reply) throw new Error("no reply");
    const events = f.listen(f.general.id);
    await setStopRestarted(deps(), reply, true);
    expect((await messageById(reply.id))?.meta.canceled).toMatchObject({ byUserId: f.owner.id, restarted: true });
    await setStopRestarted(deps(), reply, false);
    expect((await messageById(reply.id))?.meta.canceled).toEqual({ byUserId: f.owner.id, text: "Lendo os logs." });
    expect(events.filter((e) => e.type === "message.created")).toHaveLength(2);
  });
});

describe("the system's stop: its cause, nobody's name", () => {
  test("an archived agent: the reply carries the cause, no person, no notice, no Continuar", async () => {
    const { run, reply, events } = await stoppedWhileWriting(async (id) => {
      const live = await runById(id);
      if (live) await stopRun(deps(), f.org.id, live, "channel", { type: "system", reason: "agent_archived" });
    });
    expect(run.error).toBe("agent_archived");
    expect(reply?.meta.canceled).toEqual({ byUserId: null, code: "run.agent_archived", text: "Lendo os logs." });
    expect(reply?.body).toBe("Lendo os logs.\n\n_Stopped._");
    expect(events.some((e) => e.type === "run.canceled")).toBe(false);
    expect(await stopNotices()).toEqual([]);
    await expect(continueRun(deps(), f.owner.id, f.org.id, run.id)).rejects.toMatchObject({
      code: "run.not_continuable",
    });
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.ended.find((e) => e.runId === run.id)?.stoppedBy).toBeNull();
  });

  test("a mission's stop with nobody behind it is the mission's; a new brain before Start plans again", async () => {
    f = await setup();
    const engine = createMissionEngine(deps());
    const where = async (body: string) => {
      const asked = await ask(body);
      const run = await runOf(asked.id);
      return {
        run,
        input: { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, threadRootId: run.threadRootId },
      };
    };
    const quiet = await where("@dev planeja a missão");
    await engine.cancelRuns({ ...quiet.input, actorId: null, reason: "stopped" });
    expect((await runById(quiet.run.id))?.error).toBe("mission_stopped");
    expect(canceledBy("mission_stopped")).toBeNull();
    const swapped = await where("@dev planeja de novo");
    await engine.cancelRuns({ ...swapped.input, actorId: f.owner.id, reason: "executor_changed" });
    expect((await runById(swapped.run.id))?.error).toBe(`canceled_by:${f.owner.id}|restarted`);
    const closed = await where("@dev fecha a missão");
    await engine.cancelRuns({ ...closed.input, actorId: f.owner.id, reason: "closed" });
    expect((await runById(closed.run.id))?.error).toBe(`canceled_by:${f.owner.id}`);
  });
});

describe("a person's own message stopped before its run started", () => {
  test("while the agent's other work there went on, it still stands; another person's, or through the right hand, is dropped", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    // Dev is at work here on an earlier ask, waiting on a colleague's answer.
    const earlier = await ask("@dev confere com o fornecedor a receita de ontem");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input" })
      .where(eq(schema.agentRuns.id, (await runOf(earlier.id)).id));
    const mine = await ask("@dev chama a API, não o fornecedor");
    await cancelRun(deps(), f.owner.id, f.org.id, (await runOf(mine.id)).id);
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await joinChannel(f.db, bia.id, f.org.id, f.general.id);
    const hers = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev confere o relatório" });
    await cancelRun(deps(), f.owner.id, f.org.id, (await runOf(hers.id)).id);
    const asked = await ask("@dev esquece o relatório");
    await cancelRun(deps(), f.owner.id, f.org.id, (await runOf(asked.id)).id, { byAgentId: lodi.id });

    const byRun = new Map((await stopNotices()).map((m) => [refsOf(m).runId, m]));
    const own = byRun.get((await runOf(mine.id)).id);
    expect(refsOf(own)).toMatchObject({ was: "queued", own: "1" });
    expect(own?.body).toContain("It was their own message, which you hadn't read yet: it still stands");
    expect(own?.body).not.toContain("Don't pick it up again");
    for (const dropped of [byRun.get((await runOf(hers.id)).id), byRun.get((await runOf(asked.id)).id)]) {
      expect(refsOf(dropped)).toMatchObject({ was: "queued" });
      expect(refsOf(dropped).own).toBeUndefined();
      expect(dropped?.body).toContain("Don't pick it up again on your own");
    }
  });

  test("with nothing else under way there, the stop took the message back", async () => {
    f = await setup();
    const mine = await ask("@dev apaga a branch antiga");
    await cancelRun(deps(), f.owner.id, f.org.id, (await runOf(mine.id)).id);

    const [notice] = await stopNotices();
    expect(refsOf(notice)).toMatchObject({ was: "queued" });
    expect(refsOf(notice).own).toBeUndefined();
    expect(notice?.body).toContain("Don't pick it up again on your own");
  });
});
