import { describe, expect, it } from "vitest";
import {
  createEmptyData,
  loadData,
  saveData,
  STORAGE_KEY,
} from "./storage.js";

function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[STORAGE_KEY, initial]]);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    raw(key) {
      return values.get(key);
    },
  };
}

describe("local attendance persistence", () => {
  it("saves validated data and loads it on the next read", () => {
    const storage = memoryStorage();
    const data = createEmptyData();
    data.subjects.push({
      id: "math",
      name: "Math",
      attended: 4,
      total: 5,
      target: 75,
      history: [{ date: "2026-10-22", attended: 1, missed: 0 }],
    });
    saveData(data, storage);
    expect(loadData(storage)).toEqual({ data, warning: "" });
  });

  it("does not overwrite corrupted saved data while reporting the problem", () => {
    const storage = memoryStorage("{not-json");
    const loaded = loadData(storage);
    expect(loaded.data.subjects).toEqual([]);
    expect(loaded.warning).toMatch(/could not be loaded/);
    expect(storage.raw(STORAGE_KEY)).toBe("{not-json");
  });

  it("reports inaccessible storage instead of claiming data was saved", () => {
    const brokenStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(loadData(brokenStorage).warning).toMatch(/blocked/);
    expect(() => saveData(createEmptyData(), brokenStorage)).toThrow(/blocked/);
  });

  it("rejects invalid data rather than persisting it", () => {
    const storage = memoryStorage();
    expect(() => saveData({ settings: {}, subjects: [{ name: "Math", attended: 6, total: 5 }] }, storage)).toThrow();
    expect(storage.raw(STORAGE_KEY)).toBeUndefined();
  });
});
