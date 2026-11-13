import { mix } from "@agenteschat/ui/sky/math";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Dither } from "@/sky/Dither";
import { Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/** As wide as a lone picture gets in a message (`MessageFiles`). */
const MAX_SIDE = 300;

/**
 * Where a picture an agent is making will show, while it makes it (`makingImage`), as the web's `ImageMaking`: a lone
 * picture's square box with the working line's dithered sweep crossing it, in the surface's own greys, until the reply
 * takes its place with the picture. Its image tool says nothing until it is done, so it shows no progress.
 */
export function ImageMaking() {
  const { t } = useTranslation();
  const c = useColors();
  const [width, setWidth] = useState(0);
  const side = Math.min(width || MAX_SIDE, MAX_SIDE);
  const tones = [0, 0.1, 0.2, 0.32, 0.46, 0.6, 0.72].map((k) => mix(c.sunken, c.faint, k));
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.wrap}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("files.imageMaking")}
        style={[styles.box, { width: side, height: side, backgroundColor: c.sunken, borderColor: c.line2 }]}
      >
        <Dither kind="sweep" tones={tones} pixel={3} style={StyleSheet.absoluteFill} />
        <View style={styles.label} importantForAccessibility="no-hide-descendants">
          <Icon name="image" size={16} color={c.muted} />
          <Text variant="caption" tone="muted">
            {t("files.imageMaking")}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch" },
  // As a lone picture's box (`MessageFiles` `shot`).
  box: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  label: { position: "absolute", left: 12, bottom: 10, flexDirection: "row", alignItems: "center", gap: 6 },
});
