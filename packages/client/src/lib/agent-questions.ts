import type { TFunction } from "i18next";
import type { AgentQuestion } from "../api/types";
import { clockAt } from "./format";

/** Whether an agent's question waits on this person: it is for them, or for anyone in the conversation. */
export const questionWaitsOn = (q: Pick<AgentQuestion, "requestedForUserId">, meId: string | null | undefined) =>
  !q.requestedForUserId || q.requestedForUserId === meId;

/**
 * A question's default on its card, the same on the web and the phone: "Se ninguém responder até 22:40, sigo com: X"
 * while it waits, "Ninguém respondeu a tempo. Segui com: X" once it went on. Null without a default, or once answered.
 */
export function questionDefaultLine(
  t: TFunction,
  locale: string,
  q: Pick<AgentQuestion, "status" | "defaultAnswer" | "decideAt" | "defaulted">,
  now = new Date(),
): string | null {
  if (!q.defaultAnswer) return null;
  if (q.defaulted) return t("question.defaulted", { answer: q.defaultAnswer });
  if (q.status !== "open" || !q.decideAt) return null;
  return t("question.defaultNote", { time: clockAt(locale, q.decideAt, now), answer: q.defaultAnswer });
}

/** "Quanto esperar por uma resposta", in minutes; mirrors engine `questions.ts` `QUESTION_WAIT_MINUTES`. */
export const QUESTION_WAITS = [10, 30, 60, 240] as const;
export const DEFAULT_QUESTION_WAIT = 30;
