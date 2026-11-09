import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { MenuOverlayItem } from "../src";

describe("a workspace menu row's end", () => {
  test("its words end the row: no empty key after them where a row has no shortcut", () => {
    const { container } = render(
      <>
        <MenuOverlayItem hint="Você está aqui" current onSelect={() => {}}>
          Acme
        </MenuOverlayItem>
        <MenuOverlayItem onSelect={() => {}}>Outra</MenuOverlayItem>
        <MenuOverlayItem shortcut="1" onSelect={() => {}}>
          Convidar pessoas
        </MenuOverlayItem>
      </>,
    );
    const [here, other, keyed] = [...container.querySelectorAll(".ac-mo__item")];
    const hint = here?.lastElementChild;
    expect(hint?.className).toBe("ac-menu__hint");
    expect(hint?.textContent).toBe("Você está aqui");
    expect(hint?.querySelector(".ac-kbd")).toBeNull();
    // Nothing to say at its end: no box there at all.
    expect(other?.querySelector(".ac-menu__hint")).toBeNull();
    // A shortcut still shows its key at the end, on hover and focus.
    expect(keyed?.querySelector(".ac-menu__hint > .ac-mo__kbd")?.textContent).toBe("1");
  });

  test("beside a workspace's mark, which stands 6px into the row's padding, its words stand as far into the other side", async () => {
    const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const body = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(body(".ac-mo__item")).toContain("padding: 10px 14px;");
    expect(body(".ac-mo__leading")).toContain("margin: -6px;");
    expect(body(".ac-mo__item:has(> .ac-mo__leading) > .ac-menu__hint")).toContain("margin-right: -6px;");
  });
});
