import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  answerQuestion,
  deleteAccount,
  dismissQuestion,
  drainOutbox,
  ForbiddenError,
  insertMessage,
  listMembers,
  listThreads,
  postPersonMessage,
  removeChannelMember,
  removeMember,
  setMemberRoles,
  workViews,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WHY = "I need a person's answer before I go on: this decides what I change next.";
/** Why a question goes to someone other than who asked (`person_why`). */
const FOR = "Só ela esteve na reunião.";

/** "@dev ask: <json>": the agent calls `ask_user` with that input, then ends its turn. */
const reply = (req: ModelRequest) => {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  const input = /ask: (\{.*?\})(?:\\n|")/.exec(last.replaceAll('\\"', '"'))?.[1];
  return input
    ? { chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, ...JSON.parse(input) } }] }
    : { chunks: ["Feito."] };
};

const setupRoom = async () => {
  f = await setup({ askUser: true, reply });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  return { bia };
};

const say = async (userId: string, body: string, threadId?: string) => {
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
    body,
    threadId,
  });
  await drainOutbox(f.db, f.handlers);
  return message;
};

const ask = (input: Record<string, unknown>) => `@dev ask: ${JSON.stringify(input)}`;

const questions = () => f.db.select().from(schema.agentQuestions);
const deps = () => ({ db: f.db, pubsub: f.pubsub });

describe("a question for one person", () => {
  test("it waits on them alone: only they answer it, skip it or hear about it", async () => {
    const { bia } = await setupRoom();
    const root = await say(f.owner.id, "plano");
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "@bia", person_why: FOR }), root.id);

    const [q] = await questions();
    expect(q).toMatchObject({ requestedForUserId: bia.id, status: "open" });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, q?.messageId ?? ""));
    // The card says why it is hers and not who asked.
    expect(card?.meta.question).toMatchObject({ requestedForUserId: bia.id, forWhy: FOR });

    // The owner of the workspace is no exception.
    const id = q?.id ?? "";
    await expect(answerQuestion(deps(), f.owner.id, f.org.id, id, { text: "eu sei" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(dismissQuestion(deps(), f.owner.id, f.org.id, id)).rejects.toBeInstanceOf(ForbiddenError);

    const waiting = (await f.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
    expect(waiting.map((n) => n.userId)).toEqual([bia.id]);
    const needsYou = async (userId: string) =>
      (await listThreads(f.db, userId, { orgId: f.org.id, needsYou: true })).threads.map((t) => t.id);
    expect(await needsYou(bia.id)).toEqual([root.id]);
    expect(await needsYou(f.owner.id)).toEqual([]);

    // Someone else replying in the thread doesn't answer it, nor who asked once another word came after the card.
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    await say(caio.id, "acho que foi sexta", root.id);
    await say(f.owner.id, "acho que foi sexta também", root.id);
    expect((await questions())[0]?.status).toBe("open");
    await say(bia.id, "foi sexta", root.id);
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "foi sexta", answeredByUserId: bia.id });
  });

  test("in a channel's main timeline, their plain reply answers it", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia", person_why: FOR }));
    await say(bia.id, "foi sexta");
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "foi sexta" });
  });

  test("they can skip it from the card", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia", person_why: FOR }));
    const [q] = await questions();
    await dismissQuestion(deps(), bia.id, f.org.id, q?.id ?? "");
    expect((await questions())[0]).toMatchObject({ status: "dismissed", answeredByUserId: bia.id });
  });

  test("a person who can't read the conversation can't be asked there: the agent hears why", async () => {
    await setupRoom();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: caio.name, person_why: FOR }));
    await say(f.owner.id, ask({ question: "E agora?", person: "ninguem" }));
    expect(await questions()).toEqual([]);
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { content: string; isError: boolean });
    expect(results.map((r) => [r.isError, r.content])).toEqual([
      [true, expect.stringContaining("isn't in this conversation")],
      [true, expect.stringContaining('No one called "ninguem"')],
    ]);
  });

  test("an administrator reads the channel without being in it, so they can be asked; demoted, it goes back to the room", async () => {
    await setupRoom();
    const adm = await addMember(f.db, f.org.id, "admin", "carla");
    await say(f.owner.id, ask({ question: "Qual o orçamento?", person: adm.name, person_why: FOR }));
    const [q] = await questions();
    expect(q).toMatchObject({ requestedForUserId: adm.id, status: "open" });

    await setMemberRoles(f.db, f.owner.id, f.org.id, adm.id, [], { pubsub: f.pubsub });
    const [after] = await questions();
    expect(after).toMatchObject({ requestedForUserId: null, status: "open" });
    await answerQuestion(deps(), f.owner.id, f.org.id, after?.id ?? "", { text: "R$ 10 mil" });
    expect((await questions())[0]).toMatchObject({ status: "answered", answeredByUserId: f.owner.id });
  });

  test("someone else's message doesn't wait behind it: it gets a run of its own, the question stays theirs", async () => {
    const { bia } = await setupRoom();
    const root = await say(f.owner.id, "plano");
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia", person_why: FOR }), root.id);
    const said = await say(f.owner.id, "@dev enquanto isso, qual o status?", root.id);

    const runs = await f.db.select().from(schema.agentRuns);
    const waiting = runs.find((r) => r.status === "waiting_input");
    expect(waiting?.pendingMessageIds).toEqual([]);
    expect(runs.find((r) => r.triggerMessageId === said.id)?.status).toBe("done");
    expect((await questions())[0]).toMatchObject({ status: "open", requestedForUserId: bia.id });

    // Theirs still goes to the waiting run.
    await say(bia.id, "foi sexta", root.id);
    expect((await questions())[0]).toMatchObject({ status: "answered", answeredByUserId: bia.id });
    expect((await f.db.select().from(schema.agentRuns)).every((r) => r.status === "done")).toBe(true);
  });

  const leaving: [string, (userId: string) => Promise<unknown>][] = [
    [
      "leaves the channel",
      (id) => removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: id }, { pubsub: f.pubsub }),
    ],
    ["leaves the workspace", (id) => removeMember(f.db, f.owner.id, f.org.id, id, { pubsub: f.pubsub })],
    ["deletes their account", (id) => deleteAccount(f.db, id, { pubsub: f.pubsub })],
  ];
  for (const [how, leave] of leaving) {
    test(`the person it is for ${how}: it goes back to the room, whose reply answers it`, async () => {
      const { bia } = await setupRoom();
      const root = await say(f.owner.id, "plano");
      await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia", person_why: FOR }), root.id);
      await leave(bia.id);

      const [q] = await questions();
      expect(q).toMatchObject({ status: "open", requestedForUserId: null });
      const [card] = await f.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, q?.messageId ?? ""));
      expect(card?.meta.question).toMatchObject({ requestedForUserId: null });
      const open = (await f.db.select().from(schema.notifications)).filter(
        (n) => n.kind === "agent_question" && !n.doneAt,
      );
      expect(open.map((n) => n.userId)).toEqual([f.owner.id]);
      await answerQuestion(deps(), f.owner.id, f.org.id, q?.id ?? "", { text: "sexta" });
      expect((await questions())[0]).toMatchObject({ status: "answered", answeredByUserId: f.owner.id });
    });
  }

  test("a long work's view carries who it waits for", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia", person_why: FOR }));
    const [run] = await f.db.select().from(schema.agentRuns);
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        anchorMessageId: run?.triggerMessageId ?? "",
        title: "Combinado",
        ownThread: false,
        how: "agent",
        lastUpdateAt: new Date(),
        status: "live",
      })
      .returning();
    await f.db.update(schema.agentRuns).set({ workId: work?.id });
    const view = (await workViews(f.db, f.org.id, [work?.id ?? ""])).get(work?.id ?? "");
    expect(view?.question).toMatchObject({ requestedForUserId: bia.id });
  });
});

describe("a question that doesn't say who it is for", () => {
  test("it waits on who asked: only they answer it from the card, and they hear about it", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual ambiente?" }));
    await say(bia.id, ask({ question: "Bia e ana, qual foi o combinado?" }));
    const [biaAsked, ownerAsked] = (await questions()).sort((a, b) => a.text.localeCompare(b.text));
    expect([biaAsked?.requestedForUserId, ownerAsked?.requestedForUserId]).toEqual([bia.id, f.owner.id]);
    await expect(
      answerQuestion(deps(), bia.id, f.org.id, ownerAsked?.id ?? "", { text: "staging" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const waiting = (await f.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
    expect(waiting.map((n) => n.userId).sort()).toEqual([f.owner.id, bia.id].sort());
  });

  test("it names someone else: their name alone proves nothing, it still waits on who asked", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Bia, qual foi o combinado?" }));
    const [q] = await questions();
    expect(q?.requestedForUserId).toBe(f.owner.id);
    await expect(answerQuestion(deps(), bia.id, f.org.id, q?.id ?? "", { text: "sexta" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("it names who just wrote here, as a whole word: they are who it replies to, though someone else asked", async () => {
    const questionFor: Record<string, string> = { "plano A": "Bia, qual foi?", "plano B": "Quem cuida da biallelic?" };
    f = await setup({
      askUser: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Ok."] };
        const plan = Object.keys(questionFor).find((k) => last.includes(k));
        const question = plan ? questionFor[plan] : undefined;
        return question
          ? { chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, question } }] }
          : { chunks: ["Feito."] };
      },
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    for (const plan of Object.keys(questionFor)) {
      const root = await say(f.owner.id, "planos");
      // Bia writes while the run started on the owner's message is about to answer it.
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
        body: `@dev me ajuda com o ${plan}`,
        threadId: root.id,
      });
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "person", userId: bia.id },
        body: "eu estava lá",
      });
      await drainOutbox(f.db, f.handlers);
    }
    const asked = (await questions()).sort((a, b) => a.text.localeCompare(b.text));
    expect(asked.map((q) => [q.text, q.requestedForUserId])).toEqual([
      ["Bia, qual foi?", bia.id],
      ["Quem cuida da biallelic?", f.owner.id],
    ]);
  });
});

describe("a question for someone other than who asked", () => {
  test("the agent must say why, and the card shows it", async () => {
    const { bia } = await setupRoom();
    await say(f.owner.id, ask({ question: "Qual foi o combinado?", person: "bia" }));
    expect(await questions()).toEqual([]);
    const [refused] = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { content: string; isError: boolean });
    expect(refused).toMatchObject({ isError: true, content: expect.stringContaining("person_why") });

    // Who asked, by name, needs no reason.
    await say(bia.id, ask({ question: "Qual ambiente?", person: "bia" }));
    const [q] = await questions();
    expect(q?.requestedForUserId).toBe(bia.id);
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, q?.messageId ?? ""));
    expect(card?.meta.question).not.toHaveProperty("forWhy");
  });

  test("who asked answers it in the chat right after the card: it counts, and the run goes on with it", async () => {
    const { bia } = await setupRoom();
    const root = await say(f.owner.id, "plano");
    await say(f.owner.id, ask({ question: "Qual o endereço do servidor?", person: "bia", person_why: FOR }), root.id);
    await say(f.owner.id, "servidor.example.com", root.id);
    expect((await questions())[0]).toMatchObject({
      status: "answered",
      answer: "servidor.example.com",
      answeredByUserId: f.owner.id,
      requestedForUserId: bia.id,
    });
    const told = JSON.stringify(f.provider.calls.at(-1)?.request.messages.at(-1)?.content);
    expect(told).toContain("The person answered: servidor.example.com");
    expect((await f.db.select().from(schema.agentRuns)).every((r) => r.status === "done")).toBe(true);
  });

  test("not with a word naming someone, nor once someone else wrote after the card", async () => {
    const { bia } = await setupRoom();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    // Their handles, so "@bia" names her.
    await listMembers(f.db, f.org.id);
    const root = await say(f.owner.id, "plano");
    await say(f.owner.id, ask({ question: "Qual o endereço do servidor?", person: "bia", person_why: FOR }), root.id);
    await say(f.owner.id, "@bia você sabe?", root.id);
    expect((await questions())[0]?.status).toBe("open");
    await say(caio.id, "não sei", root.id);
    await say(f.owner.id, "servidor.example.com", root.id);
    expect((await questions())[0]?.status).toBe("open");
    await say(bia.id, "servidor.example.com", root.id);
    expect((await questions())[0]).toMatchObject({ status: "answered", answeredByUserId: bia.id });
  });
});
