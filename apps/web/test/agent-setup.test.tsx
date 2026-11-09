import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

/*
 * One setup place: the right hand's first run in its own DM (ADR 0155 §6). Any other agent, however new, shows no
 * checklist in its DM nor on its page: when it needs an AI, an app, a person or a secret, it asks in the conversation.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Ada just made from a ready-made role, with nothing confirmed: everything a checklist would have listed. */
const fresh = (state = seedState()): FakeState => {
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.setup = { role: "dev", done: [] };
  return state;
};
const open = async (path: string, state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
};
/** A checklist card or row, by its class (a short line when a test fails, not the whole element). */
const checklist = () => document.querySelector(".setup-cl, .setup-row")?.className ?? null;

describe("a new agent has no setup checklist", () => {
  test("its DM opens on its first-use state, the agent waving over what to say first", async () => {
    await open(`dm/agent/${ADA_ID}`, fresh());
    expect(checklist()).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Pra eu começar");
    expect(text).toContain("Diga oi para a Ada");
  });

  test("the worst case: a long name, or one unbroken word, stays whole in the first-use title", async () => {
    for (const name of [
      "Maximiliana Albuquerque Montenegro Vasconcelos Ferraz Quintanilha Barbosa",
      "Assistentedeatendimentoaoclienteinternacionalpósvenda",
    ]) {
      const state = fresh();
      const ada = state.agents.find((a) => a.id === ADA_ID);
      if (ada) {
        ada.name = name;
        ada.role = "Atendimento ao cliente, pós-venda e devoluções internacionais";
      }
      await open(`dm/agent/${ADA_ID}`, state);
      expect(checklist()).toBeNull();
      expect(document.querySelector(".ac-empty__title")?.textContent).toContain(name);
      cleanup();
    }
  });

  test("with no AI, its DM says so above the composer, as every DM does", async () => {
    await open(
      `dm/agent/${ADA_ID}`,
      fresh(seedState({ aiStatus: { any: true, agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }] } })),
    );
    expect(checklist()).toBeNull();
    expect(document.querySelector(".noai-banner")?.textContent).toContain(
      "Ada não vai responder porque não tem uma IA",
    );
  });

  test("its page shows none either", async () => {
    await open(`agents/${ADA_ID}`, fresh());
    expect(document.querySelector(".agp-overview")).toBeTruthy();
    expect(checklist()).toBeNull();
    expect(document.body.textContent).not.toContain("Para a Ada começar");
  });
});
