import type { OrgSettings } from "@agenteschat/client";
import { useSettings, useUpdateSettings } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { Card, CardFooter, CardHeader, Select } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";

type NewAgentAudience = NonNullable<OrgSettings["newAgentAudience"]>;
const MODES: NewAgentAudience[] = ["everyone", "owner"];

/**
 * Configurações › Agentes e acesso: who can talk to the workspace's new agents, open by default (everyone). Criar
 * agente starts its own choice here, and an import, a team proposal or the API takes it as is. For who configures the
 * workspace; the agents that exist change in Equipe, several at once.
 */
export function NewAgentsAudienceCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  if (!can(org, "configure") || !settings.data) return null;
  const value =
    (update.isPending ? update.variables?.newAgentAudience : undefined) ?? settings.data.newAgentAudience ?? "everyone";
  return (
    <Card aria-labelledby="sec-new-agents">
      <CardHeader id="sec-new-agents" icon="agent" title={t("access.newAgents.title")} />
      <div className="settings-rows">
        <PrefRow
          id="new-agents-audience"
          icon="audiencePeople"
          label={t("audience.section")}
          hint={t("common.joinSentences", { a: t("access.newAgents.hint"), b: t("access.newAgents.existing") })}
          control={
            <Select
              size="sm"
              align="end"
              aria-label={t("audience.section")}
              value={value}
              onValueChange={(newAgentAudience) => update.mutate({ newAgentAudience })}
              options={MODES.map((m) => ({ value: m, label: t(`audience.mode.${m}`) }))}
            />
          }
        />
      </div>
      {/* Narrowed, it says whether it holds for other agents too. */}
      {value === "owner" && <CardFooter>{t("audience.several.agents.consulted")}</CardFooter>}
    </Card>
  );
}
