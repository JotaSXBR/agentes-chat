import { type AppIconId, DEFAULT_APP_ICON, isAppIcon } from "@agenteschat/client/lib/app-icons";
import { desktopPicksAppIcon, inDesktopApp, thisMac } from "./desktop";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * The app icon on this device (ADR 0164). In a browser it is the tabs' icon, kept in this browser like the theme.
 * In the desktop app it is the Dock's (the taskbar's on Windows and Linux), kept by the app itself, so every server's
 * pages show the same; an app from before it can't (`desktopPicksAppIcon`) and the row stays hidden.
 */
const CHANGE_EVENT = "agentes:app-icon";

const saved = (): AppIconId => {
  const value = storage.get(STORAGE_KEYS.appIcon);
  return isAppIcon(value) ? value : DEFAULT_APP_ICON;
};
let current: AppIconId = inDesktopApp() ? DEFAULT_APP_ICON : saved();

/** The icon's picture in the picker (packages/ui/scripts/app-icons.mjs writes them). */
export const appIconPicture = (id: AppIconId) => `/app-icons/${id}.png`;
/** The tab's icon: the shipped one at the address browsers ask for on their own. */
export const faviconOf = (id: AppIconId) => (id === DEFAULT_APP_ICON ? "/favicon.ico" : `/app-icons/${id}.ico`);

/** Whether this device can change its icon here (a browser, or a desktop app that keeps one). */
export const picksAppIcon = () => !inDesktopApp() || desktopPicksAppIcon();

export const appIcon = () => current;
export const onAppIconChange = (cb: () => void) => {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
};

function show(id: AppIconId) {
  current = id;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && link.getAttribute("href") !== faviconOf(id)) link.setAttribute("href", faviconOf(id));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Changes the icon. In the desktop app the app keeps it, and a refusal (an older app) rejects. */
export async function setAppIcon(id: AppIconId) {
  if (inDesktopApp()) await thisMac.appIcon(id);
  else storage.set(STORAGE_KEYS.appIcon, id);
  show(id);
}

/** At start: the tab shows the icon kept in this browser; the desktop app answers the one it keeps. */
export function startAppIcon() {
  if (!inDesktopApp()) {
    if (current !== DEFAULT_APP_ICON) show(current);
    return;
  }
  if (!desktopPicksAppIcon()) return;
  void thisMac
    .appIcon()
    .then(({ icon }) => {
      if (isAppIcon(icon) && icon !== current) show(icon);
    })
    .catch(() => undefined);
}
