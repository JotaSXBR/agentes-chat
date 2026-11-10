import { useLocalSearchParams } from "expo-router";
import { RoutineForm } from "@/features/routines/RoutineForm";
import { isSafeId } from "@/features/shared/logic";

/**
 * "Nova rotina", pushed over Rotinas; `?edit=<id>` is "Editar rotina", `?agent=<id>` starts it for that agent (from
 * its profile). Presentation set in `_layout`.
 */
export default function NewRoutineRoute() {
  const { edit, agent } = useLocalSearchParams<{ edit?: string; agent?: string }>();
  return <RoutineForm editId={isSafeId(edit) ? edit : null} agentId={isSafeId(agent) ? agent : null} />;
}
