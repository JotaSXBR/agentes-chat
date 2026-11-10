import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Card, Icon, type IconName, MEDIA_ROW, MediaRow, Text } from "@/ui";
import { useColors } from "../../shared/hooks";
import { successHaptic } from "../../shared/parts";

/*
 * The setup card's drawing on the phone (ADR 0155 §6, ADR 0162), as on the web: the right hand's first run inside its
 * greeting, the one setup checklist. Other agents have none: one that needs something asks for it in the conversation.
 */

/** One row of a checklist card, as drawn: its button (a text button once done), "Agora não", or words alone. */
export interface SetupCardRow {
  key: string;
  icon: IconName;
  done: boolean;
  title: string;
  desc?: string | undefined;
  saying?: string | null;
  action?: { label: string; primary?: boolean; onPress: () => void };
  skip?: { label: string; onPress: () => void; busy?: boolean };
  /** It waits for something else (the plan): quieter, with no button. */
  dim?: boolean;
}

/** The card: the head and its count, the segmented bar, the rows, a foot of asks. */
export function SetupCardView({
  title,
  done,
  total,
  rows,
  foot,
}: {
  title: string;
  done: number;
  total: number;
  rows: SetupCardRow[];
  foot?: ReactNode;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <Card style={styles.card}>
      <View style={styles.inner} accessibilityLabel={title}>
        <View style={styles.cardHead}>
          <Text variant="subhead" style={[styles.bold, styles.fill]} accessibilityRole="header">
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {t("agentSetup.count", { done, total })}
          </Text>
        </View>
        <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {rows.map((r, i) => (
            <View key={r.key} style={[styles.seg, { backgroundColor: i < done ? c.ink : c.line2 }]} />
          ))}
        </View>
        <View accessibilityLiveRegion="polite">
          {rows.map((r, i) => (
            // A MediaRow: the step's icon (a check once done) in the face's place, its name on that line, what it says
            // and its buttons under them at the card's width, as on the web.
            <View
              key={r.key}
              style={[styles.row, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <MediaRow
                size="row"
                name={r.title}
                quiet={r.done ? "ink2" : r.dim ? "muted" : undefined}
                face={
                  r.done ? (
                    <View style={[styles.check, { backgroundColor: c.ink }]}>
                      <Icon name="check" size={12} color={c.bg} />
                    </View>
                  ) : (
                    <View style={styles.lead}>
                      <Icon name={r.icon} size={18} color={r.dim ? c.faint : c.ink2} />
                    </View>
                  )
                }
              >
                {r.saying ? (
                  <Text variant="caption" tone="ok">
                    {r.saying}
                  </Text>
                ) : !r.done && r.desc ? (
                  <Text variant="caption" tone="muted">
                    {r.desc}
                  </Text>
                ) : null}
                {(!r.done && r.skip) || r.action ? (
                  <View style={styles.acts}>
                    {!r.done && r.skip ? (
                      <Button
                        variant="text"
                        size="sm"
                        label={r.skip.label}
                        disabled={r.skip.busy}
                        onPress={r.skip.onPress}
                      />
                    ) : null}
                    {r.action ? (
                      r.done ? (
                        <Button variant="text" size="sm" label={r.action.label} onPress={r.action.onPress} />
                      ) : (
                        <Button
                          variant={r.action.primary ? "primary" : "secondary"}
                          size="sm"
                          label={r.action.label}
                          disabled={r.skip?.busy}
                          onPress={r.action.onPress}
                        />
                      )
                    ) : null}
                  </View>
                ) : null}
              </MediaRow>
            </View>
          ))}
        </View>
        {foot}
      </View>
    </Card>
  );
}

/** The card's foot: a lead, then asks to press. */
export function SetupAsks({ lead, asks }: { lead: string; asks: { label: string; onPress: () => void }[] }) {
  const c = useColors();
  return (
    <View style={[styles.foot, { borderTopColor: c.line }]}>
      <Text variant="small" style={styles.bold}>
        {lead}
      </Text>
      {asks.map((a) => (
        <Pressable
          key={a.label}
          onPress={a.onPress}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          style={({ pressed }) => [styles.task, { borderColor: c.line2 }, pressed && { backgroundColor: c.sunken }]}
        >
          <Icon name="chat" size={16} color={c.ink2} />
          <Text variant="small" style={styles.fill}>
            {a.label}
          </Text>
          <Icon name="right" size={16} color={c.faint} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A step done while the card is in view (after everything it reads has loaded): its line for a moment and a haptic.
 */
export function useDoneSay<S extends string>(ready: boolean, doneNow: readonly S[], sayOf: (step: S) => string) {
  const [said, setSaid] = useState<{ step: S; text: string } | null>(null);
  const seen = useRef<Set<S> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useRef(sayOf);
  say.current = sayOf;
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
    successHaptic();
    setSaid({ step: fresh, text });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 2600);
  }, [ready, doneKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return said;
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  fill: { flex: 1, minWidth: 0 },
  card: { marginTop: 2 },
  inner: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  meter: { flexDirection: "row", gap: 4, marginTop: 10, marginBottom: 4 },
  seg: { flex: 1, height: 4, borderRadius: 2 },
  row: { paddingVertical: 12 },
  lead: { flex: 1, alignItems: "center", justifyContent: "center" },
  check: {
    width: MEDIA_ROW.row.face,
    height: MEDIA_ROW.row.face,
    borderRadius: MEDIA_ROW.row.face / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, paddingBottom: 8, gap: 8 },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
