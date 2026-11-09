import { Tabs as RTabs } from "radix-ui";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  /** Shown after the label in tabular numbers. */
  count?: number;
}

/**
 * The tabs that leave a row `room` wide, taken from its end until the rest fit (gaps between them included), never
 * `keep` (the chosen one). By index, in their order.
 */
export function overflowOf(widths: readonly number[], gap: number, room: number, keep: number): number[] {
  const out: number[] = [];
  let used = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
  for (let i = widths.length - 1; i >= 0 && used > room + 0.5; i--) {
    if (i === keep) continue;
    used -= (widths[i] ?? 0) + gap;
    out.unshift(i);
  }
  return out;
}

/**
 * Tabs (Radix: arrow keys between tabs, `tablist`/`tab`/`tabpanel`). `segmented`: the tabs look like the
 * Segmented control (a track, the raised pill slides under the chosen tab), e.g. under the agent's card.
 */
export function Tabs<V extends string>({
  value,
  onValueChange,
  items,
  label,
  variant = "line",
  after,
  children,
}: {
  value: V;
  onValueChange: (value: V) => void;
  items: TabItem<V>[];
  label: string;
  variant?: "line" | "segmented";
  /**
   * At the end of the list, after the tabs: the menu of the tabs that don't fit ("More"). The tabs past the list's
   * width leave the row (the chosen one never does) and come in `overflow`, in their order, for the menu to hold.
   */
  after?: (overflow: V[]) => ReactNode;
  children: ReactNode;
}) {
  const seg = variant === "segmented";
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLSpanElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  const [overflow, setOverflow] = useState<V[]>([]);
  const index = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );
  // As in Segmented: measured after every render, and again when the chosen tab resizes (a badge arriving).
  useLayoutEffect(() => {
    if (!seg) return;
    const el = refs.current[index];
    if (!el) return;
    const measure = () =>
      setPill((p) =>
        p && p.x === el.offsetLeft && p.w === el.offsetWidth ? p : { x: el.offsetLeft, w: el.offsetWidth },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  // What fits beside the menu: after every render (a label's badge changes its width), and as the list or a tab
  // resizes (the window, the app's font arriving). A tab that left is still laid out, out of the row, so its width is
  // known when room comes back.
  useLayoutEffect(() => {
    const el = list.current;
    if (seg || !after || !el) return;
    const measure = () => {
      const s = getComputedStyle(el);
      const gap = Number.parseFloat(s.columnGap) || 0;
      const menu = end.current?.offsetWidth ?? 0;
      const room = el.clientWidth - Number.parseFloat(s.paddingLeft || "0") - Number.parseFloat(s.paddingRight || "0");
      const widths = items.map((_, i) => refs.current[i]?.offsetWidth ?? 0);
      const out = overflowOf(widths, gap, room - (menu ? menu + gap : 0), index).flatMap((i) => items[i]?.value ?? []);
      setOverflow((o) => (o.join() === out.join() ? o : out));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const box of [el, end.current, ...refs.current]) if (box) ro.observe(box);
    return () => ro.disconnect();
  });
  return (
    <RTabs.Root value={value} onValueChange={(v) => onValueChange(v as V)} style={{ display: "contents" }}>
      <RTabs.List ref={list} className={seg ? "ac-seg ac-tabs--seg" : "ac-tabs"} aria-label={label}>
        {seg && pill && (
          <span
            className="ac-seg__pill"
            aria-hidden="true"
            style={{ "--x": `${pill.x}px`, "--w": `${pill.w}px` } as CSSProperties}
          />
        )}
        {items.map((item, i) => (
          <RTabs.Trigger
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={item.value}
            className={seg ? "ac-seg__item" : "ac-tab"}
            data-on={(seg && item.value === value) || undefined}
            data-overflow={(!seg && overflow.includes(item.value)) || undefined}
          >
            {item.label}
            {item.count !== undefined && (
              <>
                {" "}
                <span className="ac-tab__count">{item.count}</span>
              </>
            )}
          </RTabs.Trigger>
        ))}
        {after && (
          <span ref={end} className="ac-tabs__end">
            {after(seg ? [] : overflow)}
          </span>
        )}
      </RTabs.List>
      {children}
    </RTabs.Root>
  );
}

/** Its layout is in the stylesheet: an inline `display` would beat the `hidden` Radix puts on an inactive panel. */
export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RTabs.Content value={value} className="ac-tabpanel">
      {children}
    </RTabs.Content>
  );
}
