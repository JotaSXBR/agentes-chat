import { useLocalSearchParams } from "expo-router";
import { SetupStepScreen } from "@/features/agents/setup/SetupStepScreen";

/** A row of the right hand's first run that opens a screen (`?step=apps`), from its card in its DM. */
export default function AgentStepRoute() {
  const { id, step } = useLocalSearchParams<{ id: string; step?: string }>();
  return <SetupStepScreen key={`${id}-${step}`} agentId={id ?? ""} step={step} />;
}
