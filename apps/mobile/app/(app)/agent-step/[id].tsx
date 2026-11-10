import { useLocalSearchParams } from "expo-router";
import { SetupStepScreen } from "@/features/agents/setup/SetupStepScreen";

/**
 * A row of the right hand's first run that opens a screen (`?step=apps`, and `about` in a personal workspace), from
 * its card in its DM. `text`: what the person already typed or tapped on the card, row 1's sentence filled in.
 */
export default function AgentStepRoute() {
  const { id, step, text } = useLocalSearchParams<{ id: string; step?: string; text?: string }>();
  return <SetupStepScreen key={`${id}-${step}`} agentId={id ?? ""} step={step} text={text} />;
}
