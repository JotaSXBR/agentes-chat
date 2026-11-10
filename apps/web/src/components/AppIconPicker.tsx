import { APP_ICONS, type AppIconId, appIconNameKey } from "@agenteschat/client/lib/app-icons";
import { Dialog, DialogBody } from "@agenteschat/ui";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { appIcon, appIconPicture, onAppIconChange, setAppIcon } from "@/lib/app-icon";
import { desktopPlatform } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

/** The picked icon, kept in step with the store (lib/app-icon.ts). */
export const useAppIcon = () => useSyncExternalStore(onAppIconChange, appIcon, appIcon);

/** An icon's picture in iOS's shape (the corners round like a home screen's). */
export function AppIconPicture({ id, className }: { id: AppIconId; className?: string }) {
  return <img src={appIconPicture(id)} alt="" className={["app-icon-pic", className].filter(Boolean).join(" ")} />;
}

/**
 * Settings › Account › This device › App icon (ADR 0164): the icons, one line each with its picture; a pick
 * applies at once (the tab's icon, or the desktop app's Dock), like the theme.
 */
export function AppIconDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const current = useAppIcon();
  const platform = desktopPlatform();
  const hint = !platform ? t("appIcon.hintWeb") : platform === "mac" ? t("appIcon.hintMac") : t("appIcon.hintDesktop");
  const pick = (id: AppIconId) => {
    if (id === current) return;
    void setAppIcon(id).catch(() => toast.show(t("appIcon.failed")));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("appIcon.title")}
      description={hint}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>
        <div className="app-icons" role="radiogroup" aria-label={t("appIcon.title")}>
          {APP_ICONS.map((id) => (
            // biome-ignore lint/a11y/useSemanticElements: a choice button in a radio group
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={current === id}
              className="app-icons__item"
              onClick={() => pick(id)}
            >
              <span className="ac-radio" data-state={current === id ? "checked" : "unchecked"} aria-hidden="true">
                {current === id && <span className="ac-radio__dot" />}
              </span>
              <AppIconPicture id={id} />
              <span className="app-icons__name">{t(appIconNameKey(id))}</span>
            </button>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}
