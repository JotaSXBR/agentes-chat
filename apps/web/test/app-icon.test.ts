import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { APP_ICONS } from "@agenteschat/client/lib/app-icons";
import { appIcon, appIconPicture, faviconOf, picksAppIcon, setAppIcon } from "../src/lib/app-icon";
import { STORAGE_KEYS } from "../src/lib/storage";

describe("the app icon in a browser (ADR 0164)", () => {
  test("the shipped icon is the favicon browsers ask for; the others have their own", () => {
    expect(faviconOf("night")).toBe("/favicon.ico");
    expect(faviconOf("peekSky")).toBe("/app-icons/peekSky.ico");
    expect(APP_ICONS.map(appIconPicture)).toContain("/app-icons/moon.png");
    expect(picksAppIcon()).toBe(true);
  });

  test("a pick changes the tab's icon and stays in this browser", async () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />';
    const changes: string[] = [];
    const listen = () => changes.push(appIcon());
    window.addEventListener("agentes:app-icon", listen);
    await setAppIcon("moon");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/app-icons/moon.ico");
    expect(localStorage.getItem(STORAGE_KEYS.appIcon)).toBe("moon");
    expect(appIcon()).toBe("moon");
    await setAppIcon("night");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.ico");
    expect(changes).toEqual(["moon", "night"]);
    window.removeEventListener("agentes:app-icon", listen);
  });
});
