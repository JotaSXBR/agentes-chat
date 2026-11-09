import type { Agent, AgentAudience, ForeignMailbox } from "@agenteschat/client";
import { useSetAudiences } from "@agenteschat/client";
import { audiencePatch, opensOthersPlan, severalWidenQuestion, widenQuestion } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogBody, DialogFooter, Locked } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * Equipe's selection: one "Quem pode falar" for every agent picked, the agent page's choice for them all. What it
 * would open (someone else's plan, mailboxes other people gave one of them) is asked once, in place, before the save.
 */
export function BulkAudienceDialog({
  agents,
  onClose,
  onSaved,
}: {
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const save = useSetAudiences(org.id);
  const [draft, setDraft] = useState<AgentAudience>({ mode: "everyone", userIds: [], roleIds: [] });
  const [asking, setAsking] = useState<{ title: string; description: string; answer: (yes: boolean) => void } | null>(
    null,
  );
  const ownerless = agents.some((a) => !a.ownerUserId);
  const picked = draft.userIds.length + (draft.roleIds?.length ?? 0);
  // "Só o responsável", or nobody picked, would leave one with no owner answering nobody.
  const valid = draft.mode === "everyone" || (draft.mode === "owner" ? !ownerless : picked > 0 || !ownerless);
  const next = audiencePatch(draft);
  // Each agent's own question (`widenQuestion`), said once for all of them.
  const ask = (losses: { agentId: string; mailboxes: ForeignMailbox[] }[]) => {
    const questions = losses.flatMap(({ agentId, mailboxes }) => {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) return [];
      const owner = opensOthersPlan(agent, next, me.user.id)
        ? (dir.memberById.get(agent.ownerUserId ?? "")?.name ?? t("channel.unknownPerson"))
        : null;
      return widenQuestion(t, agent, owner, mailboxes) ?? [];
    });
    const question = severalWidenQuestion(t, questions, agents.length);
    if (!question) return Promise.resolve(true);
    return new Promise<boolean>((answer) => setAsking({ ...question, answer }));
  };
  const answer = (yes: boolean) => {
    asking?.answer(yes);
    setAsking(null);
  };
  const submit = () =>
    save.mutate(
      { agents, audience: next, ask },
      {
        onSuccess: (out) => {
          if (!out) return;
          const done = agents.length - out.failed.length;
          if (done > 0) toast.show(t("audience.several.saved", { count: done }), "success");
          if (out.failed.length > 0) toast.show(t("audience.several.failed", { count: out.failed.length }), "error");
          onSaved();
        },
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && (asking ? answer(false) : onClose())}
      title={asking ? asking.title : t("audience.several.title", { count: agents.length })}
      description={asking?.description}
      closeLabel={t("common.close")}
      width={asking ? 440 : 600}
    >
      {asking ? (
        <DialogFooter>
          <Button onClick={() => answer(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => answer(true)}>
            {t("common.continue")}
          </Button>
        </DialogFooter>
      ) : (
        <>
          <DialogBody>
            <Locked when={save.isPending}>
              <AudienceChoice
                compact
                layout="rows"
                value={draft}
                onChange={setDraft}
                ownerUserId={null}
                agentName=""
                idPrefix="team-audience"
                several={{ count: agents.length, ownerless }}
              />
            </Locked>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose} disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
