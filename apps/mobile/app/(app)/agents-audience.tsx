import { useLocalSearchParams } from "expo-router";
import { AgentsAudienceScreen } from "@/features/agents/AgentsAudienceScreen";

/** "Quem pode falar" for several agents at once, pushed from Agentes' bar; `agent`: opened for that one, ticked. */
export default function AgentsAudienceRoute() {
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  return <AgentsAudienceScreen {...(agent ? { agentId: agent } : {})} />;
}
