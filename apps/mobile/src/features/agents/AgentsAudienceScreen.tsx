import type { AgentAudience, AudienceMode, ForeignMailbox } from "@agenteschat/client";
import { useRoles, useSetAudiences } from "@agenteschat/client";
import {
  audiencePatch,
  canEditAudience,
  opensOthersPlan,
  severalWidenQuestion,
  widenQuestion,
} from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { confirmQuestion } from "../chat/ReachLines";
import { SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { errorHaptic, goBack, successHaptic, tapHaptic } from "../shared/parts";

const MODES: AudienceMode[] = ["everyone", "people", "owner"];

/**
 * "Quem pode falar" for several agents at once, the web's Equipe selection: the agents I may change, each ticked, then
 * one choice for all of them, saved as each one's own. What it would open (someone else's plan, mailboxes other people
 * gave one of them) is asked once before the save.
 */
export function AgentsAudienceScreen() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const roles = useRoles(orgId);
  const save = useSetAudiences(orgId);
  const toast = useToast();
  const mine = dir.agents.filter(
    (a) => !isRightHand(a) && !a.former && meId && canEditAudience(org ?? undefined, a, meId),
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [audience, setAudience] = useState<AgentAudience>({ mode: "everyone", userIds: [], roleIds: [] });
  const chosen = mine.filter((a) => picked.has(a.id));
  const ownerless = chosen.some((a) => !a.ownerUserId);
  const pickedPeople = new Set(audience.userIds);
  const pickedRoles = new Set(audience.roleIds ?? []);
  const count = pickedPeople.size + pickedRoles.size;
  // "Só o responsável", or nobody picked, would leave one with no owner answering nobody.
  const valid = audience.mode === "everyone" || (audience.mode === "owner" ? !ownerless : count > 0 || !ownerless);
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const people = [...dir.memberById.values()];
  const all = mine.length > 0 && chosen.length === mine.length;
  const flipAgent = (id: string) => {
    tapHaptic();
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const flip = (kind: "userIds" | "roleIds", id: string) => {
    tapHaptic();
    setAudience((a) => {
      const list = a[kind] ?? [];
      return { ...a, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  };
  const next = audiencePatch(audience);
  const ask = (losses: { agentId: string; mailboxes: ForeignMailbox[] }[]) =>
    confirmQuestion(
      t,
      severalWidenQuestion(
        t,
        losses.flatMap(({ agentId, mailboxes }) => {
          const agent = chosen.find((a) => a.id === agentId);
          if (!agent) return [];
          const owner =
            meId && opensOthersPlan(agent, next, meId)
              ? (dir.memberById.get(agent.ownerUserId ?? "")?.name ?? t("channel.unknownPerson"))
              : null;
          return widenQuestion(t, agent, owner, mailboxes) ?? [];
        }),
        chosen.length,
      ),
    );
  const submit = () =>
    save.mutate(
      { agents: chosen, audience: next, ask },
      {
        onSuccess: (out) => {
          if (!out) return;
          const done = chosen.length - out.failed.length;
          if (out.failed.length > 0) {
            errorHaptic();
            toast({ title: t("audience.several.failed", { count: out.failed.length }), icon: "x" });
          }
          if (done === 0) return;
          successHaptic();
          toast({ title: t("audience.several.saved", { count: done }), icon: "check" });
          goBack();
        },
        onError: () => {
          errorHaptic();
          toast({ title: t("agentPage.work.failed"), icon: "x" });
        },
      },
    );
  return (
    <SettingsPage
      title={t("audience.section")}
      action={{
        label: t("common.save"),
        onPress: submit,
        disabled: save.isPending || chosen.length === 0 || !valid,
      }}
      locked={save.isPending}
    >
      <GroupedHeader>{t("team.list.agents")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("team.list.pickAll")}
          checked={all}
          onPress={() => {
            tapHaptic();
            setPicked(all ? new Set() : new Set(mine.map((a) => a.id)));
          }}
        />
        {mine.map((a) => (
          <GroupedRow
            key={a.id}
            leading={<AgentFace agentId={a.id} size={30} live={false} />}
            label={a.name}
            checked={picked.has(a.id)}
            onPress={() => flipAgent(a.id)}
          />
        ))}
      </GroupedList>
      <GroupedHeader>{t("audience.several.title", { count: chosen.length })}</GroupedHeader>
      <GroupedList>
        {MODES.map((mode) => (
          <GroupedRow
            key={mode}
            label={t(`audience.mode.${mode}`)}
            sub={
              mode === "owner" && ownerless ? t("audience.modeText.noOwner") : t(`audience.several.modeText.${mode}`)
            }
            subLines={2}
            checked={audience.mode === mode}
            disabled={mode === "owner" && ownerless}
            onPress={() => {
              tapHaptic();
              setAudience((a) => ({ ...a, mode }));
            }}
          />
        ))}
      </GroupedList>
      {valid ? null : <GroupedFooter>{t("audience.pickSomeone")}</GroupedFooter>}
      {audience.mode === "people" ? (
        <>
          <GroupedHeader>{t("agentSetup.who.people")}</GroupedHeader>
          <GroupedList>
            {roleList.map((r) => (
              <GroupedRow
                key={r.id}
                icon="members"
                label={r.name}
                checked={pickedRoles.has(r.id)}
                onPress={() => flip("roleIds", r.id)}
              />
            ))}
            {people.map((m) => (
              <GroupedRow
                key={m.userId}
                icon="person"
                label={m.name}
                checked={pickedPeople.has(m.userId)}
                onPress={() => flip("userIds", m.userId)}
              />
            ))}
          </GroupedList>
          {ownerless ? null : <GroupedFooter>{t("audience.several.ownerAlways")}</GroupedFooter>}
        </>
      ) : null}
    </SettingsPage>
  );
}
