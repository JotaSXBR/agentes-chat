import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

/** The owner and a member who joined by invitation. */
async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${seeded.orgId}/invitations`, {
      json: { email: "ana@example.com", role: "member" },
    })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { owner: api(owner), member: api(member) };
}

const modeOf = async (res: Response) => ((await res.json()) as { audienceMode: string }).audienceMode;

test("the workspace's default for new agents: open until whoever configures it narrows it; a choice wins", async () => {
  const w = await workspace();
  const read = async () =>
    ((await (await w.member("/settings")).json()) as { newAgentAudience: string }).newAgentAudience;
  expect(await read()).toBe("everyone");
  expect(await modeOf(await w.owner("/agents", { json: { name: "Eva", handle: "eva" } }))).toBe("everyone");

  expect((await w.member("/settings", { method: "PATCH", json: { newAgentAudience: "owner" } })).status).toBe(403);
  expect((await w.owner("/settings", { method: "PATCH", json: { newAgentAudience: "nobody" } })).status).toBe(400);
  const patched = await w.owner("/settings", { method: "PATCH", json: { newAgentAudience: "owner" } });
  expect(patched.status).toBe(200);
  expect(await read()).toBe("owner");

  // Made with no choice (an app, a script): its owner alone. Criar agente sends the person's choice, which wins.
  expect(await modeOf(await w.owner("/agents", { json: { name: "Leo", handle: "leo" } }))).toBe("owner");
  const picked = await w.owner("/agents", {
    json: { name: "Mia", handle: "mia", audience: { mode: "everyone", userIds: [] } },
  });
  expect(await modeOf(picked)).toBe("everyone");
});
