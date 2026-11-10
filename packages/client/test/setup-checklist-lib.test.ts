import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentSetupChecklist } from "../src/api/types";
import {
  beatRow,
  FIRST_RUN_STEPS,
  type FirstRunFacts,
  type FirstRunPowers,
  firstRunAiLabel,
  firstRunAppList,
  firstRunApps,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
  setupRole,
  teamRole,
} from "../src/lib/setup-checklist";

describe("the right hand's first run (ADR 0155 §6, ADR 0158)", () => {
  const lodi = (setup: AgentSetupChecklist | null = { role: null, done: [] }) => ({
    setup,
    builtin: "right_hand" as const,
  });
  const owner: FirstRunPowers = { owner: true, connectAi: true, pay: true, connectors: true, invite: true };
  const none: FirstRunFacts = { ai: false, apps: false, people: false };

  test("what the onboarding leaves, one order everywhere, for the owners, each row by what they may do", () => {
    expect(FIRST_RUN_STEPS).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), owner)).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), { ...owner, connectors: false, invite: false })).toEqual(["ai"]);
    // An invited person sees none of it, nor anyone once the right hand has no checklist; nor on another agent.
    expect(firstRunSteps(lodi(), { ...owner, owner: false })).toEqual([]);
    expect(firstRunSteps(lodi(null), owner)).toEqual([]);
    expect(firstRunSteps({ setup: { role: null, done: [] }, builtin: null }, owner)).toEqual([]);
  });

  test("each row reads done from its data; only a skip of apps or people is stored", () => {
    const setup = { role: null, done: [] };
    expect([...firstRunDone(setup, none)]).toEqual([]);
    expect([...firstRunDone(setup, { ai: true, apps: true, people: true })]).toEqual(["ai", "apps", "people"]);
    expect([...firstRunDone({ role: null, done: ["apps", "people"] }, none)]).toEqual(["apps", "people"]);
    // Only a skip is stored: a stored "ai", or any other step, ticks nothing here.
    expect([...firstRunDone({ role: null, done: ["ai", "who"] }, none)]).toEqual([]);
  });

  test("on a hold every row waits for the plan, a skipped one stays done, and no ask shows", () => {
    const done = firstRunDone({ role: null, done: ["apps"] }, none);
    const state = (s: Parameters<typeof firstRunRowState>[0], held: boolean) => firstRunRowState(s, { done, held });
    expect(FIRST_RUN_STEPS.map((s) => state(s, true))).toEqual(["afterPlan", "done", "afterPlan"]);
    expect(FIRST_RUN_STEPS.map((s) => state(s, false))).toEqual(["open", "done", "open"]);
    const thinks = new Set([...done, "ai" as const]);
    expect(firstRunAsks(thinks, true, true)).toBe(false);
    expect(firstRunAsks(thinks, false, true)).toBe(true);
    // The asks are for a team: none before there is one.
    expect(firstRunAsks(thinks, false, false)).toBe(false);
    expect(firstRunAsks(done, false, true)).toBe(false);
  });

  test("its words: open rows ask, done rows say what is there, apps and people may be skipped", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    const f = { org: "Acme", label: "Claude", apps: "Gmail", members: 1, invited: null };
    expect(firstRunRow(t, "apps", "open", f, false)).toEqual({
      title: 'agentSetup.firstRun.apps.todo {"org":"Acme"}',
      desc: 'agentSetup.firstRun.apps.todoDesc {"org":"Acme"}',
      action: "agentSetup.firstRun.apps.action",
      skip: "agentSetup.firstRun.notNow",
    });
    expect(firstRunRow(t, "ai", "done", f, false).title).toBe('agentSetup.firstRun.ai.done {"label":"Claude"}');
    expect(firstRunRow(t, "ai", "done", { ...f, label: null }, false).title).toBe("agentSetup.firstRun.ai.doneAny");
    expect(firstRunRow(t, "people", "done", f, true).title).toBe("agentSetup.firstRun.people.doneNone");
    expect(firstRunRow(t, "ai", "afterPlan", f, false)).toEqual({
      title: 'agentSetup.firstRun.ai.todo {"org":"Acme"}',
      desc: "agentSetup.firstRun.afterPlan",
      action: "",
    });
  });

  test("the AI it names: a plan's line, else its API's maker, the workspace key's on Automático", () => {
    expect(firstRunAiLabel({ text: "Sonnet pelo plano do Claude", kind: "claude_code" }, "anthropic")).toBe(
      "Sonnet pelo plano do Claude",
    );
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, "anthropic")).toBe("Claude");
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, undefined)).toBeNull();
  });

  test("an invitation waiting for its answer finishes the people row, by who was invited", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    expect([...firstRunDone({ role: null, done: [] }, { ...none, people: true })]).toEqual(["people"]);
    const f = { org: "Acme", label: null, apps: null, members: 1, invited: "joao.lima@example.com" };
    expect(firstRunRow(t, "people", "done", f, false).title).toBe(
      'agentSetup.firstRun.people.invited {"names":"joao.lima@example.com"}',
    );
    // Once someone joined, how many people are here.
    expect(firstRunRow(t, "people", "done", { ...f, members: 2 }, false).title).toBe(
      'agentSetup.firstRun.people.done {"count":2}',
    );
  });

  test("an invitation only sent is a beat of its own, so the right hand says it went out; someone joining is the one it celebrates", () => {
    expect(firstRunBeats(["ai", "people"], { members: 1, invited: 1 })).toEqual(["ai", "invited"]);
    // The same row turns `people` as the invitee joins: a beat of its own, so it has its line then.
    expect(firstRunBeats(["ai", "people"], { members: 2, invited: 0 })).toEqual(["ai", "people"]);
    // Skipped with nobody invited: `people`, which says nothing (the card's rule for a skip).
    expect(firstRunBeats(["people"], { members: 1, invited: 0 })).toEqual(["people"]);
    expect(beatRow("invited")).toBe("people");
    expect(beatRow("apps")).toBe("apps");
  });

  test("the apps a team made from a template would use, the most suggested first", () => {
    expect(setupRole({ role: "support", done: [] })).toBe("support");
    expect(setupRole({ role: "not-a-role", done: [] })).toBeNull();
    expect(setupRole({ role: "custom", done: [] })).toBeNull();
    const a = (handle: string) => ({ handle, setup: null });
    expect(teamRole(a("iara-2"))).toBe("support");
    expect(teamRole({ handle: "zed", setup: { role: "dev", done: [] } })).toBe("dev");
    expect(teamRole(a("zed"))).toBeNull();
    expect(firstRunApps([a("iara"), a("bia")]).slice(0, 1)).toEqual(["intercom"]);
    expect(firstRunApps([a("zed")])).toEqual([]);
  });

  test("the apps row lists the apps that connect in one click here, not connected yet, the team's first", () => {
    const def = (
      id: string,
      more: Partial<{
        auth: ("oauth" | "api_key")[];
        oauthConfigured: boolean;
        available: boolean;
        soon: boolean;
      }> = {},
    ) => ({
      id,
      auth: ["oauth" as const],
      oauthConfigured: true,
      available: true,
      ...more,
    });
    const defs = [
      def("gmail"),
      def("intercom"),
      def("apikey", { auth: ["api_key"] }),
      def("off", { oauthConfigured: false }),
      def("later", { available: false }),
      def("vendor", { soon: true }),
      def("notion"),
    ];
    const list = firstRunAppList(defs, new Set(["notion"]), [{ handle: "iara", setup: null }]);
    expect(list.map((x) => [x.def.id, x.suggested])).toEqual([
      ["intercom", true],
      ["gmail", false],
    ]);
    expect(
      firstRunAppList(
        Array.from({ length: 9 }, (_, i) => def(`app${i}`)),
        new Set(),
        [],
      ),
    ).toHaveLength(6);
  });
});
