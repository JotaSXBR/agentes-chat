import type { TFunction } from "i18next";
import type { Agent, AgentSetupChecklist, ConnectorDef, SetupStep } from "../api/types";
import { ROLE_DEFAULTS, ROLE_IDS, type RoleId } from "./new-agent";
import { providerLabel } from "./providers";

/*
 * The right hand's first run (ADR 0155 §6, ADR 0162): the one setup checklist, inside its greeting for the
 * workspace's owners. Other agents have none: one that needs something asks for it in the conversation, when it does.
 * The server keeps the rows skipped, and the ready-made role each agent started from. These are the rules the apps
 * share.
 */

/** The ready-made role an agent started from, if the apps know it ("custom" is from scratch: none). */
export const setupRole = (setup: AgentSetupChecklist | null | undefined): RoleId | null =>
  setup?.role && setup.role !== "custom" && (ROLE_IDS as readonly string[]).includes(setup.role)
    ? (setup.role as RoleId)
    : null;

/** One row of the checklist: what it says, a line under it while left, its button's word. */
export interface SetupRow {
  title: string;
  desc?: string;
  action: string;
}

/**
 * Its rows, one order everywhere: what the onboarding's steps leave (they made the workspace, said what it does and
 * made the team): an AI, apps, people. A personal workspace (ADR 0159), which the onboarding opens at once, starts
 * with what the person wants help with and their agents, and has no people row.
 */
export const FIRST_RUN_STEPS = ["about", "team", "ai", "apps", "people"] as const satisfies readonly SetupStep[];
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** What may each row's button do for this person (`stepPermissions` in lib/home, plus `configure`). */
export interface FirstRunPowers {
  owner: boolean;
  configure: boolean;
  createAgents: boolean;
  connectAi: boolean;
  pay: boolean;
  connectors: boolean;
  invite: boolean;
  /** A personal workspace (ADR 0159): its first run has no people row, it is for one person. */
  personal?: boolean;
}

/**
 * The rows this person sees: the right hand's checklist is for the workspace's owners, each row by what they may do.
 * An invited person sees none of it (their own Connect card and the style card, as before), nor anyone once the
 * right hand has no checklist (a workspace that had a team before it).
 */
export function firstRunSteps(agent: Pick<Agent, "setup" | "builtin">, may: FirstRunPowers): FirstRunStep[] {
  if (agent.builtin !== "right_hand" || !agent.setup || !may.owner) return [];
  const row: Record<FirstRunStep, boolean> = {
    about: Boolean(may.personal) && may.configure,
    team: Boolean(may.personal) && may.createAgents,
    ai: may.connectAi || may.pay,
    apps: may.connectors,
    people: may.invite && !may.personal,
  };
  return FIRST_RUN_STEPS.filter((s) => row[s]);
}

/** What the workspace's data says, read by the apps (mirror of the prompt's `cardOpen`, engine right-hand-prompt). */
export interface FirstRunFacts {
  /** The workspace's context isn't empty. */
  context: boolean;
  /** An agent besides the right hand exists. */
  team: boolean;
  /** The right hand's AI is ready or waiting for its computer, and no billing hold. */
  ai: boolean;
  /** An app is connected. */
  apps: boolean;
  /** More than one member, or an invitation waiting for its answer. */
  people: boolean;
}

/** Whether the data did a row (a skip doesn't): what a row's line and burst celebrate. */
export const firstRunFact = (facts: FirstRunFacts, step: FirstRunStep) => facts[step === "about" ? "context" : step];

/**
 * The line a row says once done. A personal workspace's own words; its first two rows are only ever its own, so they
 * have no other.
 */
export const firstRunSayKey = (step: FirstRunStep, personal: boolean) => {
  if (step === "about" || step === "team") return `agentSetup.firstRun.say.${step}Personal` as const;
  return personal ? (`agentSetup.firstRun.say.${step}Personal` as const) : (`agentSetup.firstRun.say.${step}` as const);
};

/** The rows done: from the data, or skipped ("Agora não", the only thing stored). */
export function firstRunDone(setup: AgentSetupChecklist, facts: FirstRunFacts): Set<FirstRunStep> {
  const done = new Set<FirstRunStep>();
  if (facts.context) done.add("about");
  if (facts.team) done.add("team");
  if (facts.ai) done.add("ai");
  if (facts.apps || setup.done.includes("apps")) done.add("apps");
  if (facts.people || setup.done.includes("people")) done.add("people");
  return done;
}

/**
 * What the right hand's line of the moment follows: each row done, the people row twice, `invited` while its
 * invitations only wait for an answer, then `people` once someone joined. Joining is what it celebrates; an
 * invitation it only says is sent.
 */
export type FirstRunBeat = FirstRunStep | "invited";

export const firstRunBeats = (done: readonly FirstRunStep[], f: { members: number; invited: number }): FirstRunBeat[] =>
  done.map((s) => (s === "people" && f.members <= 1 && f.invited > 0 ? "invited" : s));

/** The row a beat's line shows under. */
export const beatRow = (beat: FirstRunBeat): FirstRunStep => (beat === "invited" ? "people" : beat);

/** How a row reads now: done, open, or waiting for the plan (a billing hold: the hold's banner holds the plan). */
export type FirstRunRowState = "done" | "open" | "afterPlan";

/** How a row reads now. On a hold a personal workspace's first two rows stay open: its agents wait for the plan asleep. */
export const firstRunRowState = (
  step: FirstRunStep,
  s: { done: ReadonlySet<FirstRunStep>; held: boolean },
): FirstRunRowState =>
  s.done.has(step) ? "done" : s.held && step !== "about" && step !== "team" ? "afterPlan" : "open";

/** The foot's asks wait for a team that can think: a team and an AI, never on a hold. */
export const firstRunAsks = (done: ReadonlySet<FirstRunStep>, held: boolean, team: boolean) =>
  !held && team && done.has("ai");

/** What the rows say, from what the app read: names already joined in the person's language. */
export interface FirstRunRowFacts {
  org: string;
  /** The agents besides the right hand, for a personal workspace's row of them. */
  agents?: number;
  /** What the right hand thinks with ("Claude"), once it does. */
  label: string | null;
  /** The apps connected ("o Gmail e o Drive"); null when none. */
  apps: string | null;
  members: number;
  /** Who was invited and hasn't answered yet ("João e Ana"); null when nobody. */
  invited: string | null;
  /** A personal workspace (ADR 0159): rows in its words (`PERSONAL_ROW_WORDS`). */
  personal?: boolean;
}

/**
 * What the card names as the right hand's AI ("Penso com …"): a plan's line ("Sonnet pelo plano do Claude"), else the
 * maker of the API it runs on ("Claude"), the workspace key's or its model's; null when unknown.
 */
export const firstRunAiLabel = (thinks: { text: string; kind: string }, maker: string | null | undefined) =>
  thinks.kind !== "agent" ? thinks.text : maker ? providerLabel(maker) : null;

/**
 * The words a personal workspace's rows say differently (ADR 0159), each a `<key>Personal` sibling of the row's key:
 * about the person instead of the company, their agents instead of a team, their apps instead of work apps.
 */
export const PERSONAL_ROW_WORDS: Partial<Record<FirstRunStep, readonly string[]>> = {
  about: ["todo", "todoDesc", "done"],
  team: ["todo", "todoDesc", "action", "done"],
  apps: ["todo", "todoDesc"],
};

/** One row's words: its title, a line under it while open, its button's word, and "Agora não" where a row skips. */
export function firstRunRow(
  tr: TFunction,
  step: FirstRunStep,
  state: FirstRunRowState,
  f: FirstRunRowFacts,
  skipped: boolean,
): SetupRow & { skip?: string } {
  // Keys built from the row's id, so read through an untyped `t`.
  const t = tr as unknown as (key: string, o?: Record<string, unknown>) => string;
  const k = (key: string) =>
    `agentSetup.firstRun.${step}.${key}${f.personal && PERSONAL_ROW_WORDS[step]?.includes(key) ? "Personal" : ""}`;
  if (state === "afterPlan")
    return { title: t(k("todo"), { org: f.org }), desc: t("agentSetup.firstRun.afterPlan"), action: "" };
  if (state === "done") {
    switch (step) {
      case "about":
        return { title: t(k("done"), { org: f.org }), action: t("agentSetup.change") };
      case "team":
        return { title: t(k("done"), { count: f.agents ?? 0 }), action: t("agentSetup.see") };
      case "ai":
        return { title: f.label ? t(k("done"), { label: f.label }) : t(k("doneAny")), action: t("agentSetup.switch") };
      case "apps":
        return { title: f.apps ? t(k("done"), { apps: f.apps }) : t(k("doneNone")), action: t("agentSetup.change") };
      case "people":
        return {
          title:
            f.members <= 1 && f.invited
              ? t(k("invited"), { names: f.invited })
              : skipped && f.members <= 1
                ? t(k("doneNone"))
                : t(k("done"), { count: f.members }),
          action: t(k("action")),
        };
    }
  }
  return {
    title: t(k("todo"), { org: f.org }),
    desc: t(k("todoDesc"), { org: f.org }),
    action: t(k("action")),
    ...(step === "apps" || step === "people" ? { skip: t("agentSetup.firstRun.notNow") } : {}),
  };
}

/**
 * The ready-made template agents' roles (mirror of `MEMBERS` in packages/engine/src/team-templates.ts), by handle,
 * for the apps a team just made would use (`firstRunApps`).
 */
const TEMPLATE_ROLES: Record<string, RoleId> = {
  iara: "support",
  caio: "finance",
  ada: "dev",
  lia: "content",
  theo: "sales",
  nina: "assistant",
  otto: "ops",
  bia: "support",
};

/**
 * The apps (catalog connector ids) a personal template's agents use (ADR 0159; mirror of the personal `MEMBERS` in
 * packages/engine/src/team-templates.ts), by handle: a person's calendar, files and lists rather than a team's tools.
 */
const PERSONAL_TEMPLATE_APPS: Record<string, readonly string[]> = {
  clara: ["google-calendar", "todoist"],
  duda: ["google-sheets", "drive"],
  leo: ["google-calendar"],
  mel: ["todoist", "google-docs"],
  gabi: ["notion", "google-docs"],
  lu: ["google-docs", "notion"],
  rosa: ["todoist", "google-calendar"],
  vic: ["google-calendar", "drive"],
  rui: ["google-calendar", "google-docs", "google-sheets"],
};

/** A template handle without its taken-name suffix (`iara-2` is Iara's). */
const templateHandle = (handle: string) => handle.replace(/-\d+$/, "");

/** A team agent's role, by its own role or its template handle (`iara-2` is Iara's). */
export const teamRole = (a: Pick<Agent, "handle" | "setup">): RoleId | null =>
  setupRole(a.setup) ?? TEMPLATE_ROLES[templateHandle(a.handle)] ?? null;

/** The apps (catalog connector ids) the team's roles suggest, the most suggested first. */
export function firstRunApps(team: readonly Pick<Agent, "handle" | "setup">[]): string[] {
  const count = new Map<string, number>();
  for (const a of team) {
    const role = teamRole(a);
    const apps = role
      ? Object.keys(ROLE_DEFAULTS[role].levels)
      : (PERSONAL_TEMPLATE_APPS[templateHandle(a.handle)] ?? []);
    for (const id of apps) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Row 4's list (web dialog, phone screen): the plug-and-play apps that connect here and aren't connected yet, the
 * team's suggestions first, at most six.
 */
export function firstRunAppList<D extends Pick<ConnectorDef, "id" | "auth" | "oauthConfigured" | "available" | "soon">>(
  defs: readonly D[],
  connected: ReadonlySet<string>,
  team: readonly Pick<Agent, "handle" | "setup">[],
): { def: D; suggested: boolean }[] {
  const order = firstRunApps(team);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return (
    defs
      // "Em breve" and an app the vendor hasn't approved yet open nothing: left out.
      .filter((d) => d.available && !d.soon && d.auth.includes("oauth") && d.oauthConfigured && !connected.has(d.id))
      .sort((a, b) => rank(a.id) - rank(b.id))
      .slice(0, 6)
      .map((def) => ({ def, suggested: order.includes(def.id) }))
  );
}
