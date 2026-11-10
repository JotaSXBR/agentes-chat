import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { questionDefaultLine } from "../src/lib/agent-questions";

const t = ((key: string, o?: Record<string, unknown>) => `${key} ${JSON.stringify(o ?? {})}`) as unknown as TFunction;
const now = new Date(2026, 10, 9, 22, 0);
const decideAt = new Date(2026, 10, 9, 22, 40).toISOString();

test("a question's default: when it goes on while it waits, what it went on with once nobody answered", () => {
  const open = { status: "open" as const, defaultAnswer: "staging", decideAt };
  expect(questionDefaultLine(t, "pt-BR", open, now)).toBe('question.defaultNote {"time":"22:40","answer":"staging"}');
  expect(questionDefaultLine(t, "pt-BR", { ...open, status: "answered", defaulted: true }, now)).toBe(
    'question.defaulted {"answer":"staging"}',
  );
  // Answered by a person, or no default at all: nothing to say.
  expect(questionDefaultLine(t, "pt-BR", { ...open, status: "answered" }, now)).toBeNull();
  expect(questionDefaultLine(t, "pt-BR", { status: "open" }, now)).toBeNull();
});
