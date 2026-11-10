import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import { type Agent, getAgentCached } from "./agents";
import { answersOthers, audienceOf } from "./audience";
import { accountablePerson, runAuthority } from "./authority";
import { isComputerBrain } from "./brains/types";
import { endsAsking } from "./brakes";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { isAgentOnlyDm } from "./dms";
import { decisionNudge, FOLLOW_THROUGH_NUDGE, FOLLOW_THROUGH_NUDGE_DM, MISSION_ASK_NUDGE } from "./follow-through";
import { cutText, cutTextEnd } from "./format";
import { choiceP, type Judge, stanceQuestion } from "./judge";
import { getMessage } from "./messages";
import type { NoticeKind } from "./notices";
import { notifyRunFailed } from "./notification-producers";
import { ANSWER_NUDGE } from "./reply-policy";
import { routineBriefOf } from "./routine-brief";
import { deliverNoticeToRun } from "./run-resume";
import type { AgentRun } from "./runs";
import { runStretchOf } from "./stretch";
import { HAND_OVER_STEP } from "./tools/directory";
import { neutralizeUntrusted, untrustedBlock } from "./untrusted";

/**
 * The continuation controller (ADR 0097): every turn of every run kind that reaches its final answer ends in exactly
 * one of continue (the same run keeps working), waiting (something durable brings it back) or done. Cheap rules
 * first, then at most one judgment (`continuationVerdict`). A failed run goes to `reportRunFailure` instead.
 */

/**
 * Extra turns one run may be given, every kind counted together (the decision nudge, the answer nudge and the
 * continue nudges), plus one ask nudge. Worst case: 3 extra turns and 4 judgments, then a question card or done.
 * `maxPerStretch`: the judged pushes (go on, try again, ask) one agent gets in a stretch (ADR 0089), its runs together,
 * so copies of it running at once don't each get their own.
 */
export const CONTINUE = { maxPerRun: 2, routineMaxPerRun: 1, maxPerStretch: 3 } as const;

/** Where the controller stands in a run (`transcript.continuation`). */
export interface ContinuationState {
  count: number;
  /** The run's executed tool calls when it was last told to continue: the next continue needs more. */
  executedAtNudge?: number;
  askNudged?: boolean;
  /** The last turn was told to ask: this one is judged past the cap, and turns into the question if it didn't. */
  askPending?: boolean;
  /** It was told once that nobody can open files on its computer (`localPathsNudge`): the next reply is posted. */
  pathsNudged?: boolean;
  /** It was told once to say whether it still needs its open requests (`openRequestNudge`). */
  requestNudged?: boolean;
  /** It was told once to ask for a secret securely: the next secret verdict ends the run as it is. */
  secretNudged?: boolean;
  /** It was told once to write a reply that named its tools again (`toolNamesNudge`): the next one is posted. */
  toolsNudged?: boolean;
}

export type ContinuationVerdict = "done" | "continue" | "ask" | "untried" | "secret";

/**
 * What a run reads when it ended saying it couldn't while it still had ways to try (ADR 0109): what the person asked
 * (`ask`, "" for nobody), its means and what it already tried, so it varies the attempt at that ask instead of handing
 * the problem to a person or reaching for an access the ask doesn't need. Its reply was held, and it is told so.
 */
export function untriedNudge(means: string[], tried: string[], ask = "") {
  const have = means.length > 0 ? means.join("; ") : "your tools and find_tools";
  const asked = ask ? ` Asked: "${oneLineCut(ask, 300)}".` : "";
  return `You ended saying you couldn't, but you still have ways to try.${asked} Your means: ${have}. Already tried:\n${triedBlock(tried)}\nUse the ones that fit the request; when a search or a page gives nothing or is blocked, change the words, the source or the tool. Missing an access or a login the request needs? Look in the workspace first (your memory, search_context for who signed in or holds it) and ask the teammate who has it, but never ask anyone for a sign-in or an access the request doesn't need. ${SAFETY_FINAL} ${HAND_OVER_STEP} If no way is left at all, say what you tried and the one step a person must do. Your last message wasn't posted and nobody sees this note: if your answer stands, write it again as it is.`;
}

/**
 * A refusal for safety ends that path for that data (ADR 0117): the nudges and HOW_YOU_WORK say so, so "take another
 * way" never reads as "send it some other way".
 */
export const SAFETY_FINAL =
  "A refusal for safety (a credential, private data in an address, secrets, sending data out) is final: never send that data another way. Say what was refused.";

/** What a tried line starts with when its call was refused for safety (`triedCalls`). */
export const SAFETY_TAG = "[refused for safety]";

/**
 * Refusal codes (a tool result's `data.code`) that stop data from going out: the gateway's credential check,
 * `remember`'s unasked destination and the outbound checks on web addresses. A command held for a person's approval
 * (`command.approval_needed`) is not one: the person may let it run.
 */
const SAFETY_CODES = new Set([
  "tool.credential",
  "memory.unasked_destination",
  "outbound.private_text",
  "outbound.credential",
  "outbound.long",
]);

const isSafetyCode = (code: unknown) => typeof code === "string" && SAFETY_CODES.has(code);

/**
 * A computer brain's own call the command policy refused because it reads secrets or sends data out
 * (`mission-commands.ts`). Inline code, a remote host or a shell are refused with another way to do it, so they
 * aren't final.
 */
const HARNESS_SAFETY =
  /→ failed: (?:This command was refused because (?:it touches secrets|it sends data)|Agents never read secrets)/;

/** The tried lines as a run reads them: inside the envelope, since their outcomes quote tool results. */
const triedBlock = (tried: string[]) =>
  tried.length > 0 ? untrustedBlock("what you tried", tried.slice(-8).join("\n")) : "nothing yet";

/** Every failed tried line was refused for safety (and at least one failed). */
export function onlySafetyRefusals(tried: string[]): boolean {
  const failed = tried.filter((l) => l.includes("→ failed: "));
  return failed.length > 0 && failed.every((l) => l.startsWith(SAFETY_TAG));
}

/**
 * What an `ask_user` call reads when its question asks for something the run could find itself (ADR 0109
 * addendum): held once, its means and what it already tried, and the next ask goes through.
 */
export function findableNudge(means: string[], tried: string[]) {
  const have = means.length > 0 ? means.join("; ") : "your tools and find_tools";
  return `Not asked yet: ask a person only for what only they can give, and this you can find. Your means: ${have}. Already tried:\n${triedBlock(tried)}\n${SAFETY_FINAL} Find it first: search the web for the docs and read them, try it (on your computer, or with web_fetch), search the workspace for a name the person uses. When something stays unclear, state your assumption and go on with work you can undo; a message to someone else can't be undone, so settle what and to whom from the conversation first. Ask only for what only a person can give (a key through request_secret, a decision, an approval). If you still need to ask, call ask_user again: that one is asked.`;
}

/** What a run reads, once, when it described what only a person can give instead of asking for it. */
export const ASK_NUDGE =
  "You need something only a person can give (a credential, a decision, a test, access). Ask them now with ask_user: one direct question, with choices if it is one of a few; but a sign-in, a QR code, a code or a captcha with browser_ask_person or desktop_ask_person once the page or app is at that step, a key or a password through request_secret, an approval only someone else can give through request_approval, a permission through request_permission. Do not end with a list of what's missing. If you need nothing from them to finish, just give your answer, with no question.";

/** Never a path on the agent's computer: a web or mail address, a wiki link (`[[Folder/Page]]`), a code block. */
const NOT_PATHS = /```[\s\S]*?```|\[\[[^\]]*\]\]|[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*|\S+@\S+/gi;
/** A word with a slash in it: `notas/`, `~/out/x.csv`, `/home/agent/a.md`, `scripts/run.sh`. */
const SLASHED = /(?<![\p{L}\p{N}_.~/-])(?:~|\.{1,2})?\/?(?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]*/gu;
const UNDER_HOME = /^(?:~|\.{1,2})\/|^\/(?:home|root|tmp|Users|workspace|mnt|srv)\//;

/**
 * A word with a slash that names a file or a folder: under a home or the current folder (`~/`, `./`, `/home/`), a
 * name with an extension (`notas/pricing.md`) or a folder (`notas/`). A pair or a ratio (`e/ou`, `24/7`, `km/h`), a
 * date and an address without its scheme (`example.com/precos`) aren't.
 */
function namesFile(word: string) {
  if (UNDER_HOME.test(word)) return true;
  const parts = word.split("/").filter(Boolean);
  if (!parts.some((p) => /\p{L}/u.test(p)) || /\.[a-z]{2,}$/i.test(parts[0] ?? "")) return false;
  // A folder's name is two characters at least: "c/ desconto" and "w/ the team" are words.
  const last = parts.at(-1) ?? "";
  if (word.endsWith("/")) return last.length >= 2;
  return /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.[A-Za-z0-9]{1,5}$/u.test(last);
}

const pathsIn = (text: string) =>
  [...text.replace(NOT_PATHS, " ").matchAll(SLASHED)].map((m) => m[0].replace(/[.,:;!?]+$/, "")).filter(namesFile);

/**
 * Files on the agent's computer its reply cites as if people could open them (`notas/pricing.md`, `~/out/`): nobody
 * else can. None when the person's message writes paths or code itself: then they talk code, and read paths.
 */
export function localPathsCited(reply: string, request: string): string[] {
  if (request.includes("```") || pathsIn(request).length > 0) return [];
  return [...new Set(pathsIn(reply))];
}

/** What a run reads, once, when its reply cites files on its computer to people (`localPathsCited`): not posted. */
export function localPathsNudge(paths: string[]) {
  const cited = paths
    .slice(0, 3)
    .map((p) => `\`${p}\``)
    .join(", ");
  return `Not posted: your reply cites files on your computer (${cited}), which nobody else can open. When people need one, share it with upload_file: they get its card. Otherwise write what matters from it in your message, or link a wiki page you wrote as [[Title]]. Then write your reply again without those paths. A path in code the person works on can stay.`;
}

/**
 * What a run reads, once, when its reply asks a person for a secret in the chat (ADR 0109 addendum): its reply is not
 * posted, and a question card is never made of it, since the answer would stay in the conversation in plain text.
 */
export const SECRET_NUDGE =
  "Not posted: never ask for a secret (a key, a token, a password) in the chat, where it stays in plain text. If you have request_secret, call it: the person types it into a secure card. Otherwise say which key is needed and where it is set up, without asking for it here.";

/**
 * The run's own tools its reply names (bare, in backticks, or behind a computer brain's `mcp__agentes__`) and the
 * person's message doesn't: people can't see or use them. Only names with an underscore, so a one-word tool
 * (`remember`, `react`) reads as the word it is. Tool names are `[A-Za-z0-9_-]`, nothing to escape.
 */
export function toolsNamed(reply: string, tools: Iterable<string>, request: string): string[] {
  const says = (text: string, name: string) =>
    text.includes(name) && new RegExp(`(?<![A-Za-z0-9-])${name}(?![A-Za-z0-9_-])`).test(text);
  return [...new Set(tools)].filter((n) => /^[\w-]*_[\w-]*$/.test(n) && says(reply, n) && !says(request, n));
}

/** What a run reads, once, when its reply named its own tools to a person (`toolsNamed`): the reply is not posted. */
export const toolNamesNudge = (names: string[]) =>
  `Not posted: your reply names your tools (${names.map((n) => `\`${n}\``).join(", ")}), and people can't see or use them. Write it again in plain words. When a tool is the next step, call it now instead of naming it: when it needs them, they get its card. Otherwise say in everyday words what you did or what will happen. Names from code the person works on can stay.`;

/** The run's last judged turn, kept for the mission's keep-going check (`keepGoingBlocker` reads `waiting`). */
export const verdictRecord = (v: ContinuationVerdict) =>
  v === "continue" || v === "untried" ? "unkept" : v === "ask" || v === "secret" ? "waiting" : v;

/**
 * One judge call on a turn's end (kind `follow_through`, recorded on the agent's and the workspace's usage like
 * every judgment, not billed to the agent's budget). `continue` at p ≥ 0.45 and at least p(ask); `untried` at
 * p ≥ 0.45 and at least p(continue) and p(ask); `ask` at p ≥ 0.45; otherwise done. A missed continuation is silent
 * lost work, a needless one is one turn. A person who questioned or objected to what the agent did gets its answer
 * and nothing more (`stanceQuestion`): then it is done, whatever the verdict says it could still do.
 */
export async function continuationVerdict(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    request: string;
    /**
     * What the person behind the work asked (`personAsk`): the trigger they wrote, or the message an agent relayed.
     * "" or none when nobody asked (a routine's run, an agent's own work).
     */
    ask?: string;
    reply: string;
    /** What the turn really has (`turnMeans`, its computer's own tools on a computer brain). */
    means: string[];
    /**
     * Each tool call of the run with its argument and outcome (`triedCalls`): the gateway's run steps (API brains,
     * and computer brains through the MCP bridge) plus a computer brain's own tools (`transcript.harnessTried`).
     */
    tried: string[];
    runKind: TurnKind;
    /** Agents and people its reply @named that aren't in the conversation (`unreachedNote`), "" none. */
    unreached?: string;
    /**
     * Asks the same call whether the turn taught something worth keeping (ADR 0120) and hands the answer here: no
     * extra model call on any turn.
     */
    onLearn?: (signal: LearnSignal) => void;
    /** The call with the `learn` question failed and the verdict was asked again without it (error reports). */
    onLearnFailed?: (error: unknown) => void;
  },
): Promise<ContinuationVerdict> {
  // A person's own message as the request is read there; one an agent relayed comes beside it.
  const relayed = Boolean(input.ask) && input.ask !== input.request;
  // Only where the person wrote to it: in an agents' DM it answers the agent that asked.
  const stance = Boolean(input.ask) && input.runKind === "conversation";
  const ask = (learn: boolean) =>
    judge.ask({
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: "follow_through",
      state: {
        request: cutText(input.request, 2000),
        ...(relayed ? { ask: cutText(input.ask ?? "", 2000) } : {}),
        reply: cutTextEnd(input.reply, 3000),
        means: input.means,
        tried: input.tried.slice(-20).map(neutralizeUntrusted),
        runKind: input.runKind,
        ...(input.unreached ? { unreached: input.unreached } : {}),
      },
      questions: {
        verdict: {
          type: "choice",
          instructions:
            "An AI agent in a team chat was asked `request` and ended its turn with `reply`, its last message. `ask`, when set, is what the person behind the work asked, in their own words (`request` came from an agent or the system). `tried`: each tool call it made in this run, with its argument and outcome. `means`: the general ways it has (web search, browser, terminal, tool directory, teammates). It won't act again until someone writes to it or something it set up wakes it. Is it done, should it go on by itself, does it still have untried ways, or does it need something only a person can give?",
          criteria: {
            done: "It gave the result or the answer. A plain answer to a question about itself (whether it has, uses or knows something, why it did something) is done, even when it is no or I don't know. Or it said what it couldn't do, and either `tried` shows several different attempts (another query, another source, another tool or the browser), or what blocks it is something only a person can give (a code, a sign-in, a payment, a permission, a decision) and it already asked them for it (with its request: `tried` shows browser_ask_person, desktop_ask_person, request_secret, request_approval, request_permission, ask_user or ask_choices; for a decision, one direct question) or `means` has no way to hand it to them. A reply that says it can't, stops, or only offers in passing, because a step needs the person (a sign-in, a QR code, a code, a captcha, an approval, a permission) is not done while `means` can hand that step to them: that is untried. When the request left open how to do it, one direct question offering to start a way it names, with the step the person will do ('I can do it in my browser: you'll scan a QR code. Shall I start?'), is done. A refusal because the account or the data is someone else's, not the asking person's own, is done. Saying it or the team has no access, or asking people for one, without having looked in the workspace (search_context, find_agent, ask_agent or tell_agent in `tried`) is not done: that is untried. An offer that needs someone else's decision (a sensitive or external action, a choice between their options) counts as done only when asked as one direct question.",
            untried:
              "It said it couldn't or that it lacks a tool, or asked a person to do or connect something, or asked a person for information its means could find (an address, docs, what a name refers to), while `means` has ways that fit the task it hasn't used in `tried`, or it gave up after one empty or failed attempt without varying it. Handing the work to a teammate counts as an attempt. Also when it said it or the team lacks an access, a login or an account the work needs (not when it was only asked whether it has one), or asked people for one or who has it, without first looking in the workspace (`tried` has no search_context, find_agent, ask_agent or tell_agent): a teammate or an earlier conversation may hold it. Also when it said it couldn't, stopped, or only offered in passing ('one option would be…', 'only if you want'), because a step needs the person (a sign-in, a QR code scanned with their phone, a code sent to them, a captcha, an approval, a permission, their consent to their own account) instead of doing everything up to it and handing that step over, while `means` can hand it over: a step that needs the person is never a blocker. A sign-in or an access the person's request (`ask`, else `request`) doesn't need is no way left to try. A call refused for safety ([refused for safety]) is final for that data: counting it as a way left to try is wrong.",
            continue:
              "It said it will do more itself (next, later, after a build), or stopped midway, and nothing it set up brings it back. A reply that asks the person whether to do something ('want me to…?', 'quer que eu faça?') is not this: it waits for their answer. Also when `unreached` is set and the reply hands work or a question to an agent it names, or says it told a person it names (that mention reached nobody); merely naming one is not that.",
            ask: "To go on it needs something only a person can give (a decision, a test, access) that its `means` can't find, but it described the need or listed what's missing instead of asking one direct question. Not when it says it needs nothing from them, or what's missing only blocks optional extra work the request doesn't need, or `request` asked what is missing or left to do and the list answers it: that is done. A way to do the request itself, even worded 'only if you want', is never optional extra work.",
            secret:
              "It asks a person to type or paste a secret into the chat (a password, an API key, a token, a private key), or it needs one from a person and hasn't asked for it through a secure request (`tried` has no request_secret call).",
          },
        },
        ...(learn ? { learn: LEARN_QUESTION } : {}),
        ...(stance ? { stance: stanceQuestion(relayed ? "ask" : "request") } : {}),
      },
    });
  let learned = input.onLearn !== undefined;
  let answers: Awaited<ReturnType<typeof ask>>;
  try {
    answers = await ask(learned);
  } catch (error) {
    // Some providers' filters refuse a wording (a Claude subscription sign-in's misleading 400): the follow-through
    // verdict must never fail because of the extra question, so it is asked again alone.
    if (!learned) throw error;
    learned = false;
    input.onLearnFailed?.(error);
    answers = await ask(false);
  }
  if (input.onLearn) {
    const choice = learned ? answers.learn?.choice : undefined;
    input.onLearn(LEARN_SIGNALS.includes(choice as LearnSignal) ? (choice as LearnSignal) : "none");
  }
  const p = (k: ContinuationVerdict) => choiceP(answers.verdict, k);
  const verdict: ContinuationVerdict =
    p("secret") >= 0.45 && (["untried", "continue", "ask"] as const).every((k) => p("secret") >= p(k))
      ? "secret"
      : p("untried") >= 0.45 && p("untried") >= p("continue") && p("untried") >= p("ask")
        ? "untried"
        : p("continue") >= 0.45 && p("continue") >= p("ask")
          ? "continue"
          : p("ask") >= 0.45
            ? "ask"
            : "done";
  // Asked why it did something, or told to stop: its answer is the whole job, even a plain no. Pushing it on would
  // carry on with what the person just questioned, or open something nobody asked for.
  const questioned = stance && choiceP(answers.stance, "questions") >= 0.5;
  if (questioned && (verdict === "untried" || verdict === "continue" || verdict === "ask")) return "done";
  // What failed was only refused for safety: no way is left to try for that data. Work it said it will still do
  // (`continue`) goes on.
  return verdict === "untried" && onlySafetyRefusals(input.tried) ? "done" : verdict;
}

/** What a finished turn taught, as the turn-end judgment reads it (ADR 0120): `none` starts no learning. */
export type LearnSignal = "none" | "method" | "correction" | "fact" | "access";
const LEARN_SIGNALS: readonly LearnSignal[] = ["none", "method", "correction", "fact", "access"];

const LEARN_QUESTION = {
  type: "choice" as const,
  instructions:
    "Did this turn show something durable the agent should keep for next time, as `request`, `reply` and `tried` show it?",
  criteria: {
    method:
      "It worked out a way it will reuse: several tries before one worked, a new API or address, a command or a script it wrote.",
    correction:
      "A person corrected it, questioned something it did ('did anyone ask you to…?'), or said how they want things done from now on ('always…', 'from now on…', 'don't… again').",
    fact: "A person's message or a tool result gave a lasting fact about the company, its people or its systems.",
    access:
      "Someone in the team got, lost or was named for an access: the agent or another signed in to a service, got a login, a key, a connector or a mailbox, or a person said who handles a service.",
    none: "Anything else: a one-off request, a passing error, a plain answer or a story.",
  },
};

/** One tool call as the judge reads it: `name(argument) → outcome`, short. */
export function callLine(name: string, input: unknown, result?: { content: string; isError?: boolean } | null) {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // `use_tool` runs another tool: the judge reads that one.
  if (typeof i.tool === "string" && i.arguments && typeof i.arguments === "object")
    return callLine(i.tool, i.arguments, result);
  const arg = ["query", "url", "command", "q", "prompt", "question", "message", "text", "path", "name"]
    .map((k) => i[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  const outcome = !result ? "" : ` → ${result.isError ? "failed: " : ""}${oneLineCut(result.content, 90) || "(empty)"}`;
  return `${name}${arg ? `(${oneLineCut(arg, 80)})` : ""}${outcome}`;
}

const oneLineCut = (text: string, max: number) => cutText(text.replace(/\s+/g, " ").trim(), max);

/**
 * Every tool call of a run, oldest first (the last 20), as the judge reads them (`tried`): the gateway's run steps
 * (every brain's calls to our tools, a computer brain's through the MCP bridge) and then `harness`, a computer
 * brain's own tools (Claude Code's Bash, WebSearch…, Codex's commands), which the runner forwards as `brain.event`
 * `tool_call` events with `executed` and the run keeps in `transcript.harnessTried`.
 */
export async function triedCalls(db: Database, run: { id: string; orgId: string }, harness: string[] = []) {
  const calls = await runCalls(db, run);
  const tag = (line: string, safety: boolean | undefined) => (safety ? `${SAFETY_TAG} ${line}` : line);
  return [
    ...calls.map((c) => tag(callLine(c.name, c.input, c.result), c.safety)),
    ...harness.map((l) => tag(l, !l.startsWith(SAFETY_TAG) && HARNESS_SAFETY.test(l))),
  ].slice(-20);
}

/** A run's tool calls through the gateway, oldest first, each with its result once it came. */
export async function runCalls(db: Database, run: { id: string; orgId: string }) {
  const steps = await db
    .select({ kind: schema.agentRunSteps.kind, data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.runId, run.id),
        inArray(schema.agentRunSteps.kind, ["tool_call", "tool_result"]),
      ),
    )
    .orderBy(schema.agentRunSteps.seq);
  const calls = new Map<string, RunCall>();
  for (const { kind, data } of steps) {
    const id = typeof data.toolUseId === "string" ? data.toolUseId : `step:${calls.size}`;
    const name = typeof data.name === "string" ? data.name : "";
    if (kind === "tool_call") calls.set(id, { name, input: data.input });
    else {
      const call = calls.get(id) ?? { name, input: undefined };
      call.result = {
        content: String(data.content ?? ""),
        isError: data.isError === true,
        // `data.data.outside`: the gateway's mark for any outside read, which survives `shown` dropping the envelope.
        external: data.external === true || (data.data as { outside?: unknown } | undefined)?.outside === true,
      };
      call.safety = data.isError === true && isSafetyCode((data.data as { code?: unknown } | undefined)?.code);
      calls.set(id, call);
    }
  }
  return [...calls.values()];
}

export interface RunCall {
  name: string;
  input: unknown;
  /** `external`: an answer read from outside (an MCP server, a screen), recorded without its envelope. */
  result?: { content: string; isError?: boolean; external?: boolean };
  /** Refused for safety (`SAFETY_CODES`): final for that data. */
  safety?: boolean;
}

export type TurnKind = "conversation" | "agents_dm" | "routine";

export interface TurnEnd {
  state: ContinuationState;
  kind: TurnKind;
  /** Tool calls executed so far in the run. */
  executed: number;
  /** A bound already ended it: stuck, the step backstop, the turn cap. */
  bound: string | null;
  /** It passed, used the silence word, or a reaction, a GIF or a report card is its answer. */
  quiet: boolean;
  /** A person decided what it waited on and it ended without a word: the decision and its result. */
  decided: string | null;
  /** Addressed directly, it wrote nothing (or only the silence word). */
  unanswered: boolean;
  /**
   * Its answer names agents or people outside the conversation (`unreachedNote`, "" none): the mention reached nobody.
   * Judged: a hand-off or a message by that mention goes on with this note, a mention that only names them ends as
   * judged.
   */
  unreached: string;
  /** Files on its computer its reply cites to people (`localPathsCited`): it writes the reply again once, unposted. */
  localPaths?: string[];
  /** What is judged ("" skips the judgment: nothing to read, or an agents' DM run that owes no answer). */
  judged: string;
  mission: boolean;
  /**
   * Requests for a person it made in this run and stopped waiting on, still open (`openRequestNudge`, "" none): it
   * says once whether it still needs them before ending.
   */
  openRequest?: string;
  /** The run's own tools its reply names to a person (`toolsNamed`): it writes it again in plain words, once. */
  namedTools?: string[];
  /** Its reply carries a question card (`ask_choices`): it asked, and waits for the pick like for any answer. */
  asks?: boolean;
  /** Something durable brings it back (`wakesLater`), read only when the judgment would run. */
  wakesLater(): Promise<boolean>;
  /** Whatever run set it, something brings it back to this conversation (`comesBackHere`), read on a repeated promise. */
  comesBack?(): Promise<boolean>;
  /** The agent's pushes in its other runs of the stretch (`stretchNudges`), read only before one more. */
  stretchNudged?(): Promise<number>;
  /** The judgment; null when the workspace has no judge. */
  verdict: (() => Promise<ContinuationVerdict>) | null;
  /**
   * What an `untried` turn is reminded of (`untriedNudge`), filled by `verdict`: its means, what it tried, and what
   * the person asked (`personAsk`).
   */
  evidence?: { means: string[]; tried: string[]; ask?: string };
}

export type TurnEndDecision = {
  outcome: "continue" | "waiting" | "done" | "ask_card";
  rule: string;
  /** What the run reads next (continue only). */
  nudge?: string;
  verdict?: ContinuationVerdict;
  judgeError?: boolean;
};

/**
 * Decides how a turn that reached its final answer ends (rules in order, the first that applies wins). The caller
 * applies it: posts and goes on with the nudge, turns the reply into a question card, or ends the run, and records
 * the decision as the run's `continuation` step.
 */
export async function decideTurnEnd(t: TurnEnd): Promise<TurnEndDecision> {
  const max = t.kind === "routine" ? CONTINUE.routineMaxPerRun : CONTINUE.maxPerRun;
  const canNudge = t.state.count < max;
  if (t.bound) return { outcome: "done", rule: t.bound };
  if (t.quiet) return { outcome: "done", rule: "quiet" };
  // Only a person's conversation: another agent may read its computer's shared folder.
  if (t.kind === "conversation" && t.localPaths?.length && !t.state.pathsNudged)
    return { outcome: "continue", rule: "local_paths", nudge: localPathsNudge(t.localPaths) };
  if (t.decided && canNudge) return { outcome: "continue", rule: "decision", nudge: decisionNudge(t.decided) };
  if (t.unanswered && canNudge) return { outcome: "continue", rule: "answer", nudge: ANSWER_NUDGE };
  // Only a person's conversation: another agent reading a tool's name can use it.
  if (t.kind === "conversation" && t.namedTools?.length && !t.state.toolsNudged)
    return { outcome: "continue", rule: "tool_names", nudge: toolNamesNudge(t.namedTools) };
  if (t.openRequest && !t.state.requestNudged)
    return { outcome: "continue", rule: "open_request", nudge: t.openRequest };
  if (!t.judged || !t.verdict) return { outcome: "done", rule: t.verdict ? "nothing_to_judge" : "no_judge" };
  if (!canNudge && !t.state.askPending && (t.state.askNudged || t.kind !== "conversation"))
    return { outcome: "done", rule: "cap" };
  if (await t.wakesLater().catch(() => false)) return { outcome: "waiting", rule: "wakes_later" };
  let verdict: ContinuationVerdict;
  try {
    verdict = await t.verdict();
  } catch {
    return { outcome: "done", rule: "judge_error", judgeError: true };
  }
  let pushes: Promise<number> | undefined;
  const stretchFull = async () => {
    pushes ??= t.stretchNudged?.().catch(() => 0) ?? Promise.resolve(0);
    return t.state.count + (await pushes) >= CONTINUE.maxPerStretch;
  };
  // No person reads a routine's run or an agents' DM: what it lacks goes out in its report or its answer, and
  // the controller of the run that reads it can ask.
  if ((verdict === "ask" || verdict === "secret") && t.kind !== "conversation")
    return { outcome: "done", rule: "ask_elsewhere", verdict };
  // A secret asked in the chat is never posted nor made a question card: once told the secure way, then as it is.
  if (verdict === "secret")
    return t.state.secretNudged
      ? { outcome: "done", rule: "secret_cap", verdict }
      : { outcome: "continue", rule: "secret", verdict, nudge: SECRET_NUDGE };
  if (t.asks && verdict !== "done") return { outcome: "done", rule: "asked", verdict };
  // A hand-off by mention to an agent that isn't here is an unkept hand-off: it goes on and hands it over.
  if (verdict === "continue" && t.unreached && canNudge && !(await stretchFull()))
    return { outcome: "continue", rule: "unreached", verdict, nudge: t.unreached };
  // Asking means waiting (ADR 0131 §1): a reply that ends asking the person whether to go on waits for their answer,
  // never pushed into going ahead. A secret asked in the chat and an unkept hand-off keep their rules above; one told
  // to ask (`askPending`) still becomes its question card below.
  if (verdict === "continue" && t.kind === "conversation" && !t.state.askPending && endsAsking(t.judged))
    return { outcome: "done", rule: "asked", verdict };
  if (verdict === "continue") {
    const progressed = t.state.count === 0 || t.executed > (t.state.executedAtNudge ?? 0);
    if (canNudge && progressed && !(await stretchFull()))
      return {
        outcome: "continue",
        rule: "promise",
        verdict,
        nudge: t.kind === "agents_dm" ? FOLLOW_THROUGH_NUDGE_DM : FOLLOW_THROUGH_NUDGE,
      };
    if (t.kind !== "conversation") return { outcome: "done", rule: "cap", verdict };
    // Promising again without acting: what an earlier run set brings it back (a follow-up, a reminder, work still
    // running), and it rests on that. Only now: any wake here, however far off, would otherwise excuse a new promise.
    if (await t.comesBack?.().catch(() => false)) return { outcome: "waiting", rule: "wakes_later" };
    // Nothing does: a person is asked what it needs instead.
  }
  // It said it couldn't with ways left: once more with its means, while it still acts between nudges.
  if (verdict === "untried") {
    const progressed = t.state.count === 0 || t.executed > (t.state.executedAtNudge ?? 0);
    if (!canNudge || !progressed) return { outcome: "done", rule: "untried_cap", verdict };
    if (await stretchFull()) return { outcome: "done", rule: "stretch_cap", verdict };
    return {
      outcome: "continue",
      rule: "untried",
      verdict,
      nudge: untriedNudge(t.evidence?.means ?? [], t.evidence?.tried ?? [], t.evidence?.ask),
    };
  }
  if (verdict === "done") return { outcome: "done", rule: "judged", verdict };
  if (!t.state.askNudged)
    return (await stretchFull())
      ? { outcome: "done", rule: "stretch_cap", verdict }
      : { outcome: "continue", rule: "ask", verdict, nudge: t.mission ? MISSION_ASK_NUDGE : ASK_NUDGE };
  return { outcome: "ask_card", rule: "ask_card", verdict };
}

/** Moves the state on for a `continue` decision (the ask nudge has its own once-flag). */
export function advance(state: ContinuationState, d: TurnEndDecision, executed: number): ContinuationState {
  const { askPending: _, ...rest } = state;
  if (d.outcome !== "continue") return rest;
  if (d.rule === "local_paths") return { ...rest, pathsNudged: true };
  if (d.rule === "ask") return { ...rest, askNudged: true, askPending: true };
  if (d.rule === "secret") return { ...rest, secretNudged: true };
  if (d.rule === "open_request") return { ...rest, requestNudged: true };
  if (d.rule === "tool_names") return { ...rest, toolsNudged: true };
  return { ...rest, count: state.count + 1, executedAtNudge: executed };
}

/**
 * What a person asked that the run serves, which the turn-end judge holds its reply to: what the run carries
 * (Continuar's request, what a person added while it worked), else the person's message that opened its stretch
 * (ADR 0089): the trigger itself, or the message an agent relayed to it. "" when nobody asked (a routine's brief, an
 * agent's own work).
 */
export async function personAsk(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "stretchId" | "triggerMessageId">,
  carried?: string,
): Promise<string> {
  if (carried) return carried;
  const root = await getMessage(db, run.orgId, runStretchOf(run));
  if (root?.authorType !== "person" || routineBriefOf(root.meta) || root.meta.background === true) return "";
  return root.body;
}

/** The nudges that push an agent on (`decideTurnEnd`), as its runs' `context` steps record them (`nudged`). */
const PUSHES = ["untried", "promise", "unreached", "ask", "mission_ask"];

/** How many times the turn-end check pushed the agent on in its other runs of this run's stretch. */
export async function stretchNudges(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "stretchId" | "triggerMessageId">,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.agentRunSteps)
    .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.agentRunSteps.runId))
    .where(
      and(
        eq(schema.agentRuns.orgId, run.orgId),
        eq(schema.agentRuns.stretchId, runStretchOf(run)),
        eq(schema.agentRuns.agentId, run.agentId),
        ne(schema.agentRuns.id, run.id),
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.kind, "context"),
        inArray(sql`${schema.agentRunSteps.data}->>'nudged'`, PUSHES),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Run errors the person already sees explained elsewhere, or that no one can act on. */
const UNREPORTED = new Set(["agent_archived", "no_ai", "person_limit", "canceled"]);

/**
 * A conversation run failed for good (I5): the person accountable for it (the person behind it, else the routine's
 * creator, else the agent's owner) gets one `run_failed` notification per agent and conversation, resolved by the
 * agent's next run there that ends well. A run another agent's @mention woke tells that agent once ("couldn't
 * finish"), so it tries another way or tells the person; hand-offs in an agents' DM close through their own rows
 * (`onConsultedRunFinished`) and notify nobody here. Never throws.
 */
export async function reportRunFailure(
  deps: { db: Database; pubsub?: PubSub },
  run: AgentRun,
  reason: string,
  cause?: { code?: string; plan?: string },
) {
  if (run.background || UNREPORTED.has(reason)) return;
  try {
    const channel = await getChannelCached(deps.db, run.orgId, run.channelId);
    if (!channel) return;
    // A hand-off's run in the agents' DM: no person can open that DM, and its failure already reaches the asker
    // and the hand-off's line where the work came from (`onConsultedRunFinished`).
    if (isAgentOnlyDm(channel) && (await handedOffRun(deps.db, run))) return;
    const person = accountablePerson(await runAuthority(deps.db, run));
    await notifyRunFailed(deps, run, person, reason, cause);
    if (isAgentOnlyDm(channel)) return;
    const [trigger] = await deps.db
      .select({ agentId: schema.messages.authorAgentId, runId: schema.messages.agentRunId })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, run.orgId), eq(schema.messages.id, run.triggerMessageId)));
    if (!trigger?.agentId || !trigger.runId || trigger.agentId === run.agentId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, run.orgId), eq(schema.agentRuns.id, trigger.runId)));
    const agent = await getAgentCached(deps.db, run.orgId, run.agentId);
    if (!sender || sender.background || !agent) return;
    // Its mention of the same agent failing again in the stretch is written, not woken for: a run that names it
    // each time would wake itself each time.
    const again = (await stretchNoticeRefs(deps.db, sender, "consult_reply")).some(
      (r) => r.via === "mention" && r.agentId === run.agentId,
    );
    const delivered = await deps.db.transaction((tx) =>
      deliverNoticeToRun(
        tx,
        sender,
        {
          kind: "consult_reply",
          from: `@${agent.handle}`,
          text: `It couldn't finish what your mention handed it (${reason.split(":")[0]}).`,
          refs: {
            kind: "note",
            via: "mention",
            wake: "1",
            runId: run.id,
            agentId: run.agentId,
            askerAgentId: sender.agentId,
          },
        },
        again ? { wake: false } : {},
      ),
    );
    await publishDelivery(deps.pubsub, delivered);
  } catch {
    // The failure itself is on the run; a report that couldn't go out leaves it there.
  }
}

const handedOffRun = async (db: Database, run: AgentRun) =>
  (
    await db
      .select({ id: schema.agentConsultations.id })
      .from(schema.agentConsultations)
      .where(and(eq(schema.agentConsultations.orgId, run.orgId), eq(schema.agentConsultations.targetRunId, run.id)))
      .limit(1)
  ).length > 0;

/** The `refs` of the `kind` notices `run`'s agent got in its stretch (ADR 0089), in its conversation. */
async function stretchNoticeRefs(db: Database, run: AgentRun, kind: NoticeKind) {
  const rows = await db
    .select({ refs: sql<Record<string, string> | null>`${schema.messages.meta}->'notice'->'refs'` })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.orgId, run.orgId),
        eq(schema.messages.channelId, run.channelId),
        eq(schema.messages.authorAgentId, run.agentId),
        eq(schema.messages.stretchId, runStretchOf(run)),
        sql`${schema.messages.meta}->'notice'->>'kind' = ${kind}`,
      ),
    );
  return rows.map((r) => r.refs ?? {});
}

/**
 * Tells the run behind `messageId` that its mention didn't wake `skipped` (each with why), once per agent and
 * stretch: the same agent named again there adds nothing (a run that keeps naming it would hear it each time). A
 * self-report (`SELF_REPORT_NOTICES`): it joins the run while live, else waits for the agent's next turn.
 */
export async function tellWakeSkipped(
  deps: { db: Database; pubsub?: PubSub },
  run: AgentRun,
  messageId: string,
  skipped: { handle: string; why: string }[],
  reason: "audience" | "callable" | "no_ai",
) {
  if (run.background || skipped.length === 0) return;
  const told = new Set(
    (await stretchNoticeRefs(deps.db, run, "wake_skipped")).flatMap((r) => (r.agentHandles ?? "").split(",")),
  );
  const fresh = skipped.filter((s) => !told.has(s.handle));
  if (fresh.length === 0) return;
  const text = `${fresh.map((s) => `@${s.handle} wasn't woken by your mention: ${s.why}.`).join(" ")} ${WAKE_SKIPPED_STEP}`;
  const delivered = await deps.db.transaction((tx) =>
    deliverNoticeToRun(tx, run, {
      kind: "wake_skipped",
      text,
      refs: { runId: run.id, messageId, agentHandles: fresh.map((s) => s.handle).join(","), reason },
    }),
  );
  await publishDelivery(deps.pubsub, delivered);
}

/** What the author does about agents its mention didn't wake: hand it over once, in words, and stop. */
export const WAKE_SKIPPED_STEP =
  "The people here see that under your message. Don't mention it again for this: if the work still needs it, say once what it should do, without the @, so someone who can reach it hands it over, and leave it there.";

/**
 * Why an agent's mention couldn't reach `a` for the person behind it (`person`, null for nobody): the real cause, so
 * the author says it right. Its owner's own plan answering only its owner (ADR 0059 §5) keeps everyone else out,
 * consultations too.
 */
function unreachableWhy(a: Agent, person: string | null) {
  if (isComputerBrain(a.brain) && !answersOthers({ ...audienceOf(a), consultable: false }, a.ownerUserId))
    return "it thinks with its owner's own AI plan, which answers only its owner";
  const who = person ? "the person you work for isn't one" : "nobody is behind this work";
  return a.consultable
    ? `only certain people may talk to it, and ${who}`
    : `only certain people may talk to it, it takes no requests from other agents for anyone else, and ${who}`;
}

/**
 * Agents an agent's @mention selected that dispatch couldn't wake because only certain people may talk to them and
 * the person behind the message isn't one (nobody, for a run with no requester), and that no consultation reached
 * (`settleReach` asks the ones that take them): the skip goes in the message's routing decision (`settleReach`
 * records the audience ones), and the author hears it once per stretch (`tellWakeSkipped`). Agents not in the
 * conversation are told by `unreachedNote` already. Never throws.
 */
export async function reportDroppedMentions(
  deps: { db: Database; pubsub?: PubSub },
  message: { id: string; orgId: string; agentRunId: string | null },
  dropped: { agentId: string; handle: string; reason: "not_in_channel" | "audience"; noAi?: boolean }[],
) {
  if (dropped.length === 0) return;
  try {
    // `settleReach` records the audience skips; the ones that left the conversation are recorded here, same words.
    const gone = dropped.filter((d) => d.reason === "not_in_channel");
    if (gone.length > 0) {
      const why = gone.map((d) => `${d.reason}: @${d.handle}`).join(", ");
      await deps.db
        .update(schema.routingDecisions)
        .set({ reason: sql`left(concat_ws('; ', ${schema.routingDecisions.reason}, ${why}::text), 1000)` })
        .where(
          and(eq(schema.routingDecisions.orgId, message.orgId), eq(schema.routingDecisions.messageId, message.id)),
        );
    }
    const audience = dropped.filter((d) => d.reason === "audience");
    if (audience.length === 0 || !message.agentRunId) return;
    const [sender] = await deps.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, message.orgId), eq(schema.agentRuns.id, message.agentRunId)));
    if (!sender || sender.background) return;
    const person = (await runAuthority(deps.db, sender)).personId;
    const rows = await deps.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, message.orgId),
          inArray(
            schema.agents.id,
            audience.map((d) => d.agentId),
          ),
        ),
      );
    const noAi = new Set(audience.filter((d) => d.noAi).map((d) => d.agentId));
    // One notice per cause: the app words people read under it come from `refs.reason`.
    await tellWakeSkipped(
      deps,
      sender,
      message.id,
      rows
        .filter((a) => noAi.has(a.id))
        .map((a) => ({ handle: a.handle, why: "it has no AI connected, so nothing could answer it" })),
      "no_ai",
    );
    await tellWakeSkipped(
      deps,
      sender,
      message.id,
      rows.filter((a) => !noAi.has(a.id)).map((a) => ({ handle: a.handle, why: unreachableWhy(a, person) })),
      "audience",
    );
  } catch {
    // The run that mentioned them is unaffected; the decision row keeps what it had.
  }
}
