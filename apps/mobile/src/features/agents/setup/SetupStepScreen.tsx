import type { SetupStep } from "@agenteschat/client";
import { useCatalog, useConnections } from "@agenteschat/client";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { firstRunAppList } from "@agenteschat/client/lib/setup-checklist";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedList, GroupedRow } from "@/ui";
import { router } from "@/ui/navigation";
import { ConnectorIcon } from "../../connectors/ConnectorIcon";
import { SettingsPage } from "../../settings/parts";
import { useColors, useDirectory } from "../../shared/hooks";
import { PushedHeader, tapHaptic } from "../../shared/parts";

/*
 * The screen behind the right hand's first-run apps row (ADR 0155 §6), the web's dialog on the phone. Its AI row opens
 * Connect AI, its people row the invite screen.
 */

/** Opens a row's screen. */
export const openSetupStep = (agentId: string, step: SetupStep) =>
  router.push({ pathname: "/agent-step/[id]", params: { id: agentId, step } });

export function SetupStepScreen({ agentId, step }: { agentId: string; step: string | undefined }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  if (!agent?.setup || !isRightHand(agent) || step !== "apps") {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("agentSetup.firstRun.apps.title")} solid={false} />
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </View>
    );
  }
  return <FirstRunAppsStep />;
}

/**
 * The first run's apps row, as the web's dialog: the apps the team just made would use, plug-and-play ones only, each
 * opening the same connect sheet as Apps (whose last step says which agents use it), and the whole list under them.
 */
function FirstRunAppsStep() {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const connected = new Set((connections.data ?? []).filter((x) => !x.revokedAt).map((x) => x.connector));
  const list = firstRunAppList(
    catalog.data?.connectors ?? [],
    connected,
    dir.agents.filter((a) => !isRightHand(a)),
  );
  return (
    <SettingsPage title={t("agentSetup.firstRun.apps.title")}>
      <GroupedFooter>{t("agentSetup.firstRun.apps.desc")}</GroupedFooter>
      {catalog.isPending || connections.isPending ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {list.length > 0 ? (
        <GroupedList>
          {list.map(({ def, suggested }) => (
            <GroupedRow
              key={def.id}
              leading={<ConnectorIcon def={def} label={connectorName(t, def)} size={30} />}
              label={connectorName(t, def)}
              {...(suggested ? { sub: t("agentSetup.suggested") } : {})}
              value={t("agentSetup.firstRun.apps.connect")}
              chevron
              onPress={() => {
                tapHaptic();
                router.push({ pathname: "/connectors", params: { connect: def.id } });
              }}
            />
          ))}
        </GroupedList>
      ) : null}
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("agentSetup.firstRun.apps.all")}
          chevron
          onPress={() => router.push("/connectors")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { marginVertical: 16 },
});
