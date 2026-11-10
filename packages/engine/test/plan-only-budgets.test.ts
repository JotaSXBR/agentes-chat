import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  BudgetExceededError,
  budgetsShown,
  createModelGateway,
  RIGHT_HAND,
  revokeCredential,
  rightHandPrompt,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PLATFORM = { resolve: async () => ({ apiKey: "platform-key" }) };

/** No API key of the workspace's own: its agents' API calls run on the server's (platform) key. */
async function noKeyOfItsOwn() {
  await revokeCredential(f.db, f.owner.id, f.org.id, f.credential.id);
  await f.db.update(schema.agents).set({ credentialId: null }).where(eq(schema.agents.id, f.agent.id));
}

const gatewayHeard = (heard: string[]) =>
  createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: { ...noPlatformCredentials, ...PLATFORM },
    providers: { anthropic: f.provider },
    onBudgetThreshold: async (e) => {
      heard.push(e.level);
    },
  });

const once = (gateway: ReturnType<typeof createModelGateway>) =>
  gateway.stream({
    orgId: f.org.id,
    agentId: f.agent.id,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
    onDelta: () => {},
  });

test("with an API key, a spent budget stops the call and tells its owner", async () => {
  f = await setup({ budgetNanoUsd: 1, platform: PLATFORM });
  const heard: string[] = [];
  expect(await budgetsShown(f.db, f.org.id)).toBe(true);
  await expect(once(gatewayHeard(heard))).rejects.toBeInstanceOf(BudgetExceededError);
  expect(heard).toEqual(["exhausted"]);
});

test("with no API key of its own, a call on the server's key keeps the agent's budget: nothing else caps it", async () => {
  f = await setup({ budgetNanoUsd: 1, platform: PLATFORM });
  await noKeyOfItsOwn();
  // Nobody here is told about budgets (the right hand's lines, the week's offers)…
  expect(await budgetsShown(f.db, f.org.id)).toBe(false);
  // …yet whoever runs the server pays for this key, and only the agent's budget stops a call on it.
  const heard: string[] = [];
  await expect(once(gatewayHeard(heard))).rejects.toBeInstanceOf(BudgetExceededError);
  expect(heard).toEqual(["exhausted"]);
  expect(f.provider.calls).toHaveLength(0);
});

test("the right hand says nothing about budgets in a workspace without an API key", async () => {
  f = await setup({ rightHand: true, platform: PLATFORM });
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const prompt = () =>
    rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true });
  expect(await prompt()).toMatch(/@dev \(Dev\)[^\n]*budget US\$/);
  await noKeyOfItsOwn();
  const without = await prompt();
  expect(without).toContain("@dev (Dev)");
  expect(without).not.toMatch(/monthly budget|budget US\$/);
});
