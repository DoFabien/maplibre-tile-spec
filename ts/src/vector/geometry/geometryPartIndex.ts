import { GEOMETRY_TYPE } from "./geometryType";

type OffsetArray = Uint32Array | Int32Array | null | undefined;

/** The topology of a geometry vector, whether its vertices are plain or pre-tessellated. */
export type TopologyGeometryVector = {
    readonly numGeometries: number;
    readonly topologyVector?: {
        readonly geometryOffsets?: OffsetArray;
        readonly partOffsets?: OffsetArray;
        readonly ringOffsets?: OffsetArray;
    } | null;
    geometryType(index: number): number;
};

/**
 * The parts of the features of a geometry vector: points, line strings and polygon rings, each a range of
 * consecutive vertices. The parts of feature `i` are `featureParts[i]` to `featureParts[i + 1]`, and part `j`
 * spans the vertices `partVertices[j]` to `partVertices[j + 1]`. The rings of polygons are not closed: their
 * last vertex is not a copy of the first.
 */
export type GeometryPartIndex = {
    readonly featureParts: Uint32Array;
    readonly partVertices: Uint32Array;
};

function hasOffsets(offsets: OffsetArray): offsets is Uint32Array | Int32Array {
    return ArrayBuffer.isView(offsets) && offsets.length > 0;
}

/** The size of the range ending at `offsetIndex` of an offset stream. */
function offsetDiff(offsets: OffsetArray, offsetIndex: number, name: string): number {
    if (!hasOffsets(offsets) || offsetIndex <= 0 || offsetIndex >= offsets.length) {
        throw new Error(`Geometry topology requires ${name} offsets at index ${offsetIndex}`);
    }
    return offsets[offsetIndex] - offsets[offsetIndex - 1];
}

function isPolygon(geometryType: number): boolean {
    return geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON;
}

/**
 * Indexes the parts of every feature of a geometry vector in one pass over its offset streams. A vector with
 * polygons counts the vertices of its line strings in its ring offsets, and one without in its part offsets.
 */
export function createGeometryPartIndex(geometryVector: TopologyGeometryVector): GeometryPartIndex {
    const { geometryOffsets, partOffsets, ringOffsets } = geometryVector.topologyVector ?? {};
    const hasGeometryOffsets = hasOffsets(geometryOffsets);
    let hasPolygons = false;
    for (let i = 0; i < geometryVector.numGeometries && !hasPolygons; i++) {
        hasPolygons = isPolygon(geometryVector.geometryType(i));
    }

    const featureParts = new Uint32Array(geometryVector.numGeometries + 1);
    const partVertices: number[] = [];
    let geometryOffset = 1;
    let partOffset = 1;
    let ringOffset = 1;
    let vertex = 0;
    function addPart(vertexCount: number): void {
        partVertices.push(vertex);
        vertex += vertexCount;
    }
    function lineVertexCount(): number {
        const count = hasPolygons
            ? offsetDiff(ringOffsets, ringOffset++, "ring")
            : offsetDiff(partOffsets, partOffset, "part");
        partOffset++;
        return count;
    }
    function addRings(): void {
        const ringCount = offsetDiff(partOffsets, partOffset++, "part");
        for (let ring = 0; ring < ringCount; ring++) addPart(offsetDiff(ringOffsets, ringOffset++, "ring"));
    }

    for (let featureIndex = 0; featureIndex < geometryVector.numGeometries; featureIndex++) {
        featureParts[featureIndex] = partVertices.length;
        switch (geometryVector.geometryType(featureIndex)) {
            case GEOMETRY_TYPE.POINT:
                addPart(1);
                if (hasGeometryOffsets) geometryOffset++;
                if (hasOffsets(partOffsets)) partOffset++;
                if (hasOffsets(ringOffsets)) ringOffset++;
                break;
            case GEOMETRY_TYPE.MULTIPOINT: {
                const pointCount = offsetDiff(geometryOffsets, geometryOffset++, "geometry");
                for (let point = 0; point < pointCount; point++) addPart(1);
                partOffset += pointCount;
                ringOffset += pointCount;
                break;
            }
            case GEOMETRY_TYPE.LINESTRING:
                addPart(lineVertexCount());
                if (hasGeometryOffsets) geometryOffset++;
                break;
            case GEOMETRY_TYPE.POLYGON:
                addRings();
                if (hasGeometryOffsets) geometryOffset++;
                break;
            case GEOMETRY_TYPE.MULTILINESTRING: {
                const lineCount = hasGeometryOffsets
                    ? offsetDiff(geometryOffsets, geometryOffset++, "geometry")
                    : offsetDiff(partOffsets, partOffset, "part");
                for (let line = 0; line < lineCount; line++) addPart(lineVertexCount());
                break;
            }
            case GEOMETRY_TYPE.MULTIPOLYGON: {
                const polygonCount = offsetDiff(geometryOffsets, geometryOffset++, "geometry");
                for (let polygon = 0; polygon < polygonCount; polygon++) addRings();
                break;
            }
            default:
                throw new Error(`Unsupported MLT geometry type: ${geometryVector.geometryType(featureIndex)}`);
        }
    }
    featureParts[geometryVector.numGeometries] = partVertices.length;
    partVertices.push(vertex);
    return { featureParts, partVertices: Uint32Array.from(partVertices) };
}
