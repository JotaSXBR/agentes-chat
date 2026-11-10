import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  createAgent,
  createFakeJudge,
  drainOutbox,
  insertMessageWithRuns,
  type JudgeQuestion,
  mentionNeedsNothing,
  postPersonMessage,
  releaseHeldInbox,
  sendNote,
  startNoteRun,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * The right person, and hand-offs: moments where a hand-off reached the wrong agent, woke one twice, or waited hours
 * behind a question nobody else could answer, replayed with made-up agents.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const isFor = (req: ModelRequest, handle: string) => systemText(req.system).includes(`(@${handle})`);
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const runs = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const questions = () => f.db.select().from(schema.agentQuestions);

async function addAgent(handle: string, name: string, role: string) {
  const agent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: agent.id });
  return agent;
}

const say = (channelId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });

const askUser = (question: string) => ({
  chunks: [],
  toolUses: [
    {
      name: "ask_user",
      input: { why: "The note doesn't say where it goes, and posting in the wrong place spams people.", question },
    },
  ],
});

describe("an agent that handed work on names who has it without waking it again", () => {
  test("a tell_agent and then a reply naming that agent wake it once", async () => {
    f = await setup({
      askAgent: true,
      // Any mention of QA reads as needing it: only the dedupe keeps the reply's @ from waking it a second time.
      judge: (kind) => (kind === "mention_needs_nothing" ? 0 : kind === "note_reply" ? 0.9 : undefined),
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Revisado, tudo certo."] };
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["Passei a revisão para o @qa."] };
        if (last.includes("pede"))
          return {
            chunks: [],
            toolUses: [{ name: "tell_agent", input: { agent: "@qa", message: "Revise o PR 12, por favor." } }],
          };
        return { chunks: ["Certo."] };
      },
    });
    const qa = await addAgent("qa", "QA", "Testes");
    await say(f.general.id, "@dev pede a revisão do PR 12");
    await drainOutbox(f.db, f.handlers);
    const qaRuns = (await runs()).filter((r) => r.agentId === qa.id);
    expect(qaRuns).toHaveLength(1);
    expect(qaRuns[0]?.channelId).not.toBe(f.general.id);
  });

  test("tell_agent's answer asks to name it without the @", async () => {
    f = await setup({
      askAgent: true,
      reply: (req) => {
        if (inAgentDm(req)) return { chunks: ["Ok."] };
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["Feito."] };
        return { chunks: [], toolUses: [{ name: "tell_agent", input: { agent: "@qa", message: "Revise o PR 12." } }] };
      },
    });
    await addAgent("qa", "QA", "Testes");
    await say(f.general.id, "@dev pede a revisão do PR 12");
    await drainOutbox(f.db, f.handlers);
    const told = (await f.db.select().from(schema.agentRunSteps)).find(
      (s) => s.kind === "tool_result" && (s.data as { name?: string }).name === "tell_agent",
    );
    expect(String((told?.data as { content?: string } | undefined)?.content)).toContain("naming qa without the @");
  });

  test("the mention judge reads a recap or status for the people as needing nothing from the agents it names", async () => {
    const judge = createFakeJudge();
    await mentionNeedsNothing(judge, {
      orgId: "o",
      body: "Resumo: o @theo já está com o deploy, falta a revisão do @rui.",
      author: "@dev",
      targets: [{ agentId: "a-theo", handle: "theo", name: "Theo", role: null }],
    });
    const question = judge.calls[0]?.questions.nothing_0 as JudgeQuestion & { criteria: Record<string, string> };
    expect(question.criteria.true).toContain("a recap or status report written for the people");
    expect(question.criteria.false).toContain("work pointed at it that nobody handed it yet");
  });
});

describe("an agent's message never waits behind a question only a person answers", () => {
  test("a second note to an agent waiting on a person's answer starts a run of its own", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
      reply: (req) => {
        const last = lastText(req);
        if (isFor(req, "ops")) {
          if (last.includes("relatório")) return { chunks: ["Relatório atualizado."] };
          return askUser("Qual período o painel deve cobrir?");
        }
        if (last.includes("tool_result")) return { chunks: ["Passei para o ops."] };
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@ops", message: "Monte o painel de vendas." } }],
        };
      },
    });
    const ops = await addAgent("ops", "Ops", "Operações");
    await say(f.general.id, "@dev monte o painel de vendas com o ops");
    await drainOutbox(f.db, f.handlers);
    const [card] = await questions();
    const waiting = (await runs()).find((r) => r.id === card?.runId);
    expect(waiting).toMatchObject({ agentId: ops.id, status: "waiting_input" });
    const devRun = (await runs()).find((r) => r.agentId === f.agent.id);
    if (!devRun || !waiting) throw new Error("no runs");

    const sent = await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: devRun.id,
      hop: devRun.hop,
      targetAgentId: ops.id,
      body: "Atualize também o relatório semanal.",
      chain: [f.agent.id],
      deferStart: true,
    });
    if (!sent) throw new Error("not sent");
    const started = await startNoteRun(f.db, sent.message, ops.id);
    expect(started && "created" in started).toBe(true);
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === waiting.id)?.status).toBe("waiting_input");
    const own = (await runs()).find((r) => r.triggerMessageId === sent.message.id);
    expect(own).toMatchObject({ agentId: ops.id, status: "done" });
    expect((await questions())[0]?.status).toBe("open");
  });

  test("a note that came in while the run worked leaves its inbox when it pauses on a person's question", async () => {
    f = await setup({
      askAgent: true,
      askUser: true,
      judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
      reply: (req) => {
        const last = lastText(req);
        if (isFor(req, "ops")) {
          if (last.includes("relatório")) return { chunks: ["Relatório atualizado."] };
          return askUser("Qual período o painel deve cobrir?");
        }
        if (last.includes("tool_result")) return { chunks: ["Passei para o ops."] };
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@ops", message: "Monte o painel de vendas." } }],
        };
      },
    });
    const ops = await addAgent("ops", "Ops", "Operações");
    await say(f.general.id, "@dev monte o painel de vendas com o ops");
    await drainOutbox(f.db, f.handlers);
    const [card] = await questions();
    const devRun = (await runs()).find((r) => r.agentId === f.agent.id);
    if (!card || !devRun) throw new Error("no card");
    // Sent while that turn still worked: it joined the run, unread when the run paused on the question.
    const sent = await sendNote(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: devRun.id,
      hop: devRun.hop,
      targetAgentId: ops.id,
      body: "Atualize também o relatório semanal.",
      chain: [f.agent.id],
      deferStart: true,
    });
    if (!sent) throw new Error("not sent");
    await f.db
      .update(schema.agentRuns)
      .set({ pendingMessageIds: [sent.message.id] })
      .where(eq(schema.agentRuns.id, card.runId));
    expect(await releaseHeldInbox(f.db, f.pubsub, card.runId)).toMatchObject({ messageIds: [sent.message.id] });
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).find((r) => r.id === card.runId)?.status).toBe("waiting_input");
    const own = (await runs()).find((r) => r.triggerMessageId === sent.message.id);
    expect(own).toMatchObject({ agentId: ops.id, status: "done" });
  });

  test("a person's message stays with the run waiting on their answer", async () => {
    f = await setup({
      askUser: true,
      reply: (req) =>
        lastText(req).includes("tool_result") ? { chunks: ["Ok."] } : askUser("Em quais canais devo publicar?"),
    });
    await say(f.general.id, "@dev publique o resumo");
    await drainOutbox(f.db, f.handlers);
    const [card] = await questions();
    if (!card) throw new Error("no card");
    const { message: typed } = await insertMessageWithRuns(
      f.db,
      { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId: f.owner.id }, body: "no #vendas" },
      { startRuns: false, deliver: false },
    );
    await f.db
      .update(schema.agentRuns)
      .set({ pendingMessageIds: [typed.id] })
      .where(eq(schema.agentRuns.id, card.runId));
    expect(await releaseHeldInbox(f.db, f.pubsub, card.runId)).toBeNull();
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, card.runId));
    expect(run?.pendingMessageIds).toEqual([typed.id]);
  });
});
