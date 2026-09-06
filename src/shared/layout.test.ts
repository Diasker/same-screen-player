import { describe, expect, it } from "vitest";
import {
  createPreset,
  getPaneIds,
  removePane,
  setRatioAtPath,
  splitPane,
} from "./types";

describe("layout model", () => {
  it("creates all supported presets with the expected pane count", () => {
    expect(getPaneIds(createPreset("single"))).toHaveLength(1);
    expect(getPaneIds(createPreset("split-2"))).toHaveLength(2);
    expect(getPaneIds(createPreset("split-3"))).toHaveLength(3);
    expect(getPaneIds(createPreset("grid-2x2"))).toHaveLength(4);
    expect(getPaneIds(createPreset("grid-3x2"))).toHaveLength(6);
  });

  it("clamps divider ratios to a usable range", () => {
    const layout = createPreset("split-2");
    expect(setRatioAtPath(layout, [], 0).kind).toBe("split");
    expect((setRatioAtPath(layout, [], 0) as { ratio: number }).ratio).toBe(0.1);
    expect((setRatioAtPath(layout, [], 1) as { ratio: number }).ratio).toBe(0.9);
  });

  it("splits and removes panes without leaving empty branches", () => {
    const layout = createPreset("single");
    const split = splitPane(layout, "pane-1", "vertical");
    const ids = getPaneIds(split);
    expect(ids).toHaveLength(2);
    const remaining = removePane(split, ids[1]);
    expect(remaining).not.toBeNull();
    expect(getPaneIds(remaining!)).toEqual(["pane-1"]);
  });
});
