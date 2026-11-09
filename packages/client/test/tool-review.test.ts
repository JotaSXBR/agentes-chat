import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { partsOf, subjectLabel, toolName } from "../src/lib/tool-review";

const tFor = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as TFunction;
};

test("a tool's name in the language's word order: the verb last in ja and ko", () => {
  const parts = { verb: "get", words: ["campaign", "budget"] };
  expect(toolName(tFor("en"), parts, "campaign_budget_get")).toBe("Get campaign budget");
  expect(toolName(tFor("pt-BR"), parts, "campaign_budget_get")).toBe("Ver orçamento da campanha");
  expect(toolName(tFor("ja"), parts, "campaign_budget_get")).toBe("キャンペーンの 予算 取得");
  expect(toolName(tFor("ko"), parts, "campaign_budget_get")).toBe("캠페인 예산 조회");
});

test("a server's tools grouped by what they're about, the group in the person's language (mirrors the backend)", () => {
  const names = ["list_branches", "get_branch", "list_caches", "get_postgres_logs", "execute_write_query"];
  expect(names.map((n) => partsOf(n).subject)).toEqual(["branch", "branch", "cache", "postgres", "query"]);
  const pt = tFor("pt-BR");
  expect(["branch", "query", "organization", "documentation"].map((s) => subjectLabel(pt, s))).toEqual([
    "Branches",
    "Consultas",
    "Organizações",
    "Documentação",
  ]);
  expect(toolName(pt, partsOf("list_organizations"), "list_organizations")).toBe("Listar organizações");
  // A language without the catalog's column builds it from the nouns too.
  expect(toolName(tFor("es"), partsOf("search_documentation"), "search_documentation")).toBe("Buscar documentación");
});
