import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { type AiStatusDeps, agentAiStates } from "./ai-status";
import { canTalkTo, speakerFor } from "./audience";
import { AUTONOMY_DEFAULTS, autonomySettings } from "./autonomy-settings";
import { requireChannelAccess } from "./channels";
import { crowdedAgents } from "./computer-queue";
import { NotFoundError } from "./errors";
import { publishMessageCreated } from "./events";
import { FOLLOW_UP_LIMITS } from "./follow-through";
import { boardColumns, columnOf } from "./issue-columns";
import {
  announceTaskStart,
  approveTaskStart,
  lockAgentTasks,
  startTaskWork,
  type TaskLine,
  type TaskStarted,
} from "./issues";
import { getMessage, messageView } from "./messages";
import { can, getMembership } from "./organizations";
import { outOfOfficeIds } from "./out-of-office";
import { enqueue } from "./outbox";
import { isRightHand, RIGHT_HAND } from "./right-hand";
import { personStoppedSql } from "./runs";
import { openOrg } from "./standing";
import { USAGE_WAIT_CODES } from "./usage-pause";

const {
  agents,
  agentRuns,
  agentRunSteps,
  issues,
  issueActivity,
  messages,
  organizations,
  organizationSettings,
  organizationMembers,
} = schema;

type IssueRow = typeof issues.$inferSelect;

/**
 * The task pump: an agent takes its next task by itself as room frees, and work it left unfinished comes back to it.
 * Only tasks a person gave it (assigned it, or gave the go on the right hand's card): one an agent made or assigned
 * waits for that go. Each start is `startTaskWork` in the task's conversation, on behalf of that person.
 */
export const TASK_PUMP_JOB = "tasks.pump";
/** Automatic starts of one task in a day: past it, it waits for a person. */
export const TASK_AUTO_STARTS_PER_DAY = 3;
/** The default ceiling of automatic starts per workspace and day (`AGENT_TASK_STARTS_PER_DAY`). */
export const TASK_STARTS_PER_DAY = 200;
/** How long a task in progress sits with nothing working on it before its agent picks it up again. */
export const TASK_IDLE_MS = 15 * 60_000;

const DAY_MS = 86_400_000;
const LIVE = ["queued", "running", "waiting_approval", "waiting_input"] as const;
const OPEN = ["todo", "in_progress", "in_review"] as const;
/**
 * What says who gave an agent a task: its making, an assignment, a go on a card, a "Pedir ao". Never the queue's own
 * starts (`agent_asked` with `auto`): they act for whoever gave it.
 */
const STARTER_EVENTS = ["created", "assigned", "start_approved", "agent_asked"];
const starterEventSql = (event: SQL, data: SQL) =>
  sql`${event} in (${sql.join(
    STARTER_EVENTS.map((e) => sql`${e}`),
    sql`, `,
  )}) and coalesce(${data}->>'auto', '') <> 'true'`;
const LINE_RANK: Record<TaskLine, number> = { resume: 0, review: 1, start: 2 };
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

export interface TaskPumpDeps {
  db: Database;
  pubsub?: PubSub;
  /** Whether each agent has an AI to think with now; absent: every agent counts as ready. */
  ai?: AiStatusDeps;
  /** Automatic starts per workspace and day (`TASK_STARTS_PER_DAY`). */
  startsPerDay?: number;
}

/** Pumps the workspace's tasks this minute: one job per minute, whoever asks for it. */
export async function kickTaskPump(db: Executor, orgId: string, now = new Date()) {
  await enqueue(db, {
    orgId,
    kind: TASK_PUMP_JOB,
    payload: {},
    dedupeKey: `${TASK_PUMP_JOB}:${orgId}:${Math.floor(now.getTime() / 60_000)}`,
    maxAttempts: 2,
  });
}

/** A follow-up its agent set (`follow_up`), still to come: the agent comes back to that conversation then by itself. */
const pendingFollowUpSql = (m: SQL, now: Date) => sql`${m}.deleted_at is null
  and ${m}.created_at > ${new Date(now.getTime() - (FOLLOW_UP_LIMITS.maxMinutes + 60) * 60_000).toISOString()}::timestamptz
  and ${m}.meta->'notice'->>'kind' = 'follow_up' and ${m}.meta->'notice'->'refs'->>'state' = 'pending'`;

/**
 * Its agent's last run on the task left it to a person: a person stopped it (ADR 0128: "only when someone asks you
 * to"), or it ended asking them (`decideTurnEnd`'s `asked` or `ask_long`, or a reply carrying a choices card), since
 * asking means waiting (ADR 0131 §1). It holds until a person's word: a newer run there, or their assignment or go.
 */
const leftToPersonSql = sql`exists (select 1 from ${agentRuns} lr where lr.id = (select e.id from ${agentRuns} e
    where e.issue_id = ${issues.id} and e.agent_id::text = ${issues.assigneeId} order by e.created_at desc limit 1)
  and ((lr.status = 'canceled' and ${personStoppedSql(sql`lr.error`)})
    or (select ls.data->'continuation'->>'rule' from ${agentRunSteps} ls where ls.run_id = lr.id
      and ls.kind = 'context' and ls.data ? 'continuation' order by ls.seq desc limit 1) in ('asked', 'ask_long')
    or exists (select 1 from ${messages} lm where lm.id = lr.reply_message_id
      and lm.meta->'artifacts' @> '[{"kind":"choices"}]'::jsonb))
  and not exists (select 1 from ${issueActivity} ga where ga.issue_id = ${issues.id} and ga.author_type = 'person'
    and ga.event in ('assigned', 'start_approved') and ga.created_at > lr.created_at))`;

/**
 * Tasks in SQL a queue might take now, by `lineOf`'s rules: a person still in the workspace gave them
 * (`taskStarters`), nothing works on them, not blocked nor started by themselves `TASK_AUTO_STARTS_PER_DAY` times
 * today, not left to a person (`leftToPersonSql`), on a line (a to-do, work in progress idle `TASK_IDLE_MS`, a review
 * its agent hasn't done), and their agent's queue is on with room left. The pump checks the rest (`heldAgents`, who
 * may talk to whom): this keeps the minute's tick from queueing pumps that start nothing.
 */
const waitingTaskSql = (now: Date) => {
  const at = sql`${now.toISOString()}::timestamptz`;
  const idle = sql`${new Date(now.getTime() - TASK_IDLE_MS).toISOString()}::timestamptz`;
  return sql`${issues.assigneeType} = 'agent' and ${issues.status} in ('todo', 'in_progress', 'in_review')
  and ${issues.blocked} is null
  and not exists (select 1 from ${organizationSettings} s where s.org_id = ${issues.orgId} and not s.task_pump)
  and exists (select 1 from ${agents} a where a.org_id = ${issues.orgId} and a.id::text = ${issues.assigneeId}
    and a.archived_at is null and a.operator_hold_at is null and coalesce(a.autonomy_brakes->>'tasks', '') <> 'false'
    and coalesce(a.builtin, '') <> ${RIGHT_HAND}
    and (select count(*) from ${agentRuns} b where b.org_id = a.org_id and b.agent_id = a.id and b.issue_id is not null
        and b.status in ('queued', 'running'))
      < case when jsonb_typeof(a.autonomy_brakes->'tasksAtOnce') = 'number'
        then (a.autonomy_brakes->>'tasksAtOnce')::numeric else ${AUTONOMY_DEFAULTS.tasksAtOnce} end)
  and not exists (select 1 from ${agentRuns} r where r.issue_id = ${issues.id}
    and r.status in ('queued', 'running', 'waiting_approval', 'waiting_input'))
  and not exists (select 1 from ${messages} f where f.org_id = ${issues.orgId}
    and f.channel_id = ${issues.conversationChannelId} and f.author_agent_id::text = ${issues.assigneeId}
    and ${pendingFollowUpSql(sql`f`, now)})
  and exists (select 1 from (select x.author_type, x.author_id from ${issueActivity} x where x.issue_id = ${issues.id}
      and ${starterEventSql(sql`x.event`, sql`x.data`)} order by x.created_at desc, x.id desc limit 1) g
    join ${organizationMembers} om on om.org_id = ${issues.orgId} and om.user_id = g.author_id
    where g.author_type = 'person')
  and (select count(*) from ${agentRuns} d join ${messages} m on m.org_id = d.org_id and m.id = d.trigger_message_id
      where d.issue_id = ${issues.id} and d.created_at > ${at} - interval '1 day'
        and m.meta->'notice'->>'kind' = 'task_start') < ${TASK_AUTO_STARTS_PER_DAY}
  and not ${leftToPersonSql}
  and (${issues.status} = 'todo'
    or (${issues.status} = 'in_progress' and coalesce((select max(coalesce(e.finished_at, e.updated_at))
        from ${agentRuns} e where e.issue_id = ${issues.id} and e.agent_id::text = ${issues.assigneeId}),
      ${issues.updatedAt}) <= ${idle})
    or (${issues.status} = 'in_review' and not exists (select 1 from ${agentRuns} e where e.issue_id = ${issues.id}
      and e.agent_id::text = ${issues.assigneeId} and coalesce(e.finished_at, e.updated_at) > coalesce(
        (select max(y.created_at) from ${issueActivity} y where y.issue_id = ${issues.id}
          and (y.event in ('created', 'assigned', 'start_approved')
            or (y.event = 'status_changed' and y.data->>'to' = 'in_review'))), ${issues.createdAt}))))`;
};

/** The minute's tick: a pump for each workspace with a task its agent may take. Returns how many were queued. */
export async function enqueueTaskPumps(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .selectDistinct({ orgId: issues.orgId })
    .from(issues)
    .innerJoin(organizations, eq(organizations.id, issues.orgId))
    .where(and(openOrg, waitingTaskSql(now)));
  for (const r of rows) await kickTaskPump(db, r.orgId, now);
  return rows.length;
}

/** One agent's task as its queue reads it. */
interface QueueTask {
  row: IssueRow;
  /** The person it starts for (`taskStarters`); null: nobody gave the go yet. */
  starter: string | null;
  /** A run is on it now (queued, working or waiting), or its agent set a follow-up in its conversation. */
  live: boolean;
  /** Since when nothing worked on it (its last run's end, else its last change). */
  idleSince: number;
  /** Its automatic starts in the last day. */
  autoToday: number;
  /** In review: its agent worked on it since it entered review or since it got it. */
  reviewed: boolean;
  /** Its agent's last run on it left it to a person (`leftToPersonSql`). */
  leftToPerson: boolean;
}

/**
 * Who each task starts for: the person behind its latest making, assignment, go or "Pedir ao", while they still belong to
 * the workspace. An agent's (it made or assigned the task) is nobody's until a person gives the go.
 */
export async function taskStarters(db: Executor, orgId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([issueActivity.issueId], {
      issueId: issueActivity.issueId,
      authorType: issueActivity.authorType,
      authorId: issueActivity.authorId,
      member: organizationMembers.userId,
    })
    .from(issueActivity)
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, issueActivity.orgId), eq(organizationMembers.userId, issueActivity.authorId)),
    )
    .where(
      and(
        eq(issueActivity.orgId, orgId),
        inArray(issueActivity.issueId, issueIds),
        starterEventSql(sql`${issueActivity.event}`, sql`${issueActivity.data}`),
      ),
    )
    .orderBy(issueActivity.issueId, sql`${issueActivity.createdAt} desc`, sql`${issueActivity.id} desc`);
  return new Map(rows.flatMap((r) => (r.authorType === "person" && r.member ? [[r.issueId, r.authorId]] : [])));
}

/** The open tasks of these agents, with what their queues read (`QueueTask`). */
async function queueTasks(db: Executor, orgId: string, agentIds: string[], now: number): Promise<QueueTask[]> {
  if (agentIds.length === 0) return [];
  const found = await db
    .select({ row: issues, leftToPerson: sql<boolean>`${leftToPersonSql}` })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        eq(issues.assigneeType, "agent"),
        inArray(issues.assigneeId, agentIds),
        inArray(issues.status, [...OPEN]),
      ),
    );
  if (found.length === 0) return [];
  const rows = found.map((f) => f.row);
  const held = new Set(found.flatMap((f) => (f.leftToPerson ? [f.row.id] : [])));
  const ids = rows.map((r) => r.id);
  const reviews = rows.filter((r) => r.status === "in_review").map((r) => r.id);
  const conversations = rows.flatMap((r) => (r.conversationChannelId ? [r.conversationChannelId] : []));
  const [starters, runs, entered, followUps] = await Promise.all([
    taskStarters(db, orgId, ids),
    db
      .select({
        issueId: agentRuns.issueId,
        channelId: agentRuns.channelId,
        agentId: agentRuns.agentId,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        ended: sql<Date | null>`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt})`,
        auto: sql<boolean>`exists (select 1 from ${messages} m where m.org_id = ${agentRuns.orgId}
          and m.id = ${agentRuns.triggerMessageId} and m.meta->'notice'->>'kind' = 'task_start')`,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          or(
            inArray(agentRuns.issueId, ids),
            conversations.length
              ? and(inArray(agentRuns.channelId, conversations), inArray(agentRuns.status, [...LIVE]))
              : undefined,
          ),
        ),
      ),
    // When each task entered review, or reached its agent: a review is due only on work it hasn't touched since.
    reviews.length === 0
      ? Promise.resolve([])
      : db
          .select({ issueId: issueActivity.issueId, at: sql<Date>`max(${issueActivity.createdAt})` })
          .from(issueActivity)
          .where(
            and(
              eq(issueActivity.orgId, orgId),
              inArray(issueActivity.issueId, reviews),
              or(
                inArray(issueActivity.event, ["created", "assigned", "start_approved"]),
                and(eq(issueActivity.event, "status_changed"), sql`${issueActivity.data}->>'to' = 'in_review'`),
              ),
            ),
          )
          .groupBy(issueActivity.issueId),
    conversations.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinct({ channelId: messages.channelId, agentId: messages.authorAgentId })
          .from(messages)
          .where(
            and(
              eq(messages.orgId, orgId),
              inArray(messages.channelId, conversations),
              pendingFollowUpSql(sql`${messages}`, new Date(now)),
            ),
          ),
  ]);
  const since = new Map(entered.map((e) => [e.issueId, new Date(e.at).getTime()]));
  return rows.map((row) => {
    const mine = runs.filter(
      (r) =>
        r.agentId === row.assigneeId &&
        (r.issueId === row.id || (!r.issueId && r.channelId === row.conversationChannelId)),
    );
    const live =
      mine.some((r) => (LIVE as readonly string[]).includes(r.status)) ||
      followUps.some((u) => u.channelId === row.conversationChannelId && u.agentId === row.assigneeId);
    const ends = mine.map((r) => (r.ended ? new Date(r.ended).getTime() : 0));
    const lastEnd = Math.max(0, ...ends);
    const entry = since.get(row.id) ?? row.createdAt.getTime();
    return {
      row,
      starter: starters.get(row.id) ?? null,
      live,
      idleSince: lastEnd || row.updatedAt.getTime(),
      autoToday: mine.filter((r) => r.auto && r.createdAt.getTime() > now - DAY_MS).length,
      reviewed: ends.some((end) => end > entry),
      leftToPerson: held.has(row.id),
    };
  });
}

/** Which line of its queue a task is in now, or null when the queue doesn't take it. */
function lineOf(t: QueueTask, now: number): TaskLine | null {
  if (t.live || t.row.blocked || t.leftToPerson || !t.starter || t.autoToday >= TASK_AUTO_STARTS_PER_DAY) return null;
  if (t.row.status === "todo") return "start";
  if (t.row.status === "in_progress") return now - t.idleSince >= TASK_IDLE_MS ? "resume" : null;
  return t.reviewed ? null : "review";
}

/** A queue's next tasks, in order: unfinished work first, then reviews, then to-dos by priority, due date and board. */
type Queued = QueueTask & { line: TaskLine };

async function ordered(db: Database, orgId: string, tasks: QueueTask[], now: number): Promise<Queued[]> {
  const columns = tasks.length ? await boardColumns(db, orgId) : [];
  const board = (r: IssueRow) => {
    const column = columnOf(columns, r);
    return column ? columns.indexOf(column) : columns.length;
  };
  return tasks
    .flatMap((t) => {
      const line = lineOf(t, now);
      return line ? [{ ...t, line }] : [];
    })
    .sort(
      (a, b) =>
        LINE_RANK[a.line] - LINE_RANK[b.line] ||
        (PRIORITY_RANK[a.row.priority] ?? 1) - (PRIORITY_RANK[b.row.priority] ?? 1) ||
        (a.row.dueDate ?? "9999").localeCompare(b.row.dueDate ?? "9999") ||
        board(a.row) - board(b.row) ||
        a.row.boardRank - b.row.boardRank ||
        a.row.number - b.row.number,
    );
}

/** The agents of `agentIds` whose queue is on (the workspace's switch and their own), with their settings. */
async function queueAgents(db: Executor, orgId: string, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const [settings] = await db
    .select({ on: organizationSettings.taskPump })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  if (settings?.on === false) return [];
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(agents.id, agentIds),
        isNull(agents.archivedAt),
        isNull(agents.operatorHoldAt),
      ),
    );
  return rows.flatMap((a) => {
    const s = autonomySettings(a.autonomyBrakes);
    // The right hand does no hands-on work: a task someone gave it waits for a person to hand it on.
    return s.tasks && !isRightHand(a) ? [{ ...a, atOnce: s.tasksAtOnce }] : [];
  });
}

/**
 * Where each of these agents' tasks stands in its queue (1 = next), for the board's "Na fila de Ada · 2º": only tasks
 * the queue would take, of agents whose queue is on.
 */
export async function taskQueues(
  db: Database,
  orgId: string,
  agentIds: string[],
  now = Date.now(),
): Promise<Map<string, { agentId: string; position: number }>> {
  const out = new Map<string, { agentId: string; position: number }>();
  const on = await queueAgents(db, orgId, agentIds);
  if (on.length === 0) return out;
  const queue = await ordered(
    db,
    orgId,
    await queueTasks(
      db,
      orgId,
      on.map((a) => a.id),
      now,
    ),
    now,
  );
  const seen = new Map<string, number>();
  for (const t of queue) {
    const agentId = t.row.assigneeId as string;
    const position = (seen.get(agentId) ?? 0) + 1;
    seen.set(agentId, position);
    out.set(t.row.id, { agentId, position });
  }
  return out;
}

/** Task runs of an agent that hold one of its "tasks at once": queued or working (waiting ones don't). */
async function busyTaskRuns(db: Executor, orgId: string, agentId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        sql`${agentRuns.issueId} is not null`,
        inArray(agentRuns.status, ["queued", "running"]),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Automatic starts in the workspace in the last day, counted on its agents' runs. */
async function startsToday(db: Executor, orgId: string, now: number) {
  const [row] = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*)::int as n from ${agentRuns} r
      join ${messages} m on m.org_id = r.org_id and m.id = r.trigger_message_id
      where r.org_id = ${orgId}::uuid and r.created_at > ${new Date(now - DAY_MS).toISOString()}::timestamptz
        and m.meta->'notice'->>'kind' = 'task_start'`),
  );
  return Number(row?.n ?? 0);
}

/** Of these agents, the ones that can't take work now: no AI, its computer away or full, a plan or budget wait. */
async function heldAgents(deps: TaskPumpDeps, orgId: string, agentIds: string[]): Promise<Set<string>> {
  const { db } = deps;
  const [states, out, crowded, waiting] = await Promise.all([
    deps.ai ? agentAiStates(deps.ai, orgId, agentIds) : Promise.resolve(null),
    outOfOfficeIds(db, orgId, agentIds),
    crowdedAgents(db, orgId, agentIds),
    db
      .selectDistinct({ id: agentRuns.agentId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.agentId, agentIds),
          eq(agentRuns.status, "waiting_input"),
          inArray(sql<string>`${agentRuns.transcript}->'waitingForBrain'->>'code'`, [...USAGE_WAIT_CODES]),
        ),
      ),
  ]);
  const held = new Set([...out, ...crowded, ...waiting.map((w) => w.id)]);
  for (const id of agentIds) if (states && states.get(id)?.state !== "ready") held.add(id);
  return held;
}

/**
 * The pump of one workspace (`TASK_PUMP_JOB`): each agent whose queue is on takes its next tasks, up to its "tasks at
 * once" minus its task runs queued or working, unless it can't work now (`heldAgents`). Each task starts at most
 * `TASK_AUTO_STARTS_PER_DAY` times a day by itself, and the workspace at most `startsPerDay`. One agent's starts
 * happen under its lock, so two pumps never start a task twice. Returns how many started.
 */
export async function pumpTasks(deps: TaskPumpDeps, orgId: string, now = new Date()): Promise<number> {
  const { db } = deps;
  const ms = now.getTime();
  const [org] = await db.select({ open: openOrg }).from(organizations).where(eq(organizations.id, orgId));
  if (!org?.open) return 0;
  const assigned = await db
    .selectDistinct({ id: issues.assigneeId })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), waitingTaskSql(now)));
  const on = await queueAgents(
    db,
    orgId,
    assigned.flatMap((a) => (a.id ? [a.id] : [])),
  );
  if (on.length === 0) return 0;
  const queue = await ordered(
    db,
    orgId,
    await queueTasks(
      db,
      orgId,
      on.map((a) => a.id),
      ms,
    ),
    ms,
  );
  const ready = [];
  for (const agent of on) {
    const next = queue.filter((t) => t.row.assigneeId === agent.id);
    if (next.length > 0 && (await busyTaskRuns(db, orgId, agent.id)) < agent.atOnce) ready.push({ agent, next });
  }
  if (ready.length === 0) return 0;
  const held = await heldAgents(
    deps,
    orgId,
    ready.map((r) => r.agent.id),
  );
  let room = (deps.startsPerDay ?? TASK_STARTS_PER_DAY) - (await startsToday(db, orgId, ms));
  const speakers = new Map<string, Awaited<ReturnType<typeof speakerFor>>>();
  for (const starter of new Set(queue.map((t) => t.starter as string)))
    speakers.set(starter, await speakerFor(db, orgId, starter));
  let count = 0;
  for (const { agent, next } of ready) {
    if (held.has(agent.id) || room <= 0) continue;
    const started: TaskStarted[] = await db.transaction(async (tx) => {
      await lockAgentTasks(tx, agent.id);
      let free = agent.atOnce - (await busyTaskRuns(tx, orgId, agent.id));
      const out: TaskStarted[] = [];
      for (const t of next) {
        if (free <= 0 || room <= 0) break;
        const starter = t.starter as string;
        const speaker = speakers.get(starter);
        // Only an agent that person may talk to: the work is theirs.
        if (!speaker || !canTalkTo(agent, starter, speaker)) continue;
        const [row] = await tx.select().from(issues).where(eq(issues.id, t.row.id)).for("update");
        if (!row || row.assigneeId !== agent.id || row.status !== t.row.status || row.blocked) continue;
        if (await liveOn(tx, row, agent.id)) continue;
        out.push(await startTaskWork(tx, row, agent, { by: "queue", userId: starter, line: t.line }));
        free--;
        room--;
      }
      return out;
    });
    for (const s of started) await announceTaskStart(deps, s).catch(() => {});
    count += started.length;
  }
  return count;
}

/** A run of the agent on the task now: linked to it, or in its conversation before its context linked it. */
async function liveOn(tx: Executor, task: IssueRow, agentId: string) {
  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, task.orgId),
        eq(agentRuns.agentId, agentId),
        inArray(agentRuns.status, [...LIVE]),
        task.conversationChannelId
          ? or(eq(agentRuns.issueId, task.id), eq(agentRuns.channelId, task.conversationChannelId))
          : eq(agentRuns.issueId, task.id),
      ),
    )
    .limit(1);
  return Boolean(run);
}

/** A task a reply lists (`meta.tasks`) that waits for a person's go (`held`). */
interface HeldTask {
  issueId: string;
  agentId: string;
}

const heldTasksOf = (meta: Record<string, unknown>): HeldTask[] =>
  (Array.isArray(meta.tasks) ? (meta.tasks as Record<string, unknown>[]) : []).flatMap((t) =>
    t && t.held === true && typeof t.issueId === "string" && typeof t.agentId === "string"
      ? [{ issueId: t.issueId, agentId: t.agentId }]
      : [],
  );

/**
 * "Começar estas" on a reply's tasks (`meta.tasks` marked `held`): a person gives the go for the tasks an agent made or
 * handed on in that turn. Each becomes theirs (`approveTaskStart`), its agent's queue takes it as room frees, or it
 * starts now where that queue is off. Once per card (`meta.tasksStarted`); anyone who reads the conversation and may
 * post can press it, for the tasks they see. Returns how many got the go.
 */
export async function startHeldTasks(
  deps: TaskPumpDeps,
  userId: string,
  orgId: string,
  messageId: string,
): Promise<number> {
  const { db } = deps;
  const message = await getMessage(db, orgId, messageId);
  const held = message && message.authorType === "agent" && !message.deletedAt ? heldTasksOf(message.meta) : [];
  const membership = await getMembership(db, userId, orgId);
  if (!message || held.length === 0 || !membership || !can(membership, "post"))
    throw new NotFoundError("Message not found");
  await requireChannelAccess(db, userId, orgId, message.channelId).catch(() => {
    throw new NotFoundError("Message not found");
  });
  // The card is claimed first: two people pressing it at once give one go.
  const mark = { byUserId: userId, at: new Date().toISOString() };
  const [updated] = await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{tasksStarted}', ${JSON.stringify(mark)}::jsonb)` })
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId), sql`not (${messages.meta} ? 'tasksStarted')`))
    .returning();
  if (!updated) return 0;
  const approved = [];
  for (const t of held) {
    const row = await approveTaskStart(deps, userId, orgId, t.issueId, t.agentId).catch(() => null);
    if (row) approved.push(row);
  }
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(updated));
  // Where an agent's queue is off, the go starts it now: nothing else would.
  const on = new Set(
    (
      await queueAgents(db, orgId, [
        ...new Set(approved.map((r) => r.assigneeId).filter((id): id is string => Boolean(id))),
      ])
    ).map((a) => a.id),
  );
  for (const row of approved) {
    if (!row.assigneeId || on.has(row.assigneeId)) continue;
    const agentId = row.assigneeId;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) continue;
    const started = await db.transaction(async (tx) => {
      await lockAgentTasks(tx, agentId);
      return (await liveOn(tx, row, agentId)) ? null : startTaskWork(tx, row, agent, { by: "person", userId });
    });
    if (started) await announceTaskStart(deps, started).catch(() => {});
  }
  if (on.size > 0) await kickTaskPump(db, orgId);
  return approved.length;
}
