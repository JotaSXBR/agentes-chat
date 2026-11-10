import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { EndedTask, Message } from "../src/index";
import { applyChannelEvent, emptyStreams } from "../src/index";
import { runErrorText } from "../src/lib/errors";
import { isQuietRestart, stoppedNoticeOf, stopperOf } from "../src/lib/notices";
import { endedText } from "../src/lib/task-manager";
import { buildTimeline } from "../src/lib/timeline";
import { splitCanceled } from "../src/lib/work";

const pt = i18next.createInstance();
void pt.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });
const t: TFunction = pt.t.bind(pt);

const reply = (
  id: string,
  canceled: Record<string, unknown>,
  author: Message["author"] = { type: "agent", id: "ada" },
) =>
  ({
    id,
    channelId: "c",
    threadId: null,
    author,
    body: "_Stopped._",
    mentionedAgentIds: [],
    agentRunId: `run-${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 9, 10, 30, Number(id.replace(/\D/g, "") || 0))).toISOString(),
    meta: { canceled },
  }) as Message;

describe("whom a stop's line names", () => {
  test("'Você' only for who stopped it; the right hand by name even at my word; nobody when no person did", () => {
    expect(stopperOf({ byUserId: "me" }, "me")).toEqual({ kind: "you" });
    expect(stopperOf({ byUserId: "ana" }, "me")).toEqual({ kind: "person", userId: "ana" });
    expect(stopperOf({ byUserId: "me", byAgentId: "lodi" }, "me")).toEqual({ kind: "agent", agentId: "lodi" });
    expect(stopperOf({ byUserId: null }, "me")).toBeNull();
    // Nobody signed in reads no stop as theirs.
    expect(stopperOf({ byUserId: "me" }, null)).toEqual({ kind: "person", userId: "me" });
  });

  test("the notice says the agent that stopped it; an older one reads as the person's", () => {
    const notice = (refs: Record<string, string>) => ({
      notice: { kind: "run_stopped", text: "x", refs: { runId: "r1", was: "working", label: "", ...refs } },
    });
    expect(stoppedNoticeOf(notice({ byUserId: "me", byName: "Ana", byAgentId: "lodi", byAgentName: "Lodi" }))).toEqual({
      runId: "r1",
      byUserId: "me",
      byName: "Ana",
      byAgentId: "lodi",
      byAgentName: "Lodi",
      label: "",
      was: "working",
      reason: null,
    });
    expect(stoppedNoticeOf(notice({ byUserId: "me", byName: "Ana" }))).toMatchObject({
      byAgentId: null,
      byAgentName: "",
    });
  });
});

describe("a stopped reply's record", () => {
  test("who, the agent at their word, a restart, or the system's cause in the person's words", () => {
    expect(
      splitCanceled("Lendo.\n\n_Stopped by Lodi for Ana._", {
        canceled: { byUserId: "me", byAgentId: "lodi", text: "Lendo." },
      }),
    ).toEqual({
      body: "Lendo.",
      canceled: true,
      byUserId: "me",
      byAgentId: "lodi",
      restarted: false,
      code: null,
      note: "Stopped by Lodi for Ana",
    });
    expect(
      splitCanceled("_Stopped by Ana._", { canceled: { byUserId: "me", restarted: true, text: "" } }),
    ).toMatchObject({
      byUserId: "me",
      restarted: true,
    });
    const system = splitCanceled("Lendo.\n\n_Stopped._", {
      canceled: { byUserId: null, code: "run.org_paused", text: "Lendo." },
    });
    expect(system).toMatchObject({ byUserId: null, code: "run.org_paused" });
    expect(runErrorText(t, system.code)).toBe("Os agentes do workspace estão pausados.");
    expect(runErrorText(t, "run.agent_archived")).toBe("O agente foi arquivado.");
    // A cause with no words of its own leaves the plain line to the app.
    expect(runErrorText(t, "run.failed")).toBeNull();
    // Older replies: `canceled: true`, nobody named.
    expect(splitCanceled("Oi\n\n_Interrompido._", { canceled: true })).toMatchObject({ byUserId: null, code: null });
  });

  test("a restart with nothing in it draws no row; one with words, steps or a card keeps it, any other stop too", () => {
    const quiet = reply("m1", { byUserId: "me", restarted: true, text: "" });
    const said = reply("m2", { byUserId: "me", restarted: true, text: "Comecei." });
    const plain = reply("m3", { byUserId: "me", text: "" });
    const person = reply("m4", { byUserId: "me", restarted: true, text: "" }, { type: "person", id: "me" });
    const worked = { ...quiet, id: "m5", meta: { ...quiet.meta, work: { steps: 2, durationMs: 9000, calls: [] } } };
    const card = { ...quiet, id: "m6", meta: { ...quiet.meta, artifacts: [{ id: "a1" }] } };
    expect([quiet, said, plain, person, worked, card].map(isQuietRestart)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    const shown = buildTimeline([quiet, said, plain], [], []).flatMap((i) =>
      i.kind === "message" ? [i.message.id] : [],
    );
    expect(shown).toEqual(["m2", "m3"]);
  });
});

describe("the live row of a stopped run", () => {
  test("keeps the agent that stopped it and a restart, as the saved reply will", () => {
    const base = { channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
    type Ev = Parameters<typeof applyChannelEvent>[1];
    const writing = applyChannelEvent(emptyStreams, {
      type: "agent.delta",
      ...base,
      seq: 0,
      turn: 0,
      text: "Lendo",
    } as Ev);
    const byLodi = applyChannelEvent(writing, {
      type: "run.canceled",
      ...base,
      byUserId: "me",
      byAgentId: "lodi",
    } as Ev);
    expect(byLodi.runs.r).toMatchObject({ status: "canceled", canceledBy: "me", canceledByAgent: "lodi" });
    expect(byLodi.runs.r?.restarted).toBeUndefined();
    const again = applyChannelEvent(writing, { type: "run.canceled", ...base, byUserId: "me", restarted: true } as Ev);
    expect(again.runs.r).toMatchObject({ status: "canceled", canceledBy: "me", restarted: true });
  });
});

describe("how a task ended", () => {
  const ended = (stoppedBy: EndedTask["stoppedBy"], status: EndedTask["status"] = "canceled"): EndedTask => ({
    runId: "r",
    agentId: "ada",
    channelId: "c",
    channelKind: "channel",
    channelName: "eng",
    threadId: null,
    status,
    label: null,
    background: false,
    routine: null,
    startedAt: null,
    finishedAt: "2026-11-09T10:30:00.000Z",
    stoppedBy,
  });
  const names = (id: string) => (id === "lodi" ? "Lodi" : undefined);

  test("'Você parou' only for who stopped it: anyone else by name, the right hand by its name, nobody plainly", () => {
    expect(endedText(t, ended(null, "done"), "me")).toBe("Terminou");
    expect(endedText(t, ended(null, "failed"), "me")).toBe("Não conseguiu");
    expect(endedText(t, ended({ userId: "me", name: "Bia" }), "me")).toBe("Você parou");
    expect(endedText(t, ended({ userId: "ana", name: "Ana" }), "me")).toBe("Ana parou");
    expect(endedText(t, ended({ userId: "me", name: "Bia", agentId: "lodi" }), "me", names)).toBe("Lodi parou");
    // The system stopped it: never "Você parou".
    expect(endedText(t, ended(null), "me")).toBe("Parada");
    expect(endedText(t, ended({ userId: "ana", name: "" }), "me")).toBe("Parada");
  });
});
