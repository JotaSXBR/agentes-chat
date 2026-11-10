import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { createIssue, drainOutbox, postPersonMessage, taskManager, updateAgent } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const toDo = async (n: number, extra: { audience?: { userIds: string[] } } = {}) => {
  for (let i = 0; i < n; i++) {
    await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, {
      title: `Migrate service ${i + 1}`,
      assignee: { type: "agent", id: f.agent.id },
      ...(extra.audience ? { audience: { mode: "people" as const, userIds: extra.audience.userIds } } : {}),
    });
  }
};

describe("why a free agent's tasks to do haven't started (a computer read 'room' while tasks sat idle)", () => {
  test("a free agent with tasks on the board says how many and that they start when there's room", async () => {
    f = await setup();
    await toDo(3);
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.tasks).toEqual([]);
    expect(view.backlog).toEqual({ [f.agent.id]: { todo: 3, out: null } });
  });

  test("its budget spent: they wait until the month renews", async () => {
    f = await setup();
    await toDo(2);
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 1_000_000 });
    const now = new Date();
    await f.db
      .insert(schema.agentBudgetPeriods)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10),
        spentNanoUsd: 2_000_000,
      })
      .onConflictDoUpdate({
        target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
        set: { spentNanoUsd: 2_000_000 },
      });
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    expect(view.backlog[f.agent.id]).toEqual({ todo: 2, out: { reason: "budget", until: nextMonth } });
  });

  test("only the tasks the viewer may see count", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await toDo(1);
    await toDo(2, { audience: { userIds: [f.owner.id] } });
    expect((await taskManager(f.db, f.owner.id, f.org.id)).backlog[f.agent.id]?.todo).toBe(3);
    expect((await taskManager(f.db, bia.id, f.org.id)).backlog[f.agent.id]?.todo).toBe(1);
  });
});

describe("what a waiting task waits on", () => {
  test("a question names who it's for and, with a default, what the run goes on with and when", async () => {
    const reply = (req: ModelRequest) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (!last.includes("deploy it")) return { chunks: ["Feito."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "ask_user",
            input: {
              why: "Both look right from the repository: this decides which one I set up next.",
              question: "Qual ambiente?",
              choices: ["staging", "production"],
              default: "staging",
            },
          },
        ],
      };
    };
    f = await setup({ askUser: true, reply });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev deploy it",
    });
    await drainOutbox(f.db, f.handlers);
    const [question] = await f.db.select().from(schema.agentQuestions);
    const [task] = (await taskManager(f.db, f.owner.id, f.org.id)).tasks;
    expect(task?.status).toBe("waiting_input");
    expect(task?.asks).toEqual({
      kind: "question",
      forUserId: f.owner.id,
      defaultAnswer: "staging",
      decideAt: question?.expiresAt.toISOString() ?? null,
    });
  });
});
