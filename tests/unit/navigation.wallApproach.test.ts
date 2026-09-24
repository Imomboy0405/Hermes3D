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
    const insideWall = (x: number, y: number) =>
      walls.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
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
