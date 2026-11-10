import { and, type Executor, eq, inArray, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { cutMarked } from "./format";

const { issues, artifacts, agents, users, messages, channels } = schema;

/**
 * "Ask Ada to implement" works in the task's own conversation (ADR 0145). Work asked before that lives in the
 * requester's DM with the agent, as a thread whose root is a compact card (`meta.issueWork`). The agent's
 * instructions never show in the chat: they are built from the issue at run time (`issueWorkBrief`). Where the
 * issue came from a channel message, that conversation gets one discreet line (`meta.issueTaken`).
 */
export interface IssueWorkMeta {
  issueId: string;
  number: number;
  title: string;
  agentId: string;
}

/** `meta.issueWork` (the root card of an issue's work thread) or `meta.issueTaken` (the line where it came from). */
export function issueWorkOf(
  meta: Record<string, unknown> | null | undefined,
  key: "issueWork" | "issueTaken" = "issueWork",
) {
  const v = meta?.[key] as Partial<IssueWorkMeta> | undefined;
  if (!v || typeof v !== "object") return null;
  if (typeof v.issueId !== "string" || typeof v.number !== "number" || typeof v.title !== "string") return null;
  return {
    issueId: v.issueId,
    number: v.number,
    title: v.title,
    agentId: typeof v.agentId === "string" ? v.agentId : "",
  };
}

/**
 * The task block of a run in a task's conversation (ADR 0145), or in an older work thread of a DM, read from the
 * issue now (description, criteria and their state, PRs, files), so each turn sees what the team changed since
 * the last one. The conversation itself is the thread the run reads. `asked`: the agent was asked to implement it
 * (the assignee working on it); else it was called into the task's conversation.
 */
export async function issueWorkBrief(
  db: Executor,
  orgId: string,
  issueId: string,
  options: { asked?: boolean; inConversation?: boolean } = {},
): Promise<string | null> {
  const asked = options.asked ?? true;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));
  if (!issue) return null;
  // Files attached when it was created, on comments or linked later: the agent opens them with `read_artifact`.
  const files = issue.artifactIds.length
    ? await db
        .select({ id: artifacts.id, title: artifacts.title })
        .from(artifacts)
        .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, issue.artifactIds), isNull(artifacts.deletedAt)))
    : [];
  const criteria = issue.criteria.map((c, i) => `${i + 1}. [${c.done ? "x" : " "}] ${c.text}`).join("\n");
  const prs = issue.pullRequests.map((p) => `- #${p.number} ${p.url}`).join("\n");
  const here = options.inConversation ?? true;
  return [
    asked ? `# Your task: issue #${issue.number}` : `# This conversation: task #${issue.number}`,
    asked
      ? `You were asked to implement issue #${issue.number} "${issue.title}" (status: ${issue.status}).`
      : `This is the conversation of task #${issue.number} "${issue.title}" (status: ${issue.status}). Someone called you into it: answer what they ask about the task.`,
    issue.description.trim() ? `## Description\n${issue.description.trim()}` : "",
    await taskOriginText(db, orgId, issue.id),
    criteria ? `## Acceptance criteria\n${criteria}` : "",
    prs ? `## Pull requests linked\n${prs}` : "",
    files.length
      ? `## Files attached to the issue\n${files.map((f) => `- ${f.title} (artifact ${f.id})`).join("\n")}\nOpen one with \`read_artifact\` when it helps.`
      : "",
    [
      "## How to work on it",
      here
        ? "- This is the task's own conversation: everyone who sees the task reads it and writes here, and your replies land here. Say when you start, at each real step and when you finish, in your replies."
        : "- This conversation is private between you and the person who asked. The rest of the team follows the task's own conversation: post progress there with `comment_issue` when you start, at each real step and when you finish.",
      asked
        ? `- Refer to the issue as #${issue.number} in your tools. Check each criterion you meet with \`update_issue\` (\`done_criteria\`), and link the pull request with \`update_issue\`. The issue's status follows your work on its own: don't set it yourself.`
        : `- Refer to the task as #${issue.number} in your tools. Change it only when someone asks you to.`,
      "- Sensitive actions (merge, deploy, rollback) still need a person's approval.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SIBLINGS_SHOWN = 10;
const QUOTE_MAX = 500;
const minute = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A person's name or an agent's @handle, as the agent reads them. */
async function nameOf(db: Executor, orgId: string, type: string, id: string) {
  if (type === "agent") {
    const [a] = await db
      .select({ handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), sql`${agents.id}::text = ${id}`));
    return a ? `@${a.handle}` : "an agent";
  }
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? "someone";
}

/**
 * Where a task comes from, as its agent reads it (the brief, `list_issues`): who made it and when, the message it was
 * made from (its words only from a public channel: an agent given the task from outside a private conversation never
 * reads the rest of it), the task it is a step of, and the other open tasks asked with it, by number and title only,
 * so it doesn't redo them. "" when nothing is known.
 */
export async function taskOriginText(db: Executor, orgId: string, issueId: string): Promise<string> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)));
  if (!issue) return "";
  const source = issue.source as { messageId?: unknown };
  const messageId = typeof source.messageId === "string" ? source.messageId : null;
  const [maker, [origin], [parent], siblings] = await Promise.all([
    nameOf(db, orgId, issue.createdByType, issue.createdById),
    messageId
      ? db
          .select({
            body: messages.body,
            createdAt: messages.createdAt,
            channelId: messages.channelId,
            authorType: messages.authorType,
            authorId: sql<string>`coalesce(${messages.authorUserId}, ${messages.authorAgentId}::text, '')`,
            kind: channels.kind,
            visibility: channels.visibility,
            channelName: channels.name,
          })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      : Promise.resolve([]),
    issue.parentIssueId
      ? db
          .select({ number: issues.number, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.orgId, orgId), eq(issues.id, issue.parentIssueId)))
      : Promise.resolve([]),
    issue.parentIssueId || messageId
      ? db
          .select({
            number: issues.number,
            title: issues.title,
            status: issues.status,
            assigneeType: issues.assigneeType,
            assigneeId: issues.assigneeId,
          })
          .from(issues)
          .where(
            and(
              eq(issues.orgId, orgId),
              ne(issues.id, issue.id),
              issue.parentIssueId ? ne(issues.id, issue.parentIssueId) : undefined,
              inArray(issues.status, ["todo", "in_progress", "in_review"]),
              issue.channelId === null ? isNull(issues.channelId) : eq(issues.channelId, issue.channelId),
              eq(issues.restricted, issue.restricted),
              sql`${issues.audienceUserIds} = ${`{${issue.audienceUserIds.join(",")}}`}::text[]`,
              or(
                issue.parentIssueId ? eq(issues.parentIssueId, issue.parentIssueId) : undefined,
                messageId ? sql`${issues.source}->>'messageId' = ${messageId}` : undefined,
              ),
            ),
          )
          .orderBy(issues.number)
          .limit(SIBLINGS_SHOWN)
      : Promise.resolve([]),
  ]);
  const from = origin
    ? `, from ${await nameOf(db, orgId, origin.authorType, origin.authorId)}'s message${
        origin.kind === "channel" ? ` in #${origin.channelName}` : ""
      } of ${minute(origin.createdAt)}${
        origin.kind === "channel" && origin.visibility === "public"
          ? `: "${cutMarked(origin.body.replace(/\s+/g, " ").trim(), QUOTE_MAX)}"`
          : " (a private conversation)"
      }`
    : "";
  const others = await Promise.all(
    siblings.map(async (t) => {
      const who = t.assigneeType && t.assigneeId ? `, ${await nameOf(db, orgId, t.assigneeType, t.assigneeId)}` : "";
      return `- #${t.number} ${t.title} (${t.status}${who})`;
    }),
  );
  return [
    "## Where it comes from",
    `Made by ${maker} at ${minute(issue.createdAt)}${from}.`,
    parent ? `A step of #${parent.number} "${parent.title}" (${parent.status}).` : "",
    others.length ? `Asked with it, still open (don't redo them):\n${others.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
