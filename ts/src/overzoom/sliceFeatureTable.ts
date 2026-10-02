import FeatureTable from "../vector/featureTable";
import Vector from "../vector/vector";
import type { IdVector } from "../vector/idVector";
import { IndexedVector } from "../vector/indexedVector";
import BitVector from "../vector/flat/bitVector";
import { BooleanFlatVector } from "../vector/flat/booleanFlatVector";
import { DoubleFlatVector } from "../vector/flat/doubleFlatVector";
import { FloatFlatVector } from "../vector/flat/floatFlatVector";
import { Int32FlatVector } from "../vector/flat/int32FlatVector";
import { Int64FlatVector } from "../vector/flat/int64FlatVector";
import { StringFlatVector, createNullableStringVector } from "../vector/flat/stringFlatVector";
import { StringDictionaryVector, createStringDictionaryVector } from "../vector/dictionary/stringDictionaryVector";
import { StringFsstDictionaryVector } from "../vector/fsst-dictionary/stringFsstDictionaryVector";
import { sliceGeometryVector, type SlicedGeometryVector } from "./sliceGeometryVector";

export type TileLike = {
    z: number;
    x: number;
    y: number;
};

export type SliceFeatureTableOptions = {
    buffer?: number;
    /**
     * The extent of the sliced table, a multiple of the source extent. Vertices are rounded to it, so a finer
     * extent keeps more of the precision of the clipped coordinates.
     */
    extent?: number;
    /** Resolve missing property columns only when a consumer requests them. */
    deferProperties?: boolean;
    /** Bind only these columns; other available columns remain accessible with deferProperties. */
    propertyNames?: ReadonlySet<string>;
    /** Indexed columns share immutable parent values; copying remains the standalone slicing default. */
    columnMode?: "copy" | "indexed";
};

class ArrayVector extends Vector<Uint8Array, unknown> {
    constructor(
        name: string,
        private readonly values: unknown[],
    ) {
        super(name, new Uint8Array(0), values.length);
    }

    protected getValueFromBuffer(index: number): unknown {
        return this.values[index];
    }
}

export function sliceFeatureTable(
    featureTable: FeatureTable,
    maxZoomTileID: TileLike,
    targetTileID: TileLike,
    options: SliceFeatureTableOptions = {},
): FeatureTable {
    return applyFeatureTableSlice(
        featureTable,
        sliceFeatureTableGeometry(featureTable, maxZoomTileID, targetTileID, options),
        options,
    );
}

/** Clips only geometry and records source rows, independently of style/property projection. */
export function sliceFeatureTableGeometry(
    featureTable: FeatureTable,
    maxZoomTileID: TileLike,
    targetTileID: TileLike,
    options: Pick<SliceFeatureTableOptions, "buffer" | "extent"> = {},
): SlicedGeometryVector {
    const extent = featureTable.extent;
    const dz = targetTileID.z - maxZoomTileID.z;
    const scale = 2 ** dz;
    const offsetX = (targetTileID.x - maxZoomTileID.x * scale) * extent;
    const offsetY = (targetTileID.y - maxZoomTileID.y * scale) * extent;
    const buffer = options.buffer ?? 128;
    return sliceGeometryVector(featureTable, scale, offsetX, offsetY, -buffer, extent + buffer, (options.extent ?? extent) / extent);
}

/** Reuses clipped geometry with the current source columns; deferred columns preserve unstyled public properties. */
export function applyFeatureTableSlice(
    featureTable: FeatureTable,
    { geometryVector, sourceIndices, extent }: SlicedGeometryVector,
    options: Pick<SliceFeatureTableOptions, "deferProperties" | "propertyNames" | "columnMode"> = {},
): FeatureTable {
    return new FeatureTable(
        featureTable.name,
        geometryVector,
        selectIdVector(featureTable.idVector, sourceIndices, options.columnMode),
        selectPropertyVectors(
            options.propertyNames
                ? featureTable.propertyVectors.filter((column) => options.propertyNames.has(column.name))
                : featureTable.propertyVectors,
            sourceIndices,
            options.columnMode,
        ),
        extent,
        options.deferProperties
            ? (name) => {
                  const source = featureTable.getPropertyVector(name);
                  return source ? selectPropertyVectors([source], sourceIndices, options.columnMode)[0] : undefined;
              }
            : undefined,
        options.deferProperties ? featureTable.availablePropertyNames : undefined,
    );
}

function selectIdVector(idVector: IdVector | undefined, sourceIndices: Uint32Array, mode?: "copy" | "indexed"): IdVector | undefined {
    if (!idVector) {
        return undefined;
    }
    if (mode === "indexed") return new IndexedVector<number | bigint>(idVector, sourceIndices);

    const values = Array.from(sourceIndices, (sourceIndex) => idVector.getValue(sourceIndex));
    if (values.some((value) => typeof value === "bigint")) {
        return new Int64FlatVector(
            idVector.name,
            new BigInt64Array(values.map((value) => BigInt(value ?? 0))),
            createNullability(values),
        );
    }

    if (
        values.every(
            (value) =>
                value === null ||
                (typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647),
        )
    ) {
        return new Int32FlatVector(
            idVector.name,
            new Int32Array(values.map((value) => Number(value ?? 0))),
            createNullability(values),
        );
    }

    return new DoubleFlatVector(
        idVector.name,
        new Float64Array(values.map((value) => Number(value ?? 0))),
        createNullability(values),
    );
}

function selectPropertyVectors(propertyVectors: Vector[] | undefined, sourceIndices: Uint32Array, mode?: "copy" | "indexed"): Vector[] | undefined {
    if (!propertyVectors) {
        return undefined;
    }

    return propertyVectors.map((vector) => {
        if (mode === "indexed") return new IndexedVector(vector, sourceIndices);
        const values = Array.from(sourceIndices, (sourceIndex) => vector.getValue(sourceIndex));
        return createVectorForValues(vector, values);
    });
}

function createVectorForValues(sourceVector: Vector, values: unknown[]): Vector {
    if (
        sourceVector instanceof StringDictionaryVector ||
        sourceVector instanceof StringFlatVector ||
        sourceVector instanceof StringFsstDictionaryVector ||
        values.every((value) => value === null || typeof value === "string")
    ) {
        return sourceVector instanceof StringDictionaryVector
            ? createStringDictionaryVector(values as (string | null)[], sourceVector.name)
            : createNullableStringVector(values as (string | null)[], sourceVector.name);
    }

    if (
        sourceVector instanceof BooleanFlatVector ||
        values.every((value) => value === null || typeof value === "boolean")
    ) {
        const data = new Uint8Array(Math.ceil(values.length / 8));
        const dataVector = new BitVector(data, values.length);
        for (let i = 0; i < values.length; i++) {
            if (values[i] === true) {
                dataVector.set(i, true);
            }
        }
        return new BooleanFlatVector(sourceVector.name, dataVector, createNullability(values));
    }

    if (sourceVector instanceof Int64FlatVector || values.some((value) => typeof value === "bigint")) {
        return new Int64FlatVector(
            sourceVector.name,
            new BigInt64Array(values.map((value) => BigInt((value as string | number | bigint | boolean) ?? 0))),
            createNullability(values),
        );
    }

    if (sourceVector instanceof FloatFlatVector) {
        return new FloatFlatVector(
            sourceVector.name,
            new Float32Array(values.map((value) => Number(value ?? 0))),
            createNullability(values),
        );
    }

    if (
        sourceVector instanceof DoubleFlatVector ||
        values.some((value) => typeof value === "number" && !Number.isInteger(value))
    ) {
        return new DoubleFlatVector(
            sourceVector.name,
            new Float64Array(values.map((value) => Number(value ?? 0))),
            createNullability(values),
        );
    }

    if (
        sourceVector instanceof Int32FlatVector ||
        values.every((value) => value === null || typeof value === "number")
    ) {
        return new Int32FlatVector(
            sourceVector.name,
            new Int32Array(values.map((value) => Number(value ?? 0))),
            createNullability(values),
        );
    }

    return new ArrayVector(sourceVector.name, values);
}

function createNullability(values: unknown[]): number | BitVector {
    if (!values.some((value) => value === null)) {
        return values.length;
    }

    const data = new Uint8Array(Math.ceil(values.length / 8));
    const bitVector = new BitVector(data, values.length);
    for (let i = 0; i < values.length; i++) {
        bitVector.set(i, values[i] !== null);
    }
    return bitVector;
}
