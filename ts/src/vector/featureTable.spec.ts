import { describe, expect, it, vi } from "vitest";
import { encodePointGeometryVector } from "../encoding/constGeometryVectorEncoder";
import { createConstGeometryVector } from "./geometry/constGeometryVector";
import { GEOMETRY_TYPE } from "./geometry/geometryType";
import TopologyVector from "./geometry/topologyVector";
import { createStringFlatVector } from "./flat/stringFlatVector";
import FeatureTable from "./featureTable";
import type Vector from "./vector";

function createDeferredTable() {
    const columns = new Map([
        ["first", createStringFlatVector(["one"], "first")],
        ["second", createStringFlatVector(["two"], "second")],
    ]);
    const resolver = vi.fn((name: string) => columns.get(name));
    const table = new FeatureTable(
        "layer",
        createConstGeometryVector(
            1,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            undefined,
            new Int32Array([0, 0]),
        ),
        undefined,
        [],
        4096,
        resolver,
        [...columns.keys()],
    );
    return { table, resolver };
}

describe("FeatureTable property materialization", () => {
    it("resolves a complete deferred table once and remains O(1)", () => {
        const { table, resolver } = createDeferredTable();

        const first = table.materializePropertyVectors();
        expect(first.map((column) => column.name)).toEqual(["first", "second"]);
        expect(resolver).toHaveBeenCalledTimes(2);

        const second = table.materializePropertyVectors();
        expect(second).toBe(first);
        expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("does not mark an explicit partial materialization as complete", () => {
        const { table, resolver } = createDeferredTable();

        table.materializePropertyVectors(["first"]);
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(table.propertyVectors?.map((column) => column.name)).toEqual(["first"]);

        table.materializePropertyVectors();
        expect(resolver).toHaveBeenCalledTimes(2);
        expect(table.propertyVectors?.map((column) => column.name)).toEqual(["first", "second"]);

        table.materializePropertyVectors();
        expect(resolver).toHaveBeenCalledTimes(2);
    });
});

const geometryVector = encodePointGeometryVector(1, 2);
const propertyVector = (name: string): Vector => ({ name }) as unknown as Vector;

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
});
