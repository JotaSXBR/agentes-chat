import type { SetupStep } from "@agenteschat/client";
import { useCatalog, useConnections, useSettings, useUpdateSettings } from "@agenteschat/client";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { firstRunAppList } from "@agenteschat/client/lib/setup-checklist";
import {
  aboutYouContext,
  LIFE_AREAS,
  type LifeArea,
  lifeAreaTemplate,
  readAboutYou,
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedFooter, GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { router } from "@/ui/navigation";
import { ConnectorIcon } from "../../connectors/ConnectorIcon";
import { openTemplatesAfterAbout } from "../../right-hand/FirstRun";
import { useFailed } from "../../routines/hooks";
import { SettingsPage } from "../../settings/parts";
import { useColors, useDirectory } from "../../shared/hooks";
import { goBack, PushedHeader, successHaptic, tapHaptic } from "../../shared/parts";
import { TextArea } from "../../shared/TextArea";

/*
 * The screens behind the right hand's first-run rows (ADR 0155 §6), the web's dialogs on the phone: its apps row and,
 * in a personal workspace (ADR 0159), row 1 about the person (areas of life). Its AI row opens Connect AI, its people
 * row the invite screen.
 */

const STEPS: readonly SetupStep[] = ["apps", "about"];

/** Opens a row's screen; `text` fills row 1's sentence. */
export const openSetupStep = (agentId: string, step: SetupStep, text?: string | null) =>
  router.push({
    pathname: "/agent-step/[id]",
    params: { id: agentId, step, ...(text ? { text: text.slice(0, 500) } : {}) },
  });

export function SetupStepScreen({
  agentId,
  step,
  text,
}: {
  agentId: string;
  step: string | undefined;
  text?: string | undefined;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  const known = STEPS.find((s) => s === step);
  // Its apps row has a screen, and in a personal workspace (ADR 0159) row 1, what the person wants help with.
  const firstRunScreen = known === "apps" || (known === "about" && isPersonal(org));
  if (!agent?.setup || !isRightHand(agent) || !firstRunScreen) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t(modeKey(org, "agentSetup.firstRun.apps.title"))} solid={false} />
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </View>
    );
  }
  if (known === "about") return <AboutYouStep typed={text ?? null} />;
  return <FirstRunAppsStep />;
}

/**
 * A personal workspace's row 1 (ADR 0159), as the web's dialog: "What do you want help with?", the areas of life to
 * pick, several at once, and one optional sentence about the person; saved as the workspace's context
 * (`aboutYouContext`), which every agent reads, and read back into the same answers when opened again (`readAboutYou`:
 * what was saved, else what was typed or tapped on the card). "Something else" asks for the sentence. Saved, it goes
 * back and the card opens the agents' templates with the first area's picked.
 */
function AboutYouStep({ typed }: { typed: string | null }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const settings = useSettings(orgId);
  const save = useUpdateSettings(orgId);
  const failed = useFailed();
  // What it starts from, until the person changes the areas or the sentence.
  const start = readAboutYou(t, settings.data?.context || typed || "");
  const [areas, setAreas] = useState<ReadonlySet<LifeArea> | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const picked = areas ?? new Set(start.areas);
  const shown = line ?? start.line;
  const other = picked.has("other");
  const text = aboutYouContext(t, picked, shown);
  const toggle = (area: LifeArea) => {
    tapHaptic();
    setAreas((now) => {
      const next = new Set(now ?? start.areas);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  };
  return (
    <SettingsPage
      title={t("agentSetup.firstRun.about.titlePersonal")}
      locked={save.isPending}
      action={{
        label: t("common.save"),
        disabled: !text || save.isPending || !settings.isSuccess,
        onPress: () =>
          save.mutate(
            { context: text },
            {
              onSuccess: () => {
                successHaptic();
                goBack();
                openTemplatesAfterAbout(lifeAreaTemplate(picked) ?? undefined);
              },
              onError: failed,
            },
          ),
      }}
    >
      <GroupedFooter>{t("agentSetup.firstRun.about.descPersonal")}</GroupedFooter>
      <GroupedList>
        {LIFE_AREAS.map((area) => (
          <GroupedRow
            key={area}
            label={t(`teamPlan.lifeArea.${area}`)}
            checked={picked.has(area)}
            disabled={save.isPending}
            onPress={() => toggle(area)}
          />
        ))}
      </GroupedList>
      <GroupedHeader
        {...(other
          ? {}
          : {
              hint: {
                name: t("common.about", { label: t("agentSetup.firstRun.about.linePersonal") }),
                text: t("agentSetup.firstRun.about.optionalPersonal"),
              },
            })}
      >
        {t("agentSetup.firstRun.about.linePersonal")}
      </GroupedHeader>
      <TextArea
        value={shown}
        onChangeText={setLine}
        accessibilityLabel={t("agentSetup.firstRun.about.linePersonal")}
        minHeight={88}
        scrollEnabled={false}
        editable={!save.isPending}
      />
    </SettingsPage>
  );
}

/**
 * The first run's apps row, as the web's dialog: the apps the team just made would use, plug-and-play ones only, each
 * opening the same connect sheet as Apps (whose last step says which agents use it), and the whole list under them.
 */
function FirstRunAppsStep() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
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
    <SettingsPage title={t(modeKey(org, "agentSetup.firstRun.apps.title"))}>
      <GroupedFooter>{t(modeKey(org, "agentSetup.firstRun.apps.desc"))}</GroupedFooter>
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
