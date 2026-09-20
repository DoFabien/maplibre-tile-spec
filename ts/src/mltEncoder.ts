import type FeatureTable from "./vector/featureTable";
import type Vector from "./vector/vector";
import { IndexedVector } from "./vector/indexedVector";
import { BooleanFlatVector } from "./vector/flat/booleanFlatVector";
import { DoubleFlatVector } from "./vector/flat/doubleFlatVector";
import { FloatFlatVector } from "./vector/flat/floatFlatVector";
import { StringFlatVector } from "./vector/flat/stringFlatVector";
import { StringDictionaryVector } from "./vector/dictionary/stringDictionaryVector";
import { StringFsstDictionaryVector } from "./vector/fsst-dictionary/stringFsstDictionaryVector";
import { Int32ConstVector } from "./vector/constant/int32ConstVector";
import { Int64ConstVector } from "./vector/constant/int64ConstVector";
import { Int32SequenceVector } from "./vector/sequence/int32SequenceVector";
import { Int64SequenceVector } from "./vector/sequence/int64SequenceVector";
import { GEOMETRY_TYPE } from "./vector/geometry/geometryType";
import { GeometryTopologyCursor } from "./vector/geometry/geometryTopologyCursor";
import { DictionaryType } from "./metadata/tile/dictionaryType";
import { LengthType } from "./metadata/tile/lengthType";
import { LogicalLevelTechnique } from "./metadata/tile/logicalLevelTechnique";
import { PhysicalLevelTechnique } from "./metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "./metadata/tile/physicalStreamType";
import { ScalarType } from "./metadata/tileset/tilesetMetadata";
import type { LogicalStreamType } from "./metadata/tile/logicalStreamType";
import type { RleEncodedStreamMetadata, StreamMetadata } from "./metadata/tile/streamMetadataDecoder";
import IntWrapper from "./decoding/intWrapper";
import {
    encodeChildCount,
    encodeFieldName,
    encodeTypeCode,
    scalarTypeCode,
} from "./encoding/embeddedTilesetMetadataEncoder";
import { concatenateBuffers, encodeBooleanRle, encodeDoubleLE, encodeFloatsLE } from "./encoding/encodingUtils";
import {
    encodeVarintInt32,
    encodeVarintInt32Value,
    encodeVarintInt64,
    encodeZigZagInt32,
    encodeZigZagInt32Value,
    encodeZigZagInt64,
    encodeZigZagInt64Value,
} from "./encoding/integerEncodingUtils";
import { encodeDictionaryStrings, encodePlainStrings } from "./encoding/stringEncoder";

type EncodedColumn = {
    metadata: Uint8Array;
    data: Uint8Array;
};

type EncodedScalar = {
    scalarType: number;
    nullable: boolean;
    streamCount: number;
    data: Uint8Array;
};

/**
 * Encodes columnar FeatureTables as an embedded-metadata MLT tile.
 *
 * The encoder deliberately uses simple, interoperable encodings. It preserves
 * the columnar topology and scalar values without constructing feature,
 * property, Point, or Point[][] compatibility objects.
 */
export function encodeFeatureTables(featureTables: readonly FeatureTable[]): ArrayBuffer {
    const tile = concatenateBuffers(...featureTables.map(encodeFeatureTable));
    return tile.buffer as ArrayBuffer;
}

function encodeFeatureTable(featureTable: FeatureTable): Uint8Array {
    const columns: EncodedColumn[] = [];
    if (featureTable.idVector) {
        columns.push(encodeIdColumn(featureTable));
    }
    columns.push(encodeGeometryColumn(featureTable));
    for (const propertyVector of featureTable.propertyVectors ?? []) {
        if (propertyVector) {
            columns.push(encodePropertyColumn(propertyVector, featureTable.numFeatures));
        }
    }

    const metadata = concatenateBuffers(
        encodeFieldName(featureTable.name),
        encodeTypeCode(featureTable.extent),
        encodeChildCount(columns.length),
        ...columns.map((column) => column.metadata),
    );
    const block = concatenateBuffers(encodeTypeCode(1), metadata, ...columns.map((column) => column.data));
    return concatenateBuffers(encodeTypeCode(block.length), block);
}

function encodeIdColumn(featureTable: FeatureTable): EncodedColumn {
    const idVector = featureTable.idVector;
    const values: Array<number | bigint | null> = readValues(idVector, featureTable.numFeatures).map(
        (value): number | bigint | null => {
            if (value === null) return null;
            if (typeof value === "number" || typeof value === "bigint") {
                return value;
            }
            throw new Error(`ID column '${idVector.name}' contains a non-numeric value`);
        },
    );
    const nullable = values.some((value) => value === null);
    const longId =
        idVector.data instanceof BigInt64Array ||
        idVector.data instanceof BigUint64Array ||
        idVector.data instanceof Float64Array ||
        values.some((value) => value !== null && (typeof value === "bigint" || value < 0 || value > 0xffffffff));
    const streams: Uint8Array[] = [];
    if (nullable) {
        streams.push(encodePresentStream(values));
    }

    if (longId) {
        const ids = values
            .filter((value): value is number | bigint => value !== null)
            .map((value) => BigInt.asUintN(64, typeof value === "bigint" ? value : BigInt(Math.trunc(value))));
        streams.push(encodeUnsignedInt64Data(new BigUint64Array(ids)));
    } else {
        const ids = values
            .filter((value): value is number | bigint => value !== null)
            .map((value) => Number(value) >>> 0);
        streams.push(encodeUnsignedInt32Data(new Uint32Array(ids)));
    }

    return {
        metadata: encodeTypeCode((longId ? 2 : 0) + (nullable ? 1 : 0)),
        data: concatenateBuffers(...streams),
    };
}

function encodeGeometryColumn(featureTable: FeatureTable): EncodedColumn {
    const geometryVector = featureTable.geometryVector;
    if (!("getVertex" in geometryVector) || typeof geometryVector.getVertex !== "function") {
        throw new Error(`Cannot encode GPU-only geometry for FeatureTable '${featureTable.name}'`);
    }

    const cursor = new GeometryTopologyCursor(geometryVector);
    const geometryTypes = new Uint32Array(featureTable.numFeatures);
    const geometryLengths: number[] = [];
    const partLengths: number[] = [];
    const ringLengths: number[] = [];
    const vertices: number[] = [];
    const containsPolygon = geometryVector.containsPolygonGeometry();

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        const geometryType = geometryVector.geometryType(featureIndex);
        geometryTypes[featureIndex] = geometryType;
        const featureCursor = cursor.seek(featureIndex);
        let polygonCount = 0;
        let previousPolygonIndex = -1;
        let polygonRingCount = 0;

        featureCursor.forEachPart((_partIndex, start, end, _close, polygonIndex) => {
            const vertexCount = end - start;
            if (geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
                if (polygonIndex !== previousPolygonIndex) {
                    if (previousPolygonIndex >= 0) {
                        partLengths.push(polygonRingCount);
                    }
                    previousPolygonIndex = polygonIndex;
                    polygonRingCount = 0;
                    polygonCount++;
                }
                polygonRingCount++;
            }

            if (geometryType !== GEOMETRY_TYPE.POINT && geometryType !== GEOMETRY_TYPE.MULTIPOINT) {
                (containsPolygon ? ringLengths : partLengths).push(vertexCount);
            }

            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const [x, y] = geometryVector.getVertex(vertexIndex);
                vertices.push(Math.round(x), Math.round(y));
            }
        });

        if (previousPolygonIndex >= 0) {
            partLengths.push(polygonRingCount);
        }

        switch (geometryType) {
            case GEOMETRY_TYPE.MULTIPOINT:
            case GEOMETRY_TYPE.MULTILINESTRING:
                geometryLengths.push(featureCursor.partCount);
                break;
            case GEOMETRY_TYPE.MULTIPOLYGON:
                geometryLengths.push(polygonCount);
                break;
        }
    }

    const streams = [
        encodeUnsignedInt32Data(geometryTypes),
        ...(geometryLengths.length > 0 ? [encodeLengthStream(geometryLengths, LengthType.GEOMETRIES)] : []),
        ...(partLengths.length > 0 ? [encodeLengthStream(partLengths, LengthType.PARTS)] : []),
        ...(ringLengths.length > 0 ? [encodeLengthStream(ringLengths, LengthType.RINGS)] : []),
        encodeVertexData(new Int32Array(vertices)),
    ];

    return {
        metadata: encodeTypeCode(4),
        data: concatenateBuffers(encodeChildCount(streams.length), ...streams),
    };
}

function encodePropertyColumn(vector: Vector, numFeatures: number): EncodedColumn {
    if (vector.size !== numFeatures) {
        throw new Error(`Property column '${vector.name}' has ${vector.size} values, expected ${numFeatures}`);
    }

    const values = readValues(vector, numFeatures);
    const encoded = encodeScalarValues(vector, values);
    const metadata = concatenateBuffers(
        encodeTypeCode(scalarTypeCode(encoded.scalarType, encoded.nullable)),
        encodeFieldName(vector.name),
    );
    const hasStreamCount = encoded.scalarType === ScalarType.STRING;
    return {
        metadata,
        data: hasStreamCount ? concatenateBuffers(encodeChildCount(encoded.streamCount), encoded.data) : encoded.data,
    };
}

function encodeScalarValues(vector: Vector, values: unknown[]): EncodedScalar {
    const nullable = values.some((value) => value === null);
    const presentStream = nullable ? [encodePresentStream(values)] : [];
    const nonNullValues = values.filter((value) => value !== null);
    let scalarVector = vector;
    while (scalarVector instanceof IndexedVector) scalarVector = scalarVector.source;

    const compactInteger = encodeCompactIntegerVector(vector, nonNullValues.length);
    if (compactInteger) {
        return fixedScalar(compactInteger.scalarType, nullable, presentStream, compactInteger.data);
    }

    if (
        scalarVector instanceof StringFlatVector ||
        scalarVector instanceof StringDictionaryVector ||
        scalarVector instanceof StringFsstDictionaryVector ||
        (nonNullValues.length > 0 && nonNullValues.every((value) => typeof value === "string"))
    ) {
        const strings = values.map((value) => (value === null ? null : requireType(value, "string", vector.name)));
        const dictionary = scalarVector instanceof StringDictionaryVector || scalarVector instanceof StringFsstDictionaryVector;
        return {
            scalarType: ScalarType.STRING,
            nullable,
            streamCount: (dictionary ? 3 : 2) + (nullable ? 1 : 0),
            data: dictionary ? encodeDictionaryStrings(strings) : encodePlainStrings(strings),
        };
    }

    if (
        scalarVector instanceof BooleanFlatVector ||
        (nonNullValues.length > 0 && nonNullValues.every((value) => typeof value === "boolean"))
    ) {
        const booleans = nonNullValues.map((value) => requireType(value, "boolean", vector.name));
        const data = createStream(PhysicalStreamType.DATA, encodeBooleanRle(booleans), {
            logical: { dictionaryType: DictionaryType.NONE },
            technique: PhysicalLevelTechnique.VARINT,
            count: booleans.length,
        });
        return fixedScalar(ScalarType.BOOLEAN, nullable, presentStream, data);
    }

    if (scalarVector instanceof FloatFlatVector) {
        const numbers = nonNullValues.map((value) => requireType(value, "number", vector.name));
        const data = createStream(PhysicalStreamType.DATA, encodeFloatsLE(new Float32Array(numbers)), {
            logical: { dictionaryType: DictionaryType.NONE },
            count: numbers.length,
        });
        return fixedScalar(ScalarType.FLOAT, nullable, presentStream, data);
    }

    if (
        scalarVector instanceof DoubleFlatVector ||
        nonNullValues.some((value) => typeof value === "number" && !Number.isInteger(value))
    ) {
        const numbers = nonNullValues.map((value) => requireType(value, "number", vector.name));
        const data = createStream(PhysicalStreamType.DATA, encodeDoubleLE(new Float64Array(numbers)), {
            logical: { dictionaryType: DictionaryType.NONE },
            count: numbers.length,
        });
        return fixedScalar(ScalarType.DOUBLE, nullable, presentStream, data);
    }

    if (
        scalarVector.data instanceof BigInt64Array ||
        scalarVector.data instanceof BigUint64Array ||
        (nonNullValues.length > 0 && nonNullValues.every((value) => typeof value === "bigint"))
    ) {
        const signed = scalarVector.data instanceof BigInt64Array || nonNullValues.some((value) => (value as bigint) < 0n);
        const bigints = nonNullValues.map((value) => requireType(value, "bigint", vector.name));
        const data = signed
            ? encodeSignedInt64Data(new BigInt64Array(bigints.map((value) => BigInt.asIntN(64, value))))
            : encodeUnsignedInt64Data(new BigUint64Array(bigints.map((value) => BigInt.asUintN(64, value))));
        return fixedScalar(signed ? ScalarType.INT_64 : ScalarType.UINT_64, nullable, presentStream, data);
    }

    if (
        scalarVector.data instanceof Int32Array ||
        scalarVector.data instanceof Uint32Array ||
        (nonNullValues.length > 0 &&
            nonNullValues.every((value) => typeof value === "number" && Number.isInteger(value)))
    ) {
        const signed = scalarVector.data instanceof Int32Array || nonNullValues.some((value) => (value as number) < 0);
        const numbers = nonNullValues.map((value) => requireType(value, "number", vector.name));
        if (numbers.some((value) => !Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff)) {
            const data = createStream(PhysicalStreamType.DATA, encodeDoubleLE(new Float64Array(numbers)), {
                logical: { dictionaryType: DictionaryType.NONE },
                count: numbers.length,
            });
            return fixedScalar(ScalarType.DOUBLE, nullable, presentStream, data);
        }
        const data = signed
            ? encodeSignedInt32Data(new Int32Array(numbers))
            : encodeUnsignedInt32Data(new Uint32Array(numbers));
        return fixedScalar(signed ? ScalarType.INT_32 : ScalarType.UINT_32, nullable, presentStream, data);
    }

    throw new Error(`Unsupported values in property column '${vector.name}'`);
}

function encodeCompactIntegerVector(
    vector: Vector,
    nonNullValueCount: number,
): { scalarType: number; data: Uint8Array } | undefined {
    if (vector instanceof Int32ConstVector) {
        const signed = vector.data instanceof Int32Array;
        return {
            scalarType: signed ? ScalarType.INT_32 : ScalarType.UINT_32,
            data: encodeConstInt32Data(vector.getValue(0) ?? 0, nonNullValueCount, signed),
        };
    }
    if (vector instanceof Int64ConstVector) {
        const signed = vector.data instanceof BigInt64Array;
        return {
            scalarType: signed ? ScalarType.INT_64 : ScalarType.UINT_64,
            data: encodeConstInt64Data(vector.getValue(0) ?? 0n, nonNullValueCount, signed),
        };
    }
    if (vector instanceof Int32SequenceVector && vector.size > 1) {
        const base = vector.getValue(0);
        const delta = (vector.getValue(1) ?? 0) - (base ?? 0);
        if (base !== null && base === delta) {
            return {
                scalarType: ScalarType.INT_32,
                data: encodeSequenceInt32Data(delta, vector.size),
            };
        }
    }
    if (vector instanceof Int64SequenceVector && vector.size > 1) {
        const base = vector.getValue(0);
        const delta = (vector.getValue(1) ?? 0n) - (base ?? 0n);
        if (base !== null && base === delta) {
            return {
                scalarType: ScalarType.INT_64,
                data: encodeSequenceInt64Data(delta, vector.size),
            };
        }
    }
    return undefined;
}

function encodeConstInt32Data(value: number, size: number, signed: boolean): Uint8Array {
    const encodedValue = signed ? encodeZigZagInt32Value(value) : value >>> 0;
    return createRleStream(
        LogicalLevelTechnique.RLE,
        LogicalLevelTechnique.NONE,
        1,
        size,
        encodeVarintInt32(new Uint32Array([size, encodedValue])),
    );
}

function encodeConstInt64Data(value: bigint, size: number, signed: boolean): Uint8Array {
    const encodedValue = signed ? encodeZigZagInt64Value(value) : BigInt.asUintN(64, value);
    return createRleStream(
        LogicalLevelTechnique.RLE,
        LogicalLevelTechnique.NONE,
        1,
        size,
        encodeVarintInt64(new BigUint64Array([BigInt(size), encodedValue])),
    );
}

function encodeSequenceInt32Data(delta: number, size: number): Uint8Array {
    return createRleStream(
        LogicalLevelTechnique.DELTA,
        LogicalLevelTechnique.RLE,
        1,
        size,
        encodeVarintInt32(new Uint32Array([size, encodeZigZagInt32Value(delta)])),
    );
}

function encodeSequenceInt64Data(delta: bigint, size: number): Uint8Array {
    return createRleStream(
        LogicalLevelTechnique.DELTA,
        LogicalLevelTechnique.RLE,
        1,
        size,
        encodeVarintInt64(new BigUint64Array([BigInt(size), encodeZigZagInt64Value(delta)])),
    );
}

function fixedScalar(
    scalarType: number,
    nullable: boolean,
    presentStream: Uint8Array[],
    dataStream: Uint8Array,
): EncodedScalar {
    return {
        scalarType,
        nullable,
        streamCount: presentStream.length + 1,
        data: concatenateBuffers(...presentStream, dataStream),
    };
}

function encodePresentStream(values: unknown[]): Uint8Array {
    const present = values.map((value) => value !== null);
    return createStream(PhysicalStreamType.PRESENT, encodeBooleanRle(present), {
        technique: PhysicalLevelTechnique.VARINT,
        count: present.length,
    });
}

function encodeUnsignedInt32Data(values: Uint32Array): Uint8Array {
    return createStream(PhysicalStreamType.DATA, encodeVarintInt32(values), {
        logical: { dictionaryType: DictionaryType.NONE },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function encodeSignedInt32Data(values: Int32Array): Uint8Array {
    return createStream(PhysicalStreamType.DATA, encodeVarintInt32(encodeZigZagInt32(values)), {
        logical: { dictionaryType: DictionaryType.NONE },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function encodeUnsignedInt64Data(values: BigUint64Array): Uint8Array {
    return createStream(PhysicalStreamType.DATA, encodeVarintInt64(values), {
        logical: { dictionaryType: DictionaryType.NONE },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function encodeSignedInt64Data(values: BigInt64Array): Uint8Array {
    return createStream(PhysicalStreamType.DATA, encodeVarintInt64(encodeZigZagInt64(values)), {
        logical: { dictionaryType: DictionaryType.NONE },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function encodeLengthStream(lengths: number[], lengthType: LengthType): Uint8Array {
    const values = new Uint32Array(lengths);
    return createStream(PhysicalStreamType.LENGTH, encodeVarintInt32(values), {
        logical: { lengthType },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function encodeVertexData(vertices: Int32Array): Uint8Array {
    return createStream(PhysicalStreamType.DATA, encodeVarintInt32(encodeZigZagInt32(vertices)), {
        logical: { dictionaryType: DictionaryType.VERTEX },
        technique: PhysicalLevelTechnique.VARINT,
        count: vertices.length,
    });
}

function createStream(
    physicalStreamType: PhysicalStreamType,
    data: Uint8Array,
    options: {
        logical?: LogicalStreamType;
        technique?: PhysicalLevelTechnique;
        count?: number;
    } = {},
): Uint8Array {
    const count = options.count ?? 0;
    const metadata: StreamMetadata = {
        physicalStreamType,
        logicalStreamType: options.logical ?? {},
        logicalLevelTechnique1: LogicalLevelTechnique.NONE,
        logicalLevelTechnique2: LogicalLevelTechnique.NONE,
        physicalLevelTechnique: options.technique ?? PhysicalLevelTechnique.NONE,
        numValues: count,
        byteLength: data.length,
        decompressedCount: count,
    };
    return concatenateBuffers(encodeStreamMetadata(metadata), data);
}

function createRleStream(
    logicalLevelTechnique1: LogicalLevelTechnique,
    logicalLevelTechnique2: LogicalLevelTechnique,
    runs: number,
    numRleValues: number,
    data: Uint8Array,
): Uint8Array {
    const metadata: RleEncodedStreamMetadata = {
        physicalStreamType: PhysicalStreamType.DATA,
        logicalStreamType: { dictionaryType: DictionaryType.NONE },
        logicalLevelTechnique1,
        logicalLevelTechnique2,
        physicalLevelTechnique: PhysicalLevelTechnique.VARINT,
        numValues: runs * 2,
        byteLength: data.length,
        decompressedCount: numRleValues,
        runs,
        numRleValues,
    };
    return concatenateBuffers(encodeStreamMetadata(metadata), data);
}

function encodeStreamMetadata(metadata: StreamMetadata | RleEncodedStreamMetadata): Uint8Array {
    const buffer = new Uint8Array(32);
    let writeOffset = 0;
    const physicalTypeIndex = Object.values(PhysicalStreamType).indexOf(metadata.physicalStreamType);
    buffer[writeOffset++] = (physicalTypeIndex << 4) | getLogicalSubtypeValue(metadata);

    const llt1Index = Object.values(LogicalLevelTechnique).indexOf(metadata.logicalLevelTechnique1);
    const llt2Index = Object.values(LogicalLevelTechnique).indexOf(metadata.logicalLevelTechnique2);
    const pltIndex = Object.values(PhysicalLevelTechnique).indexOf(metadata.physicalLevelTechnique);
    buffer[writeOffset++] = (llt1Index << 5) | (llt2Index << 2) | pltIndex;

    const offset = new IntWrapper(writeOffset);
    encodeVarintInt32Value(metadata.numValues, buffer, offset);
    encodeVarintInt32Value(metadata.byteLength, buffer, offset);
    if ("runs" in metadata) {
        encodeVarintInt32Value(metadata.runs, buffer, offset);
        encodeVarintInt32Value(metadata.numRleValues, buffer, offset);
    }
    return buffer.slice(0, offset.get());
}

function getLogicalSubtypeValue(metadata: StreamMetadata): number {
    switch (metadata.physicalStreamType) {
        case PhysicalStreamType.DATA:
            return metadata.logicalStreamType.dictionaryType === undefined
                ? 0
                : Object.values(DictionaryType).indexOf(metadata.logicalStreamType.dictionaryType);
        case PhysicalStreamType.LENGTH:
            return metadata.logicalStreamType.lengthType === undefined
                ? 0
                : Object.values(LengthType).indexOf(metadata.logicalStreamType.lengthType);
        default:
            return 0;
    }
}

function readValues(vector: Vector, size: number): unknown[] {
    return Array.from({ length: size }, (_value, index) => vector.getValue(index));
}

function requireType<T extends "bigint" | "boolean" | "number" | "string">(
    value: unknown,
    expectedType: T,
    columnName: string,
): T extends "bigint" ? bigint : T extends "boolean" ? boolean : T extends "number" ? number : string {
    if (typeof value !== expectedType) {
        throw new Error(`Property column '${columnName}' mixes incompatible scalar types`);
    }
    return value as never;
}
