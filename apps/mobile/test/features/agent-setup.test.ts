import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { firstRunSteps } from "@agenteschat/client/lib/setup-checklist";
import { agent } from "./fixtures";

// One setup place on the phone, as on the web: the right hand's first run in its own DM (ADR 0155 §6). Any other
// agent, however new, shows no checklist in its DM nor on its screen.

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

test("an agent's DM never shows a setup checklist: its first day, and the no-AI line as in every DM", () => {
  const chat = src("chat/ChatScreen.tsx");
  for (const gone of ["AgentSetupIntro", "AgentSetupCard", "useSetupSteps", "setupIntro"]) {
    expect(chat).not.toContain(gone);
  }
  // Before anyone wrote, the app's hello in its voice with three starts.
  expect(chat).toContain(
    "<FirstDay agent={dmAgent} bottomInset={composerHeight} keyboardLift={lift} onAsk={onSend} />",
  );
  // Only the right hand's greeting sits over a conversation, with the one card inside it.
  expect(chat).toContain("atStart && (hasPins || (dmAgent && rightHand))");
  expect(chat).toContain("member && !rightHand && !planHeld\n");
  expect(src("agents/AgentProfileScreen.tsx")).not.toContain("SetupCard");
});

test("the one checklist is the right hand's: a new agent has no rows, for its owners either", () => {
  const owner = { owner: true, connectAi: true, pay: true, connectors: true, invite: true };
  const leo = agent({ id: "a-leo", name: "Leo", setup: { role: "sales", done: [] } });
  expect(firstRunSteps(leo, owner)).toEqual([]);
  expect(firstRunSteps({ ...leo, builtin: "right_hand" }, owner)).toEqual(["ai", "apps", "people"]);
  // Its apps row is the one pushed screen, registered in the stack.
  const layout = readFileSync(new URL("../../app/(app)/_layout.tsx", import.meta.url), "utf8");
  expect(layout).toContain('<Stack.Screen name="agent-step/[id]" options={{ ...pushed, ...scrollUnder }} />');
  expect(src("agents/setup/SetupStepScreen.tsx")).toContain(
    'if (!agent?.setup || !isRightHand(agent) || step !== "apps")',
  );
});
