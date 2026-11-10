# 0147. How agents talk to you: simple by default, technical by choice

- Status: Accepted (built)
- Date: 2026-11-04
- Extends: ADR 0053 (who is behind a run), ADR 0122 (fourteen languages), ADR 0137 (the right hand's greeting cards)
- Code: db `packages/db/src/schema/tenancy.ts` (`organization_members.agent_style`, migration `0217_agent_style.sql`); engine `agent-style.ts` (`AGENT_STYLES`, `agentStyleOf`, `saveAgentStyle`, `TECHNICAL_STYLE_LINE`, `set_reply_style`), `context.ts` (`PLAIN_WORDS_LINE`, `personNotes`), `organizations.ts` (`setAgentStyle`, `Membership.agentStyle`), `tools/directory.ts` (`RARE_TOOLS`), `tools/run-policy.ts`; server `routes/app/management.ts` (`PUT …/me/agent-style`), `routes/app/account.ts` (`agentStyle` in `GET /me`), `engine.ts`; client `api/queries.ts` (`useSetAgentStyle`), `lib/right-hand.ts` (`introCards` `style`), `lib/markdown.ts` (`detailsAt`); web `components/AccountSettings.tsx`, `RightHandIntro.tsx` (`StyleCard`), `lib/markdown.tsx`, `layout.css` (`.md__details`); phone `features/me/PreferencePages.tsx` (`AgentStylePage`), `MeScreen.tsx`, `app/(app)/me/agent-style.tsx`, `features/right-hand/Intro.tsx`, `features/chat/logic.ts` (`parseBlocks`), `MessageText.tsx` (`Details`)

## Context

People who don't code read agents' replies as a wall: a request for the GitHub app's access to one repository came as three paragraphs of folder names, commit hashes, file paths, HTTP codes and JSON keys. A person said that at a glance they thought about not reading at all and approving every button that appeared. That is the opposite of what approvals are for.

The prompt already said not to name tools, and to write like a colleague texting. Nothing said to lead with what the person must do, nor kept paths and codes out, and a technical person had no way to ask for the details.

## Decision

### 1. One choice per person and workspace, Simples until changed

`organization_members.agent_style`: `simple`, `technical`, or null (never picked). Null reads as simple. Per workspace like `show_activity` and `timezone`: a developer may want details at work and not in a side project. It is set in Sua conta (web Settings, phone Você), by the right hand's question, or by asking any agent.

### 2. Simple is the rule every agent reads; technical is a line in the turn

The simple rules sit in "# How to reply" (`PLAIN_WORDS_LINE`), for everyone: lead with what happened and what the person must do, in one or two short everyday sentences; no tool names, paths, hashes, codes, JSON keys or internal names unless the person must type or click them or is clearly technical; a step of theirs is a short numbered list of what to click; more only when asked, or last in a collapsed block.

A person who chose technical gets `TECHNICAL_STYLE_LINE` among the per-turn blocks: paths, codes, ids and tool names are welcome, details may go in the text, and what goes with an approval or a card stays plain.

Why the default in the system text and not in the turn: the system text is cached and shared by every agent of the workspace, the turn is paid again on every call. Most people get the default, so it costs nothing per turn, and a DM "oi" stays under its ceiling.

### 3. Whose style

The person behind the run (ADR 0053): the trigger's author for a DM or channel message, and for a routine's brief (written as its creator). With no author (another agent's mention), `runAuthority` finds the person, else the routine's creator (`wikiPersonOf`). The agents' DM gets no line: no person reads it, and the asking agent words the answer for its own person. For a message a person wrote, the style is read in the same statement as the app language, so a run reads nothing more before the model call.

### 4. Asking once, and changing it by saying so

Under the right hand's greeting, once an AI is connected and while the person never picked, a card asks "Como prefere que eu fale com você?" with two answers. A tap saves it and the card goes, on every device. It is drawn by the app (ADR 0137 §6), so it costs no model call.

`set_reply_style` lets any agent save it when the person asks ("fala mais simples", "pode ser técnico"). It acts only for the person behind the run (`personBehindCall`) and refuses when nobody is. It loads on demand with the conversation's rarer tools, so it adds nothing to every prompt but a word in that group's label.

### 5. Collapsed details in Markdown

Agents write `<details><summary>Details</summary> … </details>` (the label in the reply's language), the HTML every model knows. The shared parser (`detailsAt`) reads it as a block whose body is Markdown of its own, on one line or many, `</details>` ending its last line (a nested block or one inside fenced code doesn't close it; unclosed while streaming, it runs to the end). The web draws a native `<details>`, the phone a row that opens on tap. Every other HTML stays text. The wiki editor's parse leaves it off, so a page keeps its source as written.

### 6. Cards

Approval and action cards keep their own app-written text. What the agent writes with them follows the same rule in both modes (`TECHNICAL_STYLE_LINE` says so).

## Consequences

- Replies to most people get shorter, with the action first; the details are one tap away.
- A technical person's turns cost about 170 characters more.
- The plain-words rule is now longer for everyone (about 90 characters more in a DM "oi").

## Addendum (2026-11-09): a reply that names its tools is written again

In a plain chat an agent asked a person to send a login "by `request_secret`": it named its own tool to someone who can't see or use it, instead of calling it. The plain-words rule listed tool names among paths and codes, with a way out for technical people, and nothing checked the reply.

1. **The rule** (`OWN_TOOLS_LINE`, last of the tools part of "# What you can do", every run with tools): people can't see or use the agent's tools, so it calls them itself and names no tool, function or parameter the person didn't name first.
2. **The check** (`toolsNamed`, the `tool_names` rule of `decideTurnEnd`, a cheap rule before the judgment, ADR 0097): a conversation reply that names one of the run's own tools (a name with an underscore, bare, in backticks or behind the bridge's `mcp__agentes__`) isn't posted, and the run writes it again once in plain words (`toolNamesNudge`). The next reply is posted as it is. Not when the person's message has that name, for a person who chose technical replies, in an agents' DM, a routine's record, or a reply at the turn cap.
3. **Off the screen at once**: a held reply already showed live as it streamed. Any held reply (this one, a secret asked in the chat, a give-up judged untried) now opens the next model call at once with no text (`agent.delta`), so the apps drop it. Before, it stayed until the next call wrote, and a call that came first (`request_secret`, as told) kept it as that call's narration, the line its message opens with.
4. **The fast reply** (`talker.ts`), which reads the task's steps by tool name, gets the same rule in its prompt.

A DM "oi" grows by 195 characters (45,632 measured), and the `turns-eval` ceiling goes from 45,900 to 46,100.

## Addendum (2026-11-10): nothing a person was answered vanishes

A person asked an agent where a task came from, in that task's conversation. The answer streamed on screen, the turn-end check held it as a give-up it hadn't tried, the next try passed, and the app took the text away: no answer at all. Item 3 above made held replies leave the screen at once and never come back, which kept that outcome. The same day other answers appeared and vanished on a pass, a follow-up in a task's conversation was canceled when it came due, a stop dropped the person's own newest instruction, and one answer showed twice.

1. **A held reply is owed** (`Transcript.held`, with the post count when it was held). While nothing is posted after it, a try that passes or ends quietly posts it as the answer, a try that writes nothing answers with it instead of a nudge to answer, and a failure posts it first (not for an agent held, paused, archived or with no AI). A line the server writes meanwhile ("I'll answer when it's back": the provider down, the computer full, a plan's limit) answers nothing, so the reply stays owed through it. A later turn that acted and wrote nothing still closes with its own line, and a stop still never posts it.
2. **A run that may pass shows no words until it acts** (`mayStillPass`, the delta publisher's `hold`): no text and no typing until it calls a tool other than `pass`, posts, or a person writes into it. The apps show it thinking, and its answer arrives whole. A `pass` step line never carries the words before it.
3. **A task's own conversation is addressed to its agent** (`ownTask` in `replyPolicyFor`, ADR 0145): a person's message there that the router gives the task's agent can't be passed on, like a router follow-up. Another agent brought in there may still pass.
4. **Follow-ups there come**: `personCanPost` takes a task's reader as one who can post in its conversation, as posting itself does.
5. **A stop of one's own message before its run started keeps it while the agent's other work there goes on** (ADR 0128): Esc and the composer's stop take the newest run, which is often the one the person's correction just queued, while they mean the work under way. The agent reads that the message still stands (`refs.own`), instead of "Don't pick it up again". With nothing else of that agent under way there, the stop took the message back and keeps the old line, as does a stop asked of the right hand in words, of someone else's message or of a run already working.
6. **One notice per answer** (ADR 0095): notes to one colleague that its one reply closed come back as one `consult_reply` notice with each of their asks, still with one wake.
