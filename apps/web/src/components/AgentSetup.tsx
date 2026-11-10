import { Button, gradientOf, Icon, type IconName } from "@agenteschat/ui";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./agent-setup.css";

/*
 * The setup card's drawing (ADR 0155 §6, ADR 0162): the right hand's first run inside its greeting, the one setup
 * checklist. Other agents have none: one that needs something asks for it in the conversation, when it does.
 */

/** One row of a checklist card, as drawn: its button, a second one ("Agora não"), or a link once done. */
export interface SetupCardRow {
  key: string;
  icon: IconName;
  done: boolean;
  title: string;
  desc?: string | undefined;
  /** Its line just after it was done, in the agent's voice. */
  saying?: string | null;
  /** Its button (a link once done); none: nothing to press for this person, or the row waits (`dim`). */
  action?: { label: string; primary?: boolean; onClick: () => void };
  skip?: { label: string; onClick: () => void; busy?: boolean };
  /** It waits for something else (the plan): drawn quieter, with no button. */
  dim?: boolean;
  /** What the row asks for in place (an address to invite), at its full width under its text. */
  form?: ReactNode;
}

/** The card: the head and its count, the segmented bar, the rows, a foot of asks. The data and dialogs are its user's. */
export function SetupCardView({
  title,
  done,
  total,
  rows,
  foot,
  burstRef,
  children,
}: {
  title: string;
  done: number;
  total: number;
  rows: SetupCardRow[];
  foot?: ReactNode;
  burstRef?: RefObject<HTMLCanvasElement | null>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="setup-cl" aria-label={title}>
      <canvas ref={burstRef} className="setup-cl__burst" aria-hidden="true" tabIndex={-1} />
      <div className="setup-cl__head">
        <b>{title}</b>
        <small>{t("agentSetup.count", { done, total })}</small>
      </div>
      <div className="setup-cl__meter" aria-hidden="true">
        {rows.map((r, i) => (
          <i key={r.key} data-on={i < done || undefined} />
        ))}
      </div>
      <ul className="setup-cl__rows" aria-live="polite">
        {rows.map((r) => (
          <li
            key={r.key}
            className="setup-row ac-mediarow ac-mediarow--row"
            data-done={r.done || undefined}
            data-new={r.saying ? true : undefined}
            data-dim={r.dim || undefined}
          >
            <span className="ac-mediarow__face">
              {r.done ? (
                <span className="setup-row__check">
                  <Icon name="check" size={14} />
                </span>
              ) : (
                <Icon name={r.icon} size={20} />
              )}
            </span>
            <span className="ac-mediarow__head">
              <b className="setup-row__title">{r.title}</b>
              {r.done && r.action && (
                <button type="button" className="setup-row__link" onClick={r.action.onClick}>
                  {r.action.label}
                </button>
              )}
            </span>
            {(r.saying || (!r.done && r.desc)) && (
              <span className="ac-mediarow__body setup-row__text">
                {r.saying ? <span className="setup-row__say">{r.saying}</span> : <span>{r.desc}</span>}
              </span>
            )}
            {!r.done && r.form && <span className="ac-mediarow__body setup-row__form">{r.form}</span>}
            {!r.done && (r.action || r.skip) && (
              <span className="ac-mediarow__end ac-mediarow__end--wrap setup-row__act">
                {r.skip && (
                  <Button size="sm" variant="ghost" disabled={r.skip.busy} onClick={r.skip.onClick}>
                    {r.skip.label}
                  </Button>
                )}
                {r.action && (
                  <Button
                    size="sm"
                    variant={r.action.primary ? "primary" : undefined}
                    disabled={r.skip?.busy}
                    onClick={r.action.onClick}
                  >
                    {r.action.label}
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {foot}
      {children}
    </section>
  );
}

/** The card's foot: a lead, then asks to press, each sent as written. */
export function SetupAsks({ lead, asks }: { lead: string; asks: { label: string; onClick: () => void }[] }) {
  return (
    <div className="setup-cl__foot">
      <b>{lead}</b>
      <div className="setup-cl__tasks">
        {asks.map((a) => (
          <button key={a.label} type="button" className="setup-task ac-iconline" onClick={a.onClick}>
            <Icon name="message" size={16} />
            <span>{a.label}</span>
            <Icon name="arrowRight" size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A step done while the card is in view (after everything it reads has loaded): its line for a moment, and a burst of
 * pixels in the agent's colors, a bigger one when it was the last. `celebrates`: whether its line comes with the burst
 * (an invitation only sent says so, quietly).
 */
export function useDoneSay<S extends string>(
  ready: boolean,
  doneNow: readonly S[],
  total: number,
  color: string | undefined,
  burstRef: RefObject<HTMLCanvasElement | null>,
  sayOf: (step: S) => string,
  celebrates: (step: S) => boolean = () => true,
) {
  const [said, setSaid] = useState<{ step: S; text: string } | null>(null);
  const seen = useRef<Set<S> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useRef(sayOf);
  say.current = sayOf;
  const party = useRef(celebrates);
  party.current = celebrates;
  const doneKey = doneNow.join();
  useEffect(() => {
    if (!ready) return;
    const now = new Set(doneKey ? (doneKey.split(",") as S[]) : []);
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const fresh = [...now].find((s) => !before.has(s));
    const text = fresh ? say.current(fresh) : "";
    if (!fresh || !text) return;
    setSaid({ step: fresh, text });
    if (party.current(fresh)) burst(burstRef.current, color, now.size === total);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 2600);
  }, [ready, doneKey, total, color, burstRef]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return said;
}

/** A few pixels in the agent's colors burst from the card when a step is done (none with reduced motion). */
function burst(cv: HTMLCanvasElement | null, color: string | undefined, big: boolean) {
  if (!cv || typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = cv.getBoundingClientRect();
  const W = Math.round(r.width / 3);
  const H = Math.round(r.height / 3);
  const g = cv.getContext("2d");
  if (!W || !H || !g) return;
  cv.width = W;
  cv.height = H;
  const [top, bottom] = gradientOf(color);
  const tones = [top, bottom, "#ffffff", "#ffd36b"];
  const ps = Array.from({ length: big ? 90 : 34 }, () => ({
    x: W / 2,
    y: H * 0.62,
    vx: (Math.random() - 0.5) * (big ? 3.2 : 2.2),
    vy: -Math.random() * (big ? 3.4 : 2.4) - 0.6,
    c: tones[Math.floor(Math.random() * tones.length)] ?? top,
    s: Math.random() < 0.3 ? 2 : 1,
  }));
  let frame = 0;
  const step = () => {
    if (!cv.isConnected) return;
    g.clearRect(0, 0, W, H);
    frame++;
    for (const p of ps) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.09;
      g.fillStyle = p.c;
      g.globalAlpha = Math.max(0, 1 - frame / 70);
      g.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
    }
    if (frame < 70) requestAnimationFrame(step);
    else g.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(step);
}
