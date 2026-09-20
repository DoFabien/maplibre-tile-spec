import FeatureTable from "./vector/featureTable";
import { type Column, ComplexType, ScalarType } from "./metadata/tileset/tilesetMetadata";
import IntWrapper from "./decoding/intWrapper";
import { decodeStreamMetadata, type RleEncodedStreamMetadata } from "./metadata/tile/streamMetadataDecoder";
import { VectorType } from "./vector/vectorType";
import { Int32FlatVector } from "./vector/flat/int32FlatVector";
import BitVector from "./vector/flat/bitVector";
import {
    decodeUnsignedConstInt32Stream,
    decodeUnsignedConstInt64Stream,
    decodeUnsignedInt64AsFloat64Stream,
    decodeUnsignedInt32Stream,
    decodeUnsignedInt64Stream,
    decodeSequenceInt32Stream,
    decodeSequenceInt64Stream,
    getVectorType,
} from "./decoding/integerStreamDecoder";
import { Int32SequenceVector } from "./vector/sequence/int32SequenceVector";
import { Int64FlatVector } from "./vector/flat/int64FlatVector";
import { Int64SequenceVector } from "./vector/sequence/int64SequenceVector";
import type { IdVector } from "./vector/idVector";
import { decodeVarintInt32 } from "./decoding/integerDecodingUtils";
import { decodeGeometryColumn } from "./decoding/geometryDecoder";
import { decodePropertyColumn } from "./decoding/propertyDecoder";
import { Int32ConstVector } from "./vector/constant/int32ConstVector";
import { Int64ConstVector } from "./vector/constant/int64ConstVector";
import type GeometryScaling from "./decoding/geometryScaling";
import { decodeBooleanRle } from "./decoding/decodingUtils";
import { DoubleFlatVector } from "./vector/flat/doubleFlatVector";
import { decodeEmbeddedTileSetMetadata } from "./metadata/tileset/embeddedTilesetMetadataDecoder";
import { hasStreamCount, isGeometryColumn, isLogicalIdColumn } from "./metadata/tileset/typeMap";
import type { StreamMetadata } from "./metadata/tile/streamMetadataDecoder";
import type { GeometryVector } from "./vector/geometry/geometryVector";
import type Vector from "./vector/vector";
import type { GpuVector } from "./vector/geometry/gpuVector";
import type { PhysicalLevelTechnique } from "./metadata/tile/physicalLevelTechnique";
import { PhysicalStreamType } from "./metadata/tile/physicalStreamType";
import { DictionaryType } from "./metadata/tile/dictionaryType";

export type DecodeTileOptions = {
    layerNames?: ReadonlySet<string> | readonly string[];
    propertyColumnNamesByLayer?:
        | ReadonlyMap<string, ReadonlySet<string> | null>
        | Record<string, ReadonlySet<string> | readonly string[] | null>;
};

export type TileLayerIndexEntry = {
    name: string;
    extent: number;
    blockStart: number;
    blockEnd: number;
};

export type TilePhysicalTechniqueEntry = {
    layerName: string;
    columnName: string;
    streamIndex: number;
    technique: PhysicalLevelTechnique;
    encodedBytes: number;
};

export function scanTileLayers(
    tile: Uint8Array,
    options: Pick<DecodeTileOptions, "layerNames"> = {},
): TileLayerIndexEntry[] {
    const offset = new IntWrapper(0);
    const layers: TileLayerIndexEntry[] = [];
    const layerNameFilter = normalizeLayerNameFilter(options.layerNames);

    while (offset.get() < tile.length) {
        const blockLength = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        const blockStart = offset.get();
        const blockEnd = blockStart + blockLength;
        if (blockEnd > tile.length) {
            throw new Error(`Block overruns tile: ${blockEnd} > ${tile.length}`);
        }

        const tag = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        if (tag === 1) {
            const [metadata, extent] = decodeEmbeddedTileSetMetadata(tile, offset);
            const layerName = metadata.featureTables[0].name ?? "";
            if (!layerNameFilter || layerNameFilter.has(layerName)) {
                layers.push({
                    name: layerName,
                    extent,
                    blockStart,
                    blockEnd,
                });
            }
        }

        offset.set(blockEnd);
    }

    return layers;
}

/**
 * Reads stream metadata without decoding stream values. This is intended for
 * corpus validation and diagnostics, where callers need to prove which
 * physical integer encoding a tile actually contains.
 */
export function scanTilePhysicalTechniques(
    tile: Uint8Array,
    options: Pick<DecodeTileOptions, "layerNames"> = {},
): TilePhysicalTechniqueEntry[] {
    const offset = new IntWrapper(0);
    const result: TilePhysicalTechniqueEntry[] = [];
    const layerNameFilter = normalizeLayerNameFilter(options.layerNames);

    while (offset.get() < tile.length) {
        const blockLength = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        const blockStart = offset.get();
        const blockEnd = blockStart + blockLength;
        if (blockEnd > tile.length) {
            throw new Error(`Block overruns tile: ${blockEnd} > ${tile.length}`);
        }

        const tag = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        if (tag !== 1) {
            offset.set(blockEnd);
            continue;
        }

        const [metadata] = decodeEmbeddedTileSetMetadata(tile, offset);
        const featureTableMetadata = metadata.featureTables[0];
        const layerName = featureTableMetadata.name ?? "";
        if (layerNameFilter && !layerNameFilter.has(layerName)) {
            offset.set(blockEnd);
            continue;
        }

        for (const columnMetadata of featureTableMetadata.columns) {
            const columnName =
                columnMetadata.name ??
                (isLogicalIdColumn(columnMetadata) ? "id" : isGeometryColumn(columnMetadata) ? "geometry" : "");
            const numStreams = hasStreamCount(columnMetadata)
                ? decodeVarintInt32(tile, offset, 1)[0]
                : columnMetadata.nullable
                  ? 2
                  : 1;

            if (isStructColumn(columnMetadata)) {
                scanStructColumnPhysicalTechniques(
                    tile,
                    offset,
                    blockEnd,
                    layerName,
                    columnName,
                    columnMetadata,
                    numStreams,
                    result,
                );
                continue;
            }

            for (let streamIndex = 0; streamIndex < numStreams; streamIndex++) {
                scanPhysicalTechniqueEntry(tile, offset, blockEnd, layerName, columnName, streamIndex, result);
            }
        }

        if (offset.get() > blockEnd) {
            throw new Error(`Stream metadata overruns layer block: ${offset.get()} > ${blockEnd}`);
        }
        offset.set(blockEnd);
    }

    return result;
}

function scanStructColumnPhysicalTechniques(
    tile: Uint8Array,
    offset: IntWrapper,
    blockEnd: number,
    layerName: string,
    columnName: string,
    columnMetadata: Column,
    numStreams: number,
    result: TilePhysicalTechniqueEntry[],
): void {
    let scannedStreams = 0;
    let dictionaryStreamDecoded = false;

    while (!dictionaryStreamDecoded) {
        if (scannedStreams >= numStreams) {
            throw new Error(`Shared dictionary data stream missing from column '${columnName}'`);
        }
        const streamMetadata = scanPhysicalTechniqueEntry(
            tile,
            offset,
            blockEnd,
            layerName,
            columnName,
            scannedStreams++,
            result,
        );
        dictionaryStreamDecoded =
            streamMetadata.physicalStreamType === PhysicalStreamType.DATA &&
            (streamMetadata.logicalStreamType.dictionaryType === DictionaryType.SINGLE ||
                streamMetadata.logicalStreamType.dictionaryType === DictionaryType.SHARED);
    }

    for (const child of columnMetadata.complexType?.children ?? []) {
        if (child.type !== "scalarField") {
            throw new Error(`Nested complex field '${columnName}${child.name ?? ""}' is not supported`);
        }
        const childStreamCount = decodeVarintInt32(tile, offset, 1)[0];
        const childColumnName = `${columnName}${child.name ?? ""}`;
        for (let streamIndex = 0; streamIndex < childStreamCount; streamIndex++) {
            scanPhysicalTechniqueEntry(tile, offset, blockEnd, layerName, childColumnName, streamIndex, result);
            scannedStreams++;
        }
    }

    if (scannedStreams !== numStreams) {
        throw new Error(`Column '${columnName}' declares ${numStreams} streams but contains ${scannedStreams}`);
    }
}

function scanPhysicalTechniqueEntry(
    tile: Uint8Array,
    offset: IntWrapper,
    blockEnd: number,
    layerName: string,
    columnName: string,
    streamIndex: number,
    result: TilePhysicalTechniqueEntry[],
): StreamMetadata {
    const streamMetadata = decodeStreamMetadata(tile, offset);
    const streamEnd = offset.get() + streamMetadata.byteLength;
    if (streamEnd > blockEnd) {
        throw new Error(`Stream overruns layer block: ${streamEnd} > ${blockEnd}`);
    }
    result.push({
        layerName,
        columnName,
        streamIndex,
        technique: streamMetadata.physicalLevelTechnique,
        encodedBytes: streamMetadata.byteLength,
    });
    offset.set(streamEnd);
    return streamMetadata;
}

function isStructColumn(column: Column): boolean {
    return (
        column.type === "complexType" &&
        column.complexType?.type === "physicalType" &&
        column.complexType.physicalType === ComplexType.STRUCT
    );
}

export function decodeTileLayer(
    tile: Uint8Array,
    layer: TileLayerIndexEntry,
    geometryScaling?: GeometryScaling,
    idWithinMaxSafeInteger = true,
    options: Pick<DecodeTileOptions, "propertyColumnNamesByLayer"> = {},
): FeatureTable {
    const offset = new IntWrapper(layer.blockStart);
    const tag = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
    if (tag !== 1) {
        throw new Error(`Expected MLT layer block tag 1, got ${tag}`);
    }

    const [metadata, extent] = decodeEmbeddedTileSetMetadata(tile, offset);
    const featureTableMetadata = metadata.featureTables[0];
    if ((featureTableMetadata.name ?? "") !== layer.name) {
        throw new Error(`MLT layer index mismatch: expected '${layer.name}', got '${featureTableMetadata.name ?? ""}'`);
    }

    return decodeFeatureTable(
        tile,
        offset,
        featureTableMetadata,
        extent,
        geometryScaling,
        idWithinMaxSafeInteger,
        options.propertyColumnNamesByLayer,
    );
}

/**
 * Decodes a tile with embedded metadata (Tag 0x01 format).
 * This is the primary decoder function for MLT tiles.
 *
 * @param tile The tile data to decode (will be decompressed if gzip-compressed)
 * @param geometryScaling Optional geometry scaling parameters
 * @param idWithinMaxSafeInteger If true, limits ID values to JavaScript safe integer range (53 bits)
 */
export default function decodeTile(
    tile: Uint8Array,
    geometryScaling?: GeometryScaling,
    idWithinMaxSafeInteger = true,
    options: DecodeTileOptions = {},
): FeatureTable[] {
    const offset = new IntWrapper(0);
    const featureTables: FeatureTable[] = [];
    const layerNameFilter = normalizeLayerNameFilter(options.layerNames);

    while (offset.get() < tile.length) {
        const blockLength = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        const blockStart = offset.get();
        const blockEnd = blockStart + blockLength;
        if (blockEnd > tile.length) {
            throw new Error(`Block overruns tile: ${blockEnd} > ${tile.length}`);
        }

        const tag = decodeVarintInt32(tile, offset, 1)[0] >>> 0;
        if (tag !== 1 && tag !== 2) {
            // Skip unknown block types
            offset.set(blockEnd);
            continue;
        }

        const [metadata, extent] = decodeEmbeddedTileSetMetadata(tile, offset);
        const featureTableMetadata = metadata.featureTables[0];
        if (layerNameFilter && !layerNameFilter.has(featureTableMetadata.name)) {
            offset.set(blockEnd);
            continue;
        }
        featureTables.push(
            decodeFeatureTable(
                tile,
                offset,
                featureTableMetadata,
                extent,
                geometryScaling,
                idWithinMaxSafeInteger,
                options.propertyColumnNamesByLayer,
            ),
        );
        offset.set(blockEnd);
    }

    return featureTables;
}

function decodeFeatureTable(
    tile: Uint8Array,
    offset: IntWrapper,
    featureTableMetadata: { name?: string | null; columns: Column[] },
    extent: number,
    geometryScaling: GeometryScaling | undefined,
    idWithinMaxSafeInteger: boolean,
    propertyColumnNamesByLayer: DecodeTileOptions["propertyColumnNamesByLayer"],
): FeatureTable {
    const layerName = featureTableMetadata.name ?? "";
    const propertyColumnNames = getPropertyColumnNameFilter(propertyColumnNamesByLayer, layerName);

    let idVector: IdVector | null = null;
    let geometryVector: GeometryVector | GpuVector | null = null;
    const propertyVectors: Vector[] = [];
    const deferredPropertyColumns = new Map<string, DeferredPropertyColumn>();
    let numFeatures = 0;

    for (const columnMetadata of featureTableMetadata.columns) {
        const columnName = columnMetadata.name;

        if (isLogicalIdColumn(columnMetadata)) {
            let nullabilityBuffer = null;
            // Check column metadata nullable flag, not numStreams (ID columns don't have stream count)
            if (columnMetadata.nullable) {
                const presentStreamMetadata = decodeStreamMetadata(tile, offset);
                const streamDataStart = offset.get();
                const values = decodeBooleanRle(
                    tile,
                    presentStreamMetadata.numValues,
                    presentStreamMetadata.byteLength,
                    offset,
                );
                offset.set(streamDataStart + presentStreamMetadata.byteLength);
                nullabilityBuffer = new BitVector(values, presentStreamMetadata.numValues);
            }

            const idDataStreamMetadata = decodeStreamMetadata(tile, offset);
            // decompressedCount is the count WITHOUT nulls, but we may have nulls
            numFeatures = nullabilityBuffer ? nullabilityBuffer.size() : idDataStreamMetadata.decompressedCount;

            idVector = decodeIdColumn(
                tile,
                columnMetadata,
                offset,
                columnName,
                idDataStreamMetadata,
                nullabilityBuffer ?? numFeatures,
                idWithinMaxSafeInteger,
            );
        } else if (isGeometryColumn(columnMetadata)) {
            const numStreams = decodeVarintInt32(tile, offset, 1)[0];

            // If no ID column, get numFeatures from geometry type stream metadata
            if (numFeatures === 0) {
                const savedOffset = offset.get();
                const geometryTypeMetadata = decodeStreamMetadata(tile, offset);
                numFeatures = geometryTypeMetadata.decompressedCount;
                offset.set(savedOffset); // Reset to re-read in decodeGeometryColumn
            }

            if (geometryScaling) {
                geometryScaling.scale = geometryScaling.extent / extent;
            }

            geometryVector = decodeGeometryColumn(tile, numStreams, offset, numFeatures, geometryScaling);
        } else {
            const columnHasStreamCount = hasStreamCount(columnMetadata);
            const numStreams = columnHasStreamCount
                ? decodeVarintInt32(tile, offset, 1)[0]
                : columnMetadata.nullable
                  ? 2
                  : 1;

            if (numStreams === 0) {
                continue;
            }

            const columnDataOffset = offset.get();
            if (propertyColumnNames !== undefined) {
                const deferredColumn = { columnMetadata, numStreams, columnDataOffset };
                for (const propertyName of getColumnPropertyNames(columnMetadata)) {
                    deferredPropertyColumns.set(propertyName, deferredColumn);
                }
            }

            const propertyVector = decodePropertyColumn(
                tile,
                offset,
                columnMetadata,
                numStreams,
                numFeatures,
                propertyColumnNames,
            );
            if (propertyVector) {
                if (Array.isArray(propertyVector)) {
                    for (const property of propertyVector) {
                        propertyVectors.push(property);
                    }
                } else {
                    propertyVectors.push(propertyVector);
                }
            }
        }
    }

    return new FeatureTable(
        layerName,
        geometryVector,
        idVector,
        propertyVectors,
        extent,
        deferredPropertyColumns.size === 0
            ? undefined
            : (propertyName) =>
                  decodeDeferredPropertyColumn(
                      tile,
                      deferredPropertyColumns.get(propertyName),
                      propertyName,
                      numFeatures,
                  ),
        deferredPropertyColumns.size === 0 ? undefined : Array.from(deferredPropertyColumns.keys()),
    );
}

type DeferredPropertyColumn = {
    columnMetadata: Column;
    numStreams: number;
    columnDataOffset: number;
};

function decodeDeferredPropertyColumn(
    tile: Uint8Array,
    deferredColumn: DeferredPropertyColumn | undefined,
    propertyName: string,
    numFeatures: number,
): Vector | Vector[] | undefined {
    if (!deferredColumn) return undefined;

    return (
        decodePropertyColumn(
            tile,
            new IntWrapper(deferredColumn.columnDataOffset),
            deferredColumn.columnMetadata,
            deferredColumn.numStreams,
            numFeatures,
            new Set([propertyName]),
        ) ?? undefined
    );
}

function getColumnPropertyNames(columnMetadata: Column): string[] {
    if (columnMetadata.type === "scalarType") {
        return columnMetadata.name ? [columnMetadata.name] : [];
    }

    const columnName = columnMetadata.name ?? "";
    return (columnMetadata.complexType?.children ?? [])
        .map((child) => (child.name ? `${columnName}${child.name}` : columnName))
        .filter((propertyName) => propertyName.length > 0);
}

function normalizeLayerNameFilter(
    layerNames?: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> | undefined {
    if (!layerNames) {
        return undefined;
    }

    return layerNames instanceof Set ? layerNames : new Set(layerNames);
}

function getPropertyColumnNameFilter(
    propertyColumnNamesByLayer: DecodeTileOptions["propertyColumnNamesByLayer"],
    layerName: string,
): Set<string> | undefined {
    if (!propertyColumnNamesByLayer) {
        return undefined;
    }

    const rawNames =
        propertyColumnNamesByLayer instanceof Map
            ? propertyColumnNamesByLayer.get(layerName)
            : propertyColumnNamesByLayer[layerName];
    if (rawNames === undefined || rawNames === null) {
        return undefined;
    }

    return rawNames instanceof Set ? new Set(rawNames) : new Set(rawNames);
}

function decodeIdColumn(
    tile: Uint8Array,
    columnMetadata: Column,
    offset: IntWrapper,
    columnName: string,
    idDataStreamMetadata: StreamMetadata,
    sizeOrNullabilityBuffer: number | BitVector,
    idWithinMaxSafeInteger = false,
): IdVector {
    const idDataType = columnMetadata.scalarType?.longID ? ScalarType.UINT_64 : ScalarType.UINT_32;
    const nullabilityBuffer = typeof sizeOrNullabilityBuffer === "number" ? undefined : sizeOrNullabilityBuffer;

    const vectorType = getVectorType(
        idDataStreamMetadata,
        sizeOrNullabilityBuffer,
        tile,
        offset,
        idDataType === ScalarType.UINT_64 ? "int64" : "int32",
    );
    if (idDataType === ScalarType.UINT_32) {
        switch (vectorType) {
            case VectorType.FLAT: {
                const id = decodeUnsignedInt32Stream(tile, offset, idDataStreamMetadata, undefined, nullabilityBuffer);
                return new Int32FlatVector(columnName, id, sizeOrNullabilityBuffer);
            }
            case VectorType.SEQUENCE: {
                const id = decodeSequenceInt32Stream(tile, offset, idDataStreamMetadata);
                return new Int32SequenceVector(
                    columnName,
                    id[0],
                    id[1],
                    (idDataStreamMetadata as RleEncodedStreamMetadata).numRleValues,
                    false,
                );
            }
            case VectorType.CONST: {
                const id = decodeUnsignedConstInt32Stream(tile, offset, idDataStreamMetadata);
                return new Int32ConstVector(columnName, id, sizeOrNullabilityBuffer, false);
            }
        }
    }
    switch (vectorType) {
        case VectorType.FLAT: {
            if (idWithinMaxSafeInteger) {
                const id = decodeUnsignedInt64AsFloat64Stream(tile, offset, idDataStreamMetadata, nullabilityBuffer);
                return new DoubleFlatVector(columnName, id, sizeOrNullabilityBuffer);
            }
            const id = decodeUnsignedInt64Stream(tile, offset, idDataStreamMetadata, nullabilityBuffer);
            return new Int64FlatVector(columnName, id, sizeOrNullabilityBuffer);
        }
        case VectorType.SEQUENCE: {
            const id = decodeSequenceInt64Stream(tile, offset, idDataStreamMetadata);
            return new Int64SequenceVector(
                columnName,
                id[0],
                id[1],
                (idDataStreamMetadata as RleEncodedStreamMetadata).numRleValues,
                false,
            );
        }
        case VectorType.CONST: {
            const id = decodeUnsignedConstInt64Stream(tile, offset, idDataStreamMetadata);
            return new Int64ConstVector(columnName, id, sizeOrNullabilityBuffer, false);
        }
    }

    throw new Error("Vector type not supported for id column.");
}
