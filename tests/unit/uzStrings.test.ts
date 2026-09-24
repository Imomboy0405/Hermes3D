import { describe, expect, it } from "vitest";
import { UZ_STRINGS } from "@/lib/i18n/uz";

describe("UZ_STRINGS", () => {
  it("never maps a translation onto another translation", () => {
    // The runtime translator re-reads text it has just written; a value that is
    // itself a key with a different translation would flip text on every pass.
    const lower = new Map(Object.entries(UZ_STRINGS).map(([key, value]) => [key.toLowerCase(), value]));
    const unstable = Object.values(UZ_STRINGS).filter((value) => {
      const again = UZ_STRINGS[value] ?? lower.get(value.toLowerCase());
      return again !== undefined && again.toLowerCase() !== value.toLowerCase();
    });
    expect(unstable).toEqual([]);
  });
});
