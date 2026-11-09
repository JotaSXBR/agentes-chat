import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { TabPanel, Tabs } from "../src";
import { overflowOf } from "../src/components/Tabs";

describe("a tab row narrower than its tabs", () => {
  test("the tabs give way from the end until the rest fit, never the chosen one", () => {
    // Four tabs of 100 with 10 between them: 430 in all.
    const widths = [100, 100, 100, 100];
    expect(overflowOf(widths, 10, 430, 0)).toEqual([]);
    expect(overflowOf(widths, 10, 429, 0)).toEqual([3]);
    expect(overflowOf(widths, 10, 210, 0)).toEqual([2, 3]);
    // The chosen tab stays in the row: the ones before it give way instead.
    expect(overflowOf(widths, 10, 210, 3)).toEqual([1, 2]);
    // Room for none but the chosen one.
    expect(overflowOf(widths, 10, 0, 1)).toEqual([0, 2, 3]);
  });

  test("the ones that left are out of the row and in the menu, in their order", async () => {
    // Laid out as a browser would: the row 300 wide, each tab 100, the menu's trigger 60.
    const proto = HTMLElement.prototype;
    const sizes: Record<string, (el: HTMLElement) => number | undefined> = {
      offsetWidth: (el) =>
        el.classList.contains("ac-tab") ? 100 : el.classList.contains("ac-tabs__end") ? 60 : undefined,
      clientWidth: (el) => (el.classList.contains("ac-tabs") ? 300 : undefined),
    };
    const was = Object.fromEntries(Object.keys(sizes).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
    for (const [key, size] of Object.entries(sizes))
      Object.defineProperty(proto, key, {
        configurable: true,
        get(this: HTMLElement) {
          return size(this) ?? was[key]?.get?.call(this) ?? 0;
        },
      });
    try {
      const seen: string[][] = [];
      function Row() {
        const [tab, setTab] = useState("d");
        return (
          <Tabs
            label="Seções"
            value={tab}
            onValueChange={setTab}
            items={["a", "b", "c", "d"].map((v) => ({ value: v, label: v.toUpperCase() }))}
            after={(overflow) => {
              seen.push(overflow);
              return <button type="button">Mais</button>;
            }}
          >
            <TabPanel value={tab}>{tab}</TabPanel>
          </Tabs>
        );
      }
      const { container } = render(<Row />);
      await act(async () => {});
      const left = [...container.querySelectorAll<HTMLElement>(".ac-tab[data-overflow]")].map((t) => t.textContent);
      // 300 less the trigger's 60: A and the chosen D fit, B and C go to the menu.
      expect(left).toEqual(["B", "C"]);
      expect(seen.at(-1)).toEqual(["b", "c"]);
      expect(container.querySelector(".ac-tab[data-state='active']")?.hasAttribute("data-overflow")).toBe(false);
    } finally {
      for (const [key, d] of Object.entries(was)) {
        if (d) Object.defineProperty(proto, key, d);
        else Reflect.deleteProperty(proto, key);
      }
    }
  });

  test("a tab that left is still laid out, out of the row and of reach, so its width is known when room comes back", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = css.match(/\.ac-tab\[data-overflow\] \{([^}]*)\}/)?.[1] ?? "";
    for (const part of ["position: absolute;", "visibility: hidden;", "pointer-events: none;"])
      expect(rule).toContain(part);
    expect(rule).not.toContain("display: none");
  });
});
