import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInput } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.removeItem("agentes.team.view");
});

const go = async (path: string, state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(4);
  return state;
};
const click = async (el: Element, times = 3) => {
  await act(async () => fireEvent.click(el));
  await settle(times);
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("who can talk to agents: many at once, and the workspace's default for new ones", () => {
  test("Equipe › Lista: pick agents, then one Quem pode falar for all of them, saved as each one's own", async () => {
    const state = await go("team");
    const table = screen().getByRole("table");
    await click(within(table).getByRole("checkbox", { name: "Selecionar Ada" }));
    const bar = () => screen().getByRole("toolbar", { name: "Agentes selecionados" });
    expect(bar().textContent).toContain("1 selecionado");
    // The head's box picks every agent shown.
    await click(within(table).getByRole("checkbox", { name: "Selecionar todos" }));
    expect(bar().textContent).toContain("2 selecionados");
    await click(within(bar()).getByRole("button", { name: "Quem pode falar" }));
    const dialog = screen().getByRole("dialog", { name: "Quem pode falar com 2 agentes" });
    // Open by default, as every default: the whole workspace is picked first.
    expect(
      within(dialog)
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(dialog).getByRole("radio", { name: /^Só o responsável/ }));
    expect(dialog.textContent).toContain("Cada agente fala só com o responsável por ele.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 6);
    const saved = calls(state, "agents.update").map(([, id, input]) => [id, (input as AgentInput).audience?.mode]);
    expect(saved).toEqual([
      [ADA_ID, "owner"],
      [ATLAS_ID, "owner"],
    ]);
    expect(document.body.textContent).toContain("Quem pode falar mudou para 2 agentes.");
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(screen().queryByRole("toolbar", { name: "Agentes selecionados" })).toBeNull();
  });

  test("an agent with nobody responsible can't be left to its owner alone: that choice waits", async () => {
    const state = seedState();
    for (const a of state.agents) if (a.id === ATLAS_ID) a.ownerUserId = null;
    await go("team", state);
    const table = screen().getByRole("table");
    await click(within(table).getByRole("checkbox", { name: "Selecionar todos" }));
    await click(
      within(screen().getByRole("toolbar", { name: "Agentes selecionados" })).getByRole("button", {
        name: "Quem pode falar",
      }),
    );
    const dialog = screen().getByRole("dialog", { name: "Quem pode falar com 2 agentes" });
    const owner = within(dialog).getByRole("radio", { name: /^Só o responsável/ });
    expect(owner.getAttribute("data-disabled") ?? owner.getAttribute("aria-disabled")).not.toBeNull();
    expect(dialog.textContent).toContain("Defina um responsável para usar esta opção.");
  });

  test("Configurações › Agentes e acesso: new agents answer everyone until an admin narrows it", async () => {
    const state = await go("settings/access");
    const card = screen().getByRole("region", { name: "Novos agentes" });
    const select = within(card).getByRole("combobox", { name: "Quem pode falar" });
    expect(select.textContent).toContain("Todos do workspace");
    const AGENTS = "Vale só para pessoas. Outros agentes ainda podem consultá-los por quem não está na lista.";
    expect(card.textContent).not.toContain(AGENTS);
    select.focus();
    await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Só o responsável" }), 4);
    expect(calls(state, "orgs.updateSettings").map(([, input]) => input)).toEqual([{ newAgentAudience: "owner" }]);
    expect(state.newAgentAudience).toBe("owner");
    // Narrowed, it says whether it holds for other agents too.
    expect(card.textContent).toContain(AGENTS);
  });

  test("everyone for several agents keeps each one's own consultations switch, which shows only where it applies", async () => {
    const state = await go("team");
    const table = screen().getByRole("table");
    await click(within(table).getByRole("checkbox", { name: "Selecionar todos" }));
    await click(
      within(screen().getByRole("toolbar", { name: "Agentes selecionados" })).getByRole("button", {
        name: "Quem pode falar",
      }),
    );
    const dialog = screen().getByRole("dialog", { name: "Quem pode falar com 2 agentes" });
    expect(within(dialog).queryByRole("switch", { name: "Outros agentes podem consultá-los" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 6);
    const sent = calls(state, "agents.update").map(([, , input]) => (input as AgentInput).audience);
    expect(sent.map((a) => [a?.mode, a?.consultable])).toEqual([
      ["everyone", undefined],
      ["everyone", undefined],
    ]);
  });
});
