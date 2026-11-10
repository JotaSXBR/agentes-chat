import { and, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { SANDBOX_SCOPE } from "./sandbox";
import type { ToolDefinition } from "./tools/types";

const { secretRequests } = schema;

/** The computer's `run_code` (`sandbox-tools.ts`), not a connector's tool of the same name. */
export const isRunCode = (tool: Pick<ToolDefinition, "name" | "scope" | "connectionId">) =>
  tool.name === "run_code" && tool.scope === SANDBOX_SCOPE && !tool.connectionId;

/**
 * What an agent sends outside the company. A message a customer or someone outside receives (a public reply in a
 * support conversation, an email, a chat, SMS or WhatsApp message, a post they see) waits for a person to see its text,
 * unless the person behind the run gave that exact text to send (`toCustomer`). Two kinds of calls can send one: a
 * connected app's write, and a computer command that uses a stored key (its Vault `keys`, or an env secret the agent
 * holds) to write to a service (`storedKeysOf`, `codeWrites`).
 */

/** At or past this the judge reads the call as a message someone outside receives. */
const CUSTOMER_AT = 0.5;
/** At or past this the person gave the exact text the call sends: it goes as asked. */
const ASKED_AT = 0.8;

/**
 * Whether `call` (with `tool`) sends a message a customer or someone outside the company receives, and the person
 * behind the run (`asked`: what they wrote) didn't give that exact text to send. Throws when the judge fails.
 */
export async function toCustomer(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId?: string;
    tool: string;
    about: string;
    call: Record<string, unknown>;
    asked: string | null;
  },
): Promise<boolean> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    ...(input.runId ? { runId: input.runId } : {}),
    kind: "customer_message",
    state: {
      tool: { name: input.tool, about: cutText(input.about, 600) },
      call: cutText(JSON.stringify(input.call), 3000),
      ...(input.asked ? { asked: cutText(input.asked, 2000) } : {}),
    },
    questions: {
      outside: {
        type: "noul",
        instructions:
          "An AI agent is about to run `call` with `tool`. Will a customer, a client or anyone else outside the company receive or see what it sends?",
        criteria: {
          true: "It sends something outside: a public reply in a support or chat conversation, an email, an SMS or WhatsApp message, a post or a comment customers or the public see.",
          false:
            "It stays inside the company: a private or internal note, a change to records or settings, a message to teammates, an issue, a pull request or a code review, a read.",
        },
      },
      ...(input.asked
        ? {
            asked: {
              type: "noul" as const,
              instructions:
                "`asked` is what the person who asked for this work wrote. Did they give the exact text `call` sends, for the agent to send as it is?",
              criteria: {
                true: "The person wrote this text, or told the agent to send these exact words.",
                false: "The agent wrote the text itself, or changed what the person gave.",
              },
            },
          }
        : {}),
    },
  });
  return (answers.outside?.noul ?? 0) >= CUSTOMER_AT && (answers.asked?.noul ?? 0) < ASKED_AT;
}

/** Names of the env secrets the agent holds on its computers (ADR 0027): never their values. */
export async function heldEnvSecrets(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: secretRequests.name })
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        eq(secretRequests.targetKind, "env"),
        isNull(secretRequests.removedAt),
      ),
    );
  return rows.map((r) => r.name);
}

/** The agent's env secrets a command's code names (`$NAME`, `os.environ["NAME"]`, `process.env.NAME`). */
export async function envSecretsNamed(db: Executor, orgId: string, agentId: string, code: string) {
  if (!code) return [];
  // Names are UPPER_SNAKE_CASE (`SECRET_NAME`): safe inside a pattern as they are.
  return (await heldEnvSecrets(db, orgId, agentId)).filter((name) => new RegExp(`\\b${name}\\b`).test(code));
}

/** The stored keys a `run_code` call uses: its Vault `keys`, and the agent's env secrets its code names. */
export async function storedKeysOf(
  db: Executor,
  at: { orgId: string; agentId: string },
  input: Record<string, unknown>,
) {
  const vault = Array.isArray(input.keys) ? input.keys.filter((k): k is string => typeof k === "string") : [];
  const code = typeof input.code === "string" ? input.code : "";
  return [...new Set([...vault, ...(await envSecretsNamed(db, at.orgId, at.agentId, code))])];
}

/**
 * Code that sends with a write method: an HTTP POST, PUT, PATCH or DELETE, or curl sending data.
 * ponytail: a pattern over the text, not a parser; a request built another way runs unjudged. Upgrade to the runner
 * reporting a command's outgoing requests if that matters.
 */
const WRITES =
  /\b(POST|PUT|PATCH|DELETE)\b|\.(post|put|patch|delete)\s*\(|(^|\s)(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form)(\s|=)/m;
export const codeWrites = (code: string) => WRITES.test(code);
