import { GeometryVector, type MortonSettings, type VertexBuffer, type VertexOffsets } from "./geometryVector";
import { GEOMETRY_TYPE } from "./geometryType";
import { VertexBufferType } from "./vertexBufferType";
import type { TopologyVector } from "../../vector/geometry/topologyVector";

export function createConstGeometryVector(
    numGeometries: number,
    geometryType: number,
    topologyVector: TopologyVector,
    vertexOffsets: VertexOffsets | undefined,
    vertexBuffer: VertexBuffer,
): ConstGeometryVector {
    return new ConstGeometryVector(
        numGeometries,
        geometryType,
        VertexBufferType.VEC_2,
        topologyVector,
        vertexOffsets,
        vertexBuffer,
    );
}

export function createMortonEncodedConstGeometryVector(
    numGeometries: number,
    geometryType: number,
    topologyVector: TopologyVector,
    vertexOffsets: VertexOffsets | undefined,
    vertexBuffer: VertexBuffer,
    mortonInfo: MortonSettings,
): ConstGeometryVector {
    return new ConstGeometryVector(
        numGeometries,
        geometryType,
        VertexBufferType.MORTON,
        topologyVector,
        vertexOffsets,
        vertexBuffer,
        mortonInfo,
    );
}

export class ConstGeometryVector extends GeometryVector {
    constructor(
        private readonly _numGeometries: number,
        private readonly _geometryType: number,
        vertexBufferType: VertexBufferType,
        topologyVector: TopologyVector,
        vertexOffsets: VertexOffsets | undefined,
        vertexBuffer: VertexBuffer,
        mortonSettings?: MortonSettings,
    ) {
        super(vertexBufferType, topologyVector, vertexOffsets, vertexBuffer, mortonSettings);
    }

    geometryType(_index: number): number {
        return this._geometryType;
    }

    get numGeometries(): number {
        return this._numGeometries;
    }

    containsPolygonGeometry(): boolean {
        return this._geometryType === GEOMETRY_TYPE.POLYGON || this._geometryType === GEOMETRY_TYPE.MULTIPOLYGON;
    }

    containsSingleGeometryType(): boolean {
        return true;
    }
}
