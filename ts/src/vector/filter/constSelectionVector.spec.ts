import { describe, it, expect } from "vitest";
import { ConstSelectionVector } from "./constSelectionVector";

describe("ConstSelectionVector", () => {
    describe("full selection", () => {
        it("returns index for getIndex", () => {
            const sv = ConstSelectionVector.full(5);
            expect(sv.getIndex(0)).toBe(0);
            expect(sv.getIndex(4)).toBe(4);
        });

        it("returns length as limit", () => {
            const sv = ConstSelectionVector.full(5);
            expect(sv.limit).toBe(5);
        });

        it("returns all indices from selectionValues", () => {
            const sv = ConstSelectionVector.full(3);
            const values = sv.selectionValues();
            expect(values).toEqual(new Uint32Array([0, 1, 2]));
        });
    });

    describe("empty selection", () => {
        it("returns -1 for getIndex", () => {
            const sv = ConstSelectionVector.empty(5);
            expect(sv.getIndex(0)).toBe(-1);
        });

        it("returns 0 as limit", () => {
            const sv = ConstSelectionVector.empty(5);
            expect(sv.limit).toBe(0);
        });

        it("returns empty array from selectionValues", () => {
            const sv = ConstSelectionVector.empty(5);
            expect(sv.selectionValues()).toEqual(new Uint32Array(0));
        });
    });

    describe("immutability", () => {
        it("throws on setIndex", () => {
            const sv = ConstSelectionVector.full(5);
            expect(() => sv.setIndex(0, 1)).toThrow("ConstSelectionVector is immutable");
        });

        it("throws on setLimit", () => {
            const sv = ConstSelectionVector.full(5);
            expect(() => sv.setLimit(3)).toThrow("ConstSelectionVector is immutable");
        });
    });

    describe("capacity", () => {
        it("returns length for full selection", () => {
            const sv = ConstSelectionVector.full(5);
            expect(sv.capacity).toBe(5);
        });

        it("returns length for empty selection", () => {
            const sv = ConstSelectionVector.empty(5);
            expect(sv.capacity).toBe(5);
        });
    });
});
