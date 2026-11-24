import { describe, expect, it, vi } from "vitest";
import { encodePointGeometryVector } from "../encoding/constGeometryVectorEncoder";
import { StringFlatVector } from "./flat/stringFlatVector";
import FeatureTable from "./featureTable";
import type Vector from "./vector";

const geometryVector = encodePointGeometryVector(1, 2);
const propertyVector = (name: string): Vector => ({ name }) as unknown as Vector;

/** A string column that holds one value. */
function stringColumn(name: string, value: string): StringFlatVector {
    const bytes = new TextEncoder().encode(value);
    return new StringFlatVector(name, Uint32Array.of(0, bytes.length), bytes);
}

/** A table whose two columns, `first` and `second`, are left for `resolver` to hand over when they are asked for. */
function createDeferredTable() {
    const columns = new Map([
        ["first", stringColumn("first", "one")],
        ["second", stringColumn("second", "two")],
    ]);
    const resolver = vi.fn((name: string) => columns.get(name));
    const table = new FeatureTable("layer", geometryVector, undefined, [], 4096, resolver, [...columns.keys()]);
    return { table, resolver };
}

describe("FeatureTable", () => {
    it("throws when constructed without a layer name", () => {
        expect(() => new FeatureTable("", geometryVector)).toThrow("Missing layer name");
    });

    it("returns an empty array when no property vectors are provided", () => {
        const table = new FeatureTable("layer", geometryVector);
        expect(table.propertyVectors).toEqual([]);
    });

    it("looks up property vectors by name and returns undefined for unknown names", () => {
        const a = propertyVector("a");
        const b = propertyVector("b");
        const table = new FeatureTable("layer", geometryVector, undefined, [a, b]);

        expect(table.getPropertyVector("a")).toBe(a);
        expect(table.getPropertyVector("b")).toBe(b);
        expect(table.getPropertyVector("missing")).toBeUndefined();
    });

    it("names the properties of a table that holds all its property vectors", () => {
        const table = new FeatureTable("layer", geometryVector, undefined, [propertyVector("a"), propertyVector("b")]);

        expect(table.availablePropertyNames).toEqual(["a", "b"]);
    });

    it("asks the resolver for each deferred column once, however often all the columns are materialized", () => {
        const { table, resolver } = createDeferredTable();

        const first = table.materializePropertyVectors();
        expect(first.map((column) => column.name)).toEqual(["first", "second"]);
        expect(resolver).toHaveBeenCalledTimes(2);

        const second = table.materializePropertyVectors();
        expect(second).toBe(first);
        expect(resolver).toHaveBeenCalledTimes(2);
    });
});
