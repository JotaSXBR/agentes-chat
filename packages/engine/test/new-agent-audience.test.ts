import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  applyImport,
  canTalkTo,
  createAgent,
  ForbiddenError,
  getOrgSettings,
  type MigrationBundle,
  NO_PERSON,
  setAgentBrain,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * Every default is open (ADR 0085 addendum, 2026-11-09; ADR 0059 §5, amended the same day): a new or imported agent
 * answers the whole workspace unless an admin narrowed the workspace's default, and its owner's plan keeps it so.
 */
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const MODEL = "claude-sonnet-5-5";

/** Two agents from another app, nothing else. */
const bundle = (ref: string): MigrationBundle => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openmausbot", ref, name: "Vendas", files: [] },
  agents: ["scout", "closer"].map((key) => ({
    key,
    name: `${key[0]?.toUpperCase()}${key.slice(1)}`,
    handle: `${key}-${ref}`,
    role: "",
    instructions: "",
    model: null,
    appearance: {},
    skills: [],
  })),
  skills: [],
  channels: [],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
});

async function world() {
  const fx = await setup();
  f = fx;
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const importAgents = async (ref: string) => {
    await applyImport(
      { db: fx.db, blobs: fx.artifactDeps.blobs, pubsub: fx.pubsub },
      fx.owner.id,
      fx.org.id,
      { dryRun: false, bundle: bundle(ref) },
      { model: MODEL },
    );
    const rows = await fx.db.select().from(schema.agents).where(eq(schema.agents.orgId, fx.org.id));
    return rows.filter((a) => a.handle.endsWith(`-${ref}`));
  };
  return { fx, bia, caio, importAgents };
}

describe("who can talk to a new agent", () => {
  test("imported agents answer the whole workspace, and still do once they think with their importer's plan", async () => {
    const { fx, bia, importAgents } = await world();
    const imported = await importAgents("one");
    expect(imported.map((a) => [a.ownerUserId, a.audienceMode])).toEqual([
      [fx.owner.id, "everyone"],
      [fx.owner.id, "everyone"],
    ]);
    // Their importer's Claude, on the computer they connected, for both of them.
    const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
      protocol: ACCOUNTS_PROTOCOL,
      exec: true,
    });
    await fx.db
      .update(schema.machines)
      .set({ executors: { claude: { version: "2.1.304", loggedIn: true }, detectedAt: new Date().toISOString() } })
      .where(eq(schema.machines.id, machineId));
    for (const a of imported) {
      await fx.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, a.id));
      expect(await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, a.id, { brain: "claude_code" })).toMatchObject({
        brain: "claude_code",
        onlyOwner: false,
      });
    }
    const after = await fx.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, imported[0]?.id ?? ""));
    expect(after[0]?.audienceMode).toBe("everyone");
    expect(after[0] && canTalkTo(after[0], bia.id, NO_PERSON)).toBe(true);
  });

  test("an admin narrows the workspace's default: imports and the API follow it, a choice and no owner don't", async () => {
    const { fx, bia, caio, importAgents } = await world();
    expect((await getOrgSettings(fx.db, bia.id, fx.org.id)).newAgentAudience).toBe("everyone");
    await expect(updateOrgSettings(fx.db, bia.id, fx.org.id, { newAgentAudience: "owner" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      updateOrgSettings(fx.db, caio.id, fx.org.id, { newAgentAudience: "nobody" as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await updateOrgSettings(fx.db, caio.id, fx.org.id, { newAgentAudience: "owner" })).newAgentAudience).toBe(
      "owner",
    );

    expect((await importAgents("two")).map((a) => a.audienceMode)).toEqual(["owner", "owner"]);
    const make = (handle: string, extra: { audienceMode?: "everyone" | "owner"; ownerUserId?: string | null }) =>
      createAgent(fx.db, caio.id, fx.org.id, { name: handle, handle, ...extra }, { model: MODEL });
    expect((await make("api", {})).audienceMode).toBe("owner");
    // Criar agente sends what the person picked.
    expect((await make("picked", { audienceMode: "everyone" })).audienceMode).toBe("everyone");
    // With nobody responsible, "only its owner" would be nobody: it stays open.
    expect((await make("orphan", { ownerUserId: null })).audienceMode).toBe("everyone");
  });
});
