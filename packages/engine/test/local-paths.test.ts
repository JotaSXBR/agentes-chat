import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage, type ToolSource } from "../src";
import { describeCapabilities, LOCAL_FILES_LINE } from "../src/capabilities";
import { advance, decideTurnEnd, localPathsCited, type TurnEnd } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * Nobody can open the agent's computer: a reply that cites a file there as if people could ("Salvei em
 * `notas/precos.md`") is written again once, unposted, with the file shared or what it holds, unless the person
 * writes paths or code themselves, or the run works in a repository or a mission.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("a path on the agent's computer", () => {
  test("an agent with a computer reads that nobody else can open its files, and how to share one", () => {
    const tool = (name: string) => ({ name, description: name, scope: "" });
    expect(LOCAL_FILES_LINE).toContain("share one with `upload_file`");
    expect(describeCapabilities([tool("upload_file")])).toContain(LOCAL_FILES_LINE);
    expect(describeCapabilities([tool("react")])).not.toContain(LOCAL_FILES_LINE);
  });

  test("found in backticks or bare, folders too; never an address, a wiki link, a code block, a ratio or a date", () => {
    expect(localPathsCited("Salvei o saldo em `notas/tabela-precos.md` e o resto em notas/.", "")).toEqual([
      "notas/tabela-precos.md",
      "notas/",
    ]);
    expect(localPathsCited("Está em ~/relatorios/ e em /home/agente/out.csv.", "")).toEqual([
      "~/relatorios/",
      "/home/agente/out.csv",
    ]);
    const words = [
      "Veja https://example.com/docs/guia.md, www.example.com/precos e example.com/planos.",
      "Está na página [[Processos/Deploy]] da wiki, escreva para ana@example.com.",
      "Rode:\n```\ncat notas/precos.md\n```",
      "Use e/ou, 24/7, 80 km/h, R$ 49/mês, 09/11/2026, c/ desconto, A/B e Pessoal/Equipe/Empresa.",
    ];
    for (const reply of words) expect(localPathsCited(reply, "")).toEqual([]);
  });

  test("a person who writes paths or code reads them: their chat is about code", () => {
    const reply = "Corrigi em `src/login.ts` e os testes em test/login.test.ts passam.";
    expect(localPathsCited(reply, "o teste em test/login.test.ts quebrou")).toEqual([]);
    expect(localPathsCited(reply, "olha esse erro:\n```\nTypeError\n```")).toEqual([]);
    expect(localPathsCited(reply, "corrige o login")).toEqual(["src/login.ts", "test/login.test.ts"]);
  });

  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Salvei em `notas/precos.md`.",
    mission: false,
    localPaths: ["notas/precos.md"],
    wakesLater: async () => false,
    verdict: async () => "done",
    ...over,
  });

  test("written again once, judge or not; never between agents nor past a bound", async () => {
    const d = await decideTurnEnd(turn());
    expect(d).toMatchObject({ outcome: "continue", rule: "local_paths" });
    expect(d.nudge).toContain("your reply cites files on your computer (`notas/precos.md`)");
    expect(d.nudge).toContain("upload_file");
    const next = advance({ count: 0 }, d, 0);
    expect(next).toEqual({ count: 0, pathsNudged: true });
    expect(await decideTurnEnd(turn({ state: next }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ verdict: null }))).toMatchObject({ rule: "local_paths" });
    expect(await decideTurnEnd(turn({ kind: "agents_dm" }))).toMatchObject({ outcome: "done", rule: "judged" });
    expect(await decideTurnEnd(turn({ bound: "stuck" }))).toMatchObject({ outcome: "done", rule: "stuck" });
  });
});

/** Only its name matters here: a computer's way to share a file in the conversation. */
const computer: ToolSource = {
  name: "computer",
  tools: async () => [
    {
      name: "upload_file",
      description: "Share a file from your computer in this conversation.",
      scope: "",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "shared" }),
    },
  ],
};

const lastUserText = (request: ModelRequest | undefined) => {
  const last = request?.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const agentBodies = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice)
    .map((m) => m.body);

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

describe("a run that cites one to people", () => {
  test("its reply is written again, and only that one is posted", async () => {
    f = await setup({
      toolSources: [computer],
      reply: (_request, call) => ({
        chunks: [
          call === 1
            ? "Pesquisei os planos e salvei o resumo em `notas/planos.md`."
            : "Pesquisei os planos: o Básico custa US$ 9 por mês e o Pro US$ 29.",
        ],
      }),
    });
    await ask(f, "@dev pesquisa os planos da Northwind");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(2);
    expect(lastUserText(f.provider.calls[1]?.request)).toContain(
      "Not posted: your reply cites files on your computer (`notas/planos.md`)",
    );
    expect(await agentBodies(f)).toEqual(["Pesquisei os planos: o Básico custa US$ 9 por mês e o Pro US$ 29."]);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.filter((s) => s.data.nudged === "local_paths").length).toBe(1);
  });

  test("a person who wrote the path, or an agent with no computer, gets the reply as it is", async () => {
    const answer = "Atualizei `notas/planos.md` com os preços de hoje.";
    f = await setup({ toolSources: [computer], reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev atualiza o notas/planos.md");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    await f.close();

    f = await setup({ reply: () => ({ chunks: [answer] }) });
    await ask(f, "@dev atualiza as notas dos planos");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(await agentBodies(f)).toEqual([answer]);
  });
});
