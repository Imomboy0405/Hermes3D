import { describe, expect, it } from "vitest";
import { materializeDefaults } from "@/features/retro-office/core/furnitureDefaults";
import { astar, buildNavGrid, getDeskLocations, ROAM_POINTS } from "@/features/retro-office/core/navigation";
import { getItemBounds } from "@/features/retro-office/core/geometry";

// Regression: a target inside a blocked cell used to snap to the nearest free
// cell even when that cell was on the far side of a wall, and the final
// straight leg then walked the agent through the wall.
describe("astar never routes through walls", () => {
  it("keeps every leg of every default-office route out of wall bodies", () => {
    const items = materializeDefaults("office");
    const grid = buildNavGrid(items);
    const walls = items.filter((item) => item.type === "wall").map(getItemBounds);
    const doors = items.filter((item) => item.type === "door").map(getItemBounds);
    const inside = (b: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
      x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    // Wall ends overlap the doors next to them by a few units; a point in a
    // door's opening is passable even where it also touches a wall end.
    // The nav grid is 25 units per cell, so a leg may graze a wall corner by
    // a fraction of a unit; only count real crossings (deeper than 2 units).
    const GRAZE = 2;
    const insideWall = (x: number, y: number) =>
      walls.some((b) =>
        inside({ x: b.x + GRAZE, y: b.y + GRAZE, w: b.w - 2 * GRAZE, h: b.h - 2 * GRAZE }, x, y),
      ) && !doors.some((b) => inside(b, x, y));
    const points = [...ROAM_POINTS, ...(getDeskLocations(items) as { x: number; y: number }[])];

    let crossings = 0;
    for (const start of points) {
      for (const end of points) {
        if (start === end) continue;
        let px = start.x;
        let py = start.y;
        for (const waypoint of astar(start.x, start.y, end.x, end.y, grid)) {
          const steps = Math.max(1, Math.ceil(Math.hypot(waypoint.x - px, waypoint.y - py) / 2));
          for (let step = 1; step < steps; step += 1) {
            if (insideWall(px + ((waypoint.x - px) * step) / steps, py + ((waypoint.y - py) * step) / steps)) {
              crossings += 1;
              break;
            }
          }
          px = waypoint.x;
          py = waypoint.y;
        }
      }
    }
    expect(crossings).toBe(0);
  });
});

describe("the office's outer walls", () => {
  it("keeps agents inside the local building even when a target lies outside", () => {
    const items = materializeDefaults("office");
    const grid = buildNavGrid(items);
    const starts = [...ROAM_POINTS, ...(getDeskLocations(items) as { x: number; y: number }[])];
    const outside = [
      { x: 900, y: 760 },
      { x: 1300, y: 740 },
      { x: 200, y: 900 },
      { x: 1500, y: 1300 },
    ];
    for (const start of starts) {
      for (const target of outside) {
        for (const waypoint of astar(start.x, start.y, target.x, target.y, grid)) {
          expect(waypoint.y).toBeLessThan(720);
        }
      }
    }
  });
});

describe("doors", () => {
  it("lets every roam point and desk reach every other one", () => {
    const items = materializeDefaults("office");
    const grid = buildNavGrid(items);
    const points = [...ROAM_POINTS, ...(getDeskLocations(items) as { x: number; y: number }[])];
    const unreachable: string[] = [];
    for (const start of points) {
      for (const end of points) {
        if (start === end) continue;
        if (astar(start.x, start.y, end.x, end.y, grid).length === 0) {
          unreachable.push(`${start.x},${start.y} -> ${end.x},${end.y}`);
        }
      }
    }
    expect(unreachable).toEqual([]);
  });
});
