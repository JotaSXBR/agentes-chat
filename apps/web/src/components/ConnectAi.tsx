import type { ConnectIntent } from "@agenteschat/client";
import { useAgentDetail, useAiStatus, useApi } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import {
  type AiChoice,
  aiStateOf,
  choiceOfIntent,
  gateDims,
  mayConnectAi,
  type PlanChoice,
  planMark,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { Button, Dialog, DialogBody, DialogFooter, Icon, ProviderLogo, Spinner } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentAiForm, type AiAgent, type AiStart, LoneAiFlow, TeamAi } from "@/components/ai/AgentAi";
import { PlanHold, useGatesWithoutAgent, usePlanGates, usePlanHold } from "@/components/ai/ConnectAiSteps";
import { ConnectChoices } from "@/components/arrival/ConnectChoices";
import { sceneTeam, TeamScene, useDawn } from "@/components/arrival/TeamScene";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./no-ai.css";

/*
 * "Conectar uma IA" (ADR 0061): one dialog for every place that says an agent has no AI (the banner, the agent's
 * card, the receipt under a message, its "Sem IA" chip, Settings › Contas de IA). For one agent, the AI select of its
 * page (`AgentAiForm`), each pick saved at once; for several, who it's for and the same select; for someone with no
 * agent, the steps alone. A message or card that named a plan or a key opens on its steps. Connected from a card or a
 * message, the agent then answers it by itself.
 */

export interface ConnectAiRequest {
  /** The step the message asked for (Jev); `any`, `task` or none: the first step. */
  intent?: ConnectIntent;
  /** The plan it opens on, over `intent`: a card's Sign in again, on the agent's own plan (a coding plan's too). */
  plan?: PlanChoice;
  /** With `api_key`: the provider it named. */
  provider?: string;
  /** The agent to connect: the dialog is for it alone. */
  agentId?: string;
  /** The agents to choose from (an agent's card names them); `agentId` is chosen first. */
  agentIds?: string[];
  /** The no-AI card or the person's message: once connected, it is answered ("Responder agora"). */
  from?: string;
  /** A key pasted in the composer. */
  apiKey?: string;
  /** Opened by itself (Jev), not by a click: never over a dialog already open. */
  auto?: boolean;
  /** Opened because the workspace's computer just got ready (its email, its notification): a plan's panel says so. */
  ready?: boolean;
  /**
   * Opened from the create-agent step for an agent of the person's own still being made: a plan signs in for the
   * agents they create (as with no agent yet), never for one they have, and a computer opens in a new tab (the draft
   * stays).
   */
  forNewAgent?: boolean;
  /**
   * Opened right after the onboarding (ADR 0160): the team stands asleep beside the choices, which are cards in
   * words, and wakes as the sky turns to day once an AI is connected. The plans' own steps are the same.
   */
  arrival?: boolean;
}

/** How "Responder agora" went for a message, in this tab. */
export type AnswerState = "pending" | "answering" | "still_missing";

export interface ConnectAi {
  open(request: ConnectAiRequest): void;
  /** "Responder agora" (`from`: the no-AI card or the person's message). */
  answer(from: string): Promise<void>;
  answered: Record<string, AnswerState>;
}

const ConnectAiContext = createContext<ConnectAi | null>(null);

/** Null outside the workspace shell (an isolated page in a test): no Connect there. */
export const useConnectAi = () => useContext(ConnectAiContext);

/**
 * Whether this person has an AI to connect: the workspace's key, a plan for an agent they have or may make, or their
 * own for the right hand. Yes until the agents are known, so nobody reads "who connects it" for a moment.
 */
export function useMayConnectAi() {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  return (
    dir.loading ||
    stepPermissions(org, me.user.id, dir.agents).connectAi ||
    can(org, "create_agents") ||
    mayConnectAi(rightHandOf(dir.agents), me.user.id, org)
  );
}

export function ConnectAiProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  // Each opening is its own dialog (`n`): what was chosen in another one doesn't carry over.
  const [request, setRequest] = useState<(ConnectAiRequest & { n: number }) | null>(null);
  const [answered, setAnswered] = useState<Record<string, AnswerState>>({});
  const open = useCallback((next: ConnectAiRequest) => {
    setRequest((current) => (current && next.auto ? current : { ...next, n: (current?.n ?? 0) + 1 }));
  }, []);
  // A link that asks for it (the computer ready email's "Connect your AI"): open once, then drop it from the address.
  const [asked, clearAsked] = useOpenParam("connect");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked !== "ai") return;
    open({ ready: true });
    clearAsked(null);
  }, [asked]);
  const answer = useCallback(
    async (from: string) => {
      setAnswered((a) => ({ ...a, [from]: "pending" }));
      try {
        await api.chat.answerNow(org.id, from);
        setAnswered((a) => ({ ...a, [from]: "answering" }));
      } catch (error) {
        const missing = errorCode(error) === "ai.still_missing";
        setAnswered((a) => {
          const { [from]: _pending, ...rest } = a;
          return missing ? { ...rest, [from]: "still_missing" } : rest;
        });
        if (!missing) toast.show(errorText(t, error), "error");
      }
    },
    [api, org.id, toast, t],
  );
  const value = useMemo(() => ({ open, answer, answered }), [open, answer, answered]);
  return (
    <ConnectAiContext.Provider value={value}>
      {children}
      {request && (
        <ConnectAiDialog
          key={request.n}
          request={request}
          onClose={() => setRequest(null)}
          onConnected={() => {
            if (request.from) void answer(request.from);
          }}
        />
      )}
    </ConnectAiContext.Provider>
  );
}

/** A chosen plan's steps, named as its maker sells it; the key's, as the picker names it. */
const stepTitle = (t: TFunction, choice: AiChoice) =>
  choice === "key" ? t("connectAi.title.api_key") : planTitle(t, choice);

function ConnectAiDialog({
  request,
  onClose,
  onConnected,
}: {
  request: ConnectAiRequest;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const hold = usePlanHold();
  // The team's right hand thinks with each person's own AI (ADR 0137 §11): everyone's to connect for their DM.
  const mine = dir.agents.filter((a) => a.ownerUserId === me.user.id || isRightHand(a));
  // An agent's card names whom it's for; opened for one agent, it is for that agent alone.
  const named = request.agentIds?.length ? request.agentIds : null;
  const only = named ? (named.length === 1 ? named[0] : undefined) : request.agentId;
  const one = only ? dir.agentById.get(only) : undefined;
  const pool = request.forNewAgent ? [] : one ? [one.id] : named;
  // Of theirs, those that still have no AI (by the AI status, as its "Sem IA" chip); one asked for, whatever it has.
  // With every one of theirs thinking already: their one agent, else none, since a new AI moving them all would be a
  // surprise (it is added, for each agent's select, as for someone with no agent).
  const noAi = (id: string) => (aiStateOf(status.data, id) ?? "no_ai") === "no_ai";
  const own = mine.filter((a) => !isRightHand(a));
  const withoutAi = mine.filter((a) => noAi(a.id));
  // Named ones in the order they were named.
  const found = (
    pool
      ? pool.flatMap((id) => dir.agentById.get(id) ?? [])
      : withoutAi.length > 0
        ? withoutAi
        : own.length === 1
          ? own
          : []
  ).filter((a) => one || mine.includes(a));
  // Held from the moment they're known: agents getting an AI here, one by one, don't change whom it's for midway.
  const [held, setHeld] = useState<string[] | null>(null);
  const ready = !dir.loading && !status.isPending;
  useEffect(() => {
    if (ready && held === null) setHeld(found.map((a) => a.id));
  }, [ready, held, found]);
  const agents = held ? held.flatMap((id) => dir.agentById.get(id) ?? []) : found;
  const detail = useAgentDetail(org.id, one?.id ?? agents[0]?.id ?? "");
  // A plan or a key the message or card named, a key pasted in the composer, or the computer just got ready.
  const asked = request.plan ?? choiceOfIntent(request.intent);
  const start: AiStart = {
    ...(asked && asked !== "key" ? { plan: asked } : {}),
    ...(asked === "key" || request.apiKey ? { key: true } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.ready ? { ready: true } : {}),
    // Not opened for an agent (Settings, the banner): a new AI to connect, its providers at once.
    ...(only ? {} : { other: true }),
  };
  const asAi = (a: (typeof dir.agents)[number]): AiAgent => ({
    id: a.id,
    name: a.name,
    ownerUserId: a.ownerUserId,
    model: detail.data?.id === a.id ? detail.data.model : a.model,
    key: detail.data?.id === a.id ? detail.data.credentialId : null,
  });
  const single = one ?? (agents.length === 1 ? agents[0] : undefined);
  // Over Criar agente a computer connects in a new tab, so the draft stays; anywhere else the dialog makes way for it.
  const toComputers = () => {
    if (request.forNewAgent) {
      window.open(`/org/${org.id}/settings/devices`, "_blank", "noopener");
      return;
    }
    onClose();
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "devices" } });
  };
  const keyFirst =
    !request.plan &&
    !request.forNewAgent &&
    own.length === 0 &&
    dir.agents.length > 0 &&
    can(org, "manage_credentials");
  // One agent's AI select, several agents' at once, or the steps alone for someone with no agent.
  const flow = (from: AiStart, onThinks: () => void) =>
    single ? (
      <AgentAiForm agent={asAi(single)} mode="connect" start={from} onThinks={onThinks} onComputer={toComputers} />
    ) : agents.length > 1 ? (
      <TeamAi agents={agents.map(asAi)} start={from} onThinks={onThinks} onComputer={toComputers} />
    ) : (
      <LoneAiFlow start={from} onDone={onThinks} onComputer={toComputers} />
    );
  // The arrival's stage: never over a billing hold, whose notice is the whole dialog.
  const stage = request.arrival === true && !hold;
  // Its first screen is the cards; a pick moves on to that plan's steps, and Back returns to the cards.
  const [chosen, setChosen] = useState<AiChoice | null>(null);
  const [connected, setConnected] = useState(false);
  const day = useDawn(stage && connected);
  // A plan that can't sign in now dims on its card; its steps say why.
  const gates = usePlanGates(org.id, stage ? agents[0]?.id : undefined);
  const bareGates = useGatesWithoutAgent(org.id, stage && agents.length === 0);
  if (stage) {
    const lead = rightHandOf(dir.agents);
    const stepping = chosen !== null && !connected;
    const without = (
      <span className="ac-iconline">
        <Icon name="info" />
        <span>{t("arrival.connect.without")}</span>
      </span>
    );
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={chosen ? stepTitle(t, chosen) : t("arrival.connect.title")}
        closeLabel={t("common.close")}
        width={820}
        bare
        className="arrival arrival-connect"
      >
        <div className="arrival-stage">
          <TeamScene
            shape="tall"
            quiet={0.22}
            agents={sceneTeam(dir.agents, lead)}
            lead={lead?.id}
            asleep={!connected}
            day={day}
            expression={connected ? "happy" : undefined}
          >
            {chosen && (
              <>
                <span className="team-scene__trail" data-state={connected ? "done" : "walk"}>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <i key={n} style={{ "--n": n } as CSSProperties} />
                  ))}
                </span>
                <span className="team-scene__mark">
                  {chosen === "key" ? <Icon name="key" /> : <ProviderLogo id={planMark(chosen)} size="tile" />}
                </span>
              </>
            )}
          </TeamScene>
          <div className="arrival-stage__cap">
            <b>{t(connected ? "arrival.stage.morning" : "arrival.stage.ready")}</b>
            <span>{t(connected ? "arrival.stage.awake" : "arrival.stage.wake")}</span>
          </div>
        </div>
        <div className="arrival-main">
          {/* The kit's dialog head (Dialog.tsx), in the column beside the stage. */}
          <div className="ac-dialog__head">
            {stepping && (
              <span className="ac-dialog__lead">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="chevronLeft"
                  aria-label={t("common.back")}
                  onClick={() => setChosen(null)}
                />
              </span>
            )}
            <div className="ac-actline">
              <span className="ac-dialog__title" aria-hidden="true">
                {chosen ? stepTitle(t, chosen) : t("arrival.connect.title")}
              </span>
            </div>
            <span className="ac-dialog__close ac-acts">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                className="ac-btn--glyph"
                aria-label={t("common.close")}
                onClick={onClose}
              />
            </span>
          </div>
          {!chosen && <p className="ac-dialog__desc">{t("arrival.connect.text")}</p>}
          <DialogBody>
            {!ready ? (
              <Spinner />
            ) : chosen ? (
              <div className="arrival-main__steps">
                {flow(chosen === "key" ? { key: true } : { plan: chosen }, () => {
                  setConnected(true);
                  onConnected();
                })}
              </div>
            ) : (
              <ConnectChoices
                mayAddKey={can(org, "manage_credentials")}
                dims={(c) => gateDims(agents.length > 0 ? gates.gateOf(c) : bareGates.at(c).gate)}
                onPick={setChosen}
              />
            )}
          </DialogBody>
          {connected ? (
            <DialogFooter>
              <Button variant="primary" onClick={onClose}>
                {t("connectAi.done")}
              </Button>
            </DialogFooter>
          ) : (
            !chosen && (
              <DialogFooter note={without}>
                <Button variant="ghost" onClick={onClose}>
                  {t("arrival.connect.later")}
                </Button>
              </DialogFooter>
            )
          )}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={one ? t("connectAi.titleFor", agentGrammar(one.name)) : t("connectAi.title.any")}
      closeLabel={t("common.close")}
      width={560}
      className="agp-wdlg"
    >
      <DialogBody>
        {hold ? (
          // Every way in lands here, a card's or a key pasted in the composer: nothing connects before the plan.
          <PlanHold hold={hold} />
        ) : dir.loading || status.isPending ? (
          <Spinner />
        ) : (
          // No agent of theirs without an AI: a plan signs in for the agents they create. An admin among other
          // people's agents starts on the workspace's key, which serves every agent with no plan.
          flow(!single && agents.length === 0 && keyFirst ? { ...start, key: true } : start, onConnected)
        )}
      </DialogBody>
    </Dialog>
  );
}
