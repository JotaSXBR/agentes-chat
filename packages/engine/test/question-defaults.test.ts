import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  answerQuestion,
  drainOutbox,
  expireQuestions,
  listMessages,
  postPersonMessage,
  questionView,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
const WHY = "Both look right from the repository: this decides which one I set up next.";

/** Asks where to deploy, with `fallback` as its default; then says what it went on with. */
const asking = (fallback?: string) => (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) {
    const went = /answered: ([a-z]+)|your default, ([a-z]+)/.exec(last);
    return { chunks: [`Ok: ${went?.[1] ?? went?.[2] ?? "no answer"}`] };
  }
  if (last.includes("deploy it"))
    return {
      chunks: [],
      toolUses: [
        {
          name: "ask_user",
          input: {
            why: WHY,
            question: "Qual ambiente?",
            choices: ["staging", "production"],
            ...(fallback ? { default: fallback } : {}),
          },
        },
      ],
    };
  return { chunks: ["Feito."] };
};

const deployIt = () =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev deploy it" });
const questions = () => f.db.select().from(schema.agentQuestions);
const runs = () => f.db.select().from(schema.agentRuns);
const minutesLeft = (at: Date | undefined) => ((at?.getTime() ?? 0) - Date.now()) / 60_000;

describe("a question with a default (a task's conversation waiting all night)", () => {
  test("nobody answers: after the workspace's wait the run goes on with it, says so, and the card shows it", async () => {
    f = await setup({ askUser: true, reply: asking("staging") });
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    expect(q).toMatchObject({ status: "open", defaultAnswer: "staging" });
    // The workspace's default wait: half an hour, not a day.
    expect(minutesLeft(q?.expiresAt)).toBeGreaterThan(29);
    expect(minutesLeft(q?.expiresAt)).toBeLessThan(31);
    const card = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === q?.messageId);
    expect(card?.meta.question).toMatchObject({ defaultAnswer: "staging", decideAt: q?.expiresAt.toISOString() });

    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub })).toBe(0);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 31 * 60_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    const told = lastText(f.provider.calls.at(-1)?.request as ModelRequest);
    expect(told).toContain("Nobody answered in time: go on with your default, staging");
    expect(told).toContain("anything that asks for approval still waits for a person");
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.at(-1)?.body).toBe("Ok: staging");
    expect(after.find((m) => m.id === q?.messageId)?.meta.question).toMatchObject({
      status: "answered",
      defaulted: true,
      defaultAnswer: "staging",
    });
  });

  test("a person answering first wins, and the default never applies", async () => {
    f = await setup({ askUser: true, reply: asking("staging") });
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", { choice: "production" });
    await drainOutbox(f.db, f.handlers);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 31 * 60_000))).toBe(0);
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person answered: production");
    const [closed] = await questions();
    expect(closed && questionView(closed).defaulted).toBeUndefined();
  });

  test("the wait is the workspace's setting; at once while the person it's for is out of office", async () => {
    f = await setup({ askUser: true, reply: asking("staging") });
    await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { questionWaitMinutes: 15 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await updateOrgSettings(f.db, f.owner.id, f.org.id, { questionWaitMinutes: 10 })).questionWaitMinutes).toBe(
      10,
    );
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    const [first] = await questions();
    expect(first?.requestedForUserId).toBe(f.owner.id);
    expect(minutesLeft(first?.expiresAt)).toBeGreaterThan(9);
    expect(minutesLeft(first?.expiresAt)).toBeLessThan(11);

    await f.db
      .update(schema.organizationMembers)
      .set({ availability: "out" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
    await f.db.delete(schema.agentQuestions);
    await f.db.delete(schema.agentRuns);
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    const [away] = await questions();
    expect(minutesLeft(away?.expiresAt)).toBeLessThanOrEqual(0);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 1000))).toBe(1);
  });

  test("without a default it waits a day; a default that isn't one of the choices is refused", async () => {
    f = await setup({ askUser: true, reply: asking() });
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    expect(q?.defaultAnswer).toBeNull();
    expect(minutesLeft(q?.expiresAt)).toBeGreaterThan(23 * 60);

    await f.close();
    f = await setup({ askUser: true, reply: asking("dev") });
    await deployIt();
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toEqual([]);
    const refusal = f.provider.calls.map((c) => lastText(c.request)).find((text) => text.includes("Not asked"));
    expect(refusal).toContain("`default` must be one of your `choices`");
  });
});
