import { expect, test } from "bun:test";
import path from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .findLast(([p]) => p === property)?.[1]
    .replace(/\s+/g, " ");
/** A row's corners in a card of `outer` with `room` around its rows: the card's less that room, the cut one a cut. */
const less = (outer: string, room: string) => {
  const r = `calc(${outer} - ${room})`;
  return `${r} ${r} ${r} var(--radius-cut)`;
};

// The geometry check's `concentric` rule measures cards with two plated rows or more straight in them; these hold one
// row in the tests, or their rows a level deeper, so their sheets keep the arithmetic.
test("a card's plated rows stand one room from its edges, their corners the card's less that room", async () => {
  const kit = topLevel(await sheet("packages/ui/src/styles/components.css"));
  const layout = await sheet("apps/web/src/layout.css");
  const app = topLevel(layout);
  const team = topLevel(await sheet("apps/web/src/pages/team.css"));

  // A reply's tools: the lines' room (one call's too) and each line's plate, which its row takes.
  expect(value(kit, ".ac-tools__lines", "padding")).toBe("var(--tools-pad)");
  expect(value(kit, ".ac-tools--one > .ac-tools__lines", "--tools-pad")).toBe("2px");
  expect(value(kit, ".ac-tools__line", "border-radius")).toBe(less("var(--radius-item)", "var(--tools-pad)"));
  expect(value(kit, ".ac-tools__row", "border-radius")).toBe("inherit");

  // Equipe › Arquivados.
  expect(value(team, ".team-archived", "padding")).toBe("var(--archived-pad)");
  expect(value(team, ".team-archived__row", "border-radius")).toBe(
    less("var(--radius-section)", "var(--archived-pad)"),
  );

  // A tool review's subjects: under the last one its rows stand as far from the card's bottom as from its sides.
  expect(value(app, ".tr-subjects", "border-radius")).toBe("var(--tr-r)");
  expect(value(app, ".tr-subj__b", "padding")).toBe("2px var(--tr-pad) 10px");
  expect(value(app, ".tr-subj:last-child > .tr-subj__b", "padding-bottom")).toBe("var(--tr-pad)");
  expect(value(app, ".tr-row", "border-radius")).toBe("calc(var(--tr-r) - var(--tr-pad))");
  const phone = atRule(layout, "@media (max-width: 640px)");
  expect(value(phone, ".tr-subjects", "--tr-pad")).toBe("var(--space-1)");
  expect(value(phone, ".tr-subj__b", "padding")).toBe("2px var(--tr-pad) 8px");

  // A menu on the glass (the wiki's suggestions): a menu's corner, its rows' plus its room, not the glass's 16.
  expect(value(app, ".wiki-suggest", "padding")).toBe("var(--menu-pad)");
  expect(value(app, ".wiki-suggest", "border-radius")).toBe("calc(var(--radius-item) + var(--menu-pad))");
});
