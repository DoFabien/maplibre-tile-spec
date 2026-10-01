import { GEOMETRY_TYPE } from "./geometryType";

type OffsetArray = Uint32Array | Int32Array | null | undefined;

export type TopologyGeometryVector = {
    readonly numGeometries: number;
    readonly topologyVector?: {
        readonly geometryOffsets?: OffsetArray;
        readonly partOffsets?: OffsetArray;
        readonly ringOffsets?: OffsetArray;
    } | null;
    geometryType(index: number): number;
    containsPolygonGeometry?: () => boolean;
};

export type GeometryPartVisitor = (
    partIndex: number,
    start: number,
    end: number,
    close: boolean,
    polygonIndex: number,
) => void;

function hasOffsets(offsets: OffsetArray): offsets is Uint32Array | Int32Array {
    return ArrayBuffer.isView(offsets) && offsets.length > 0;
}

function requireOffsetDiff(offsets: OffsetArray, offsetIndex: number, name: string): number {
    if (!hasOffsets(offsets) || offsetIndex <= 0 || offsetIndex >= offsets.length) {
        throw new Error(`Geometry traversal requires ${name} offsets at index ${offsetIndex}`);
    }

    return offsets[offsetIndex] - offsets[offsetIndex - 1];
}

function containsPolygonGeometry(geometryVector: TopologyGeometryVector): boolean {
    if (typeof geometryVector.containsPolygonGeometry === "function") {
        return geometryVector.containsPolygonGeometry();
    }

    for (let featureIndex = 0; featureIndex < geometryVector.numGeometries; featureIndex++) {
        const geometryType = geometryVector.geometryType(featureIndex);
        if (geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
            return true;
        }
    }

    return false;
}

/**
 * Allocation-free cursor over MLT topology ranges.
 *
 * Forward seeks continue from the current topology offsets. Backward seeks
 * step back through the compact offset streams, or replay them from the first
 * feature when it is closer, without retaining a per-feature range index. The cursor itself is also the reusable view of a selected part.
 */
export class GeometryTopologyCursor {
    private readonly geometryOffsets: OffsetArray;
    private readonly partOffsets: OffsetArray;
    private readonly ringOffsets: OffsetArray;
    private readonly hasPolygonGeometry: boolean;

    private nextFeatureIndex = 0;
    private nextGeometryOffset = 1;
    private nextPartOffset = 1;
    private nextRingOffset = 1;
    private nextVertex = 0;

    private currentGeometryOffset = 1;
    private currentPartOffset = 1;
    private currentRingOffset = 1;
    private currentVertex = 0;
    private currentPartCount = 0;
    private currentGeometryType = 0;
    private currentFeatureIndex = -1;

    private selectedFeatureIndex = -1;
    private selectedPartIndex = -1;
    private selectedStart = 0;
    private selectedEnd = 0;
    private selectedClose = false;
    private selectedPolygonIndex = -1;

    constructor(private readonly geometryVector: TopologyGeometryVector) {
        const topology = geometryVector.topologyVector;
        this.geometryOffsets = topology?.geometryOffsets;
        this.partOffsets = topology?.partOffsets;
        this.ringOffsets = topology?.ringOffsets;
        this.hasPolygonGeometry = containsPolygonGeometry(geometryVector);
    }

    seek(featureIndex: number): this {
        if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= this.geometryVector.numGeometries) {
            throw new RangeError(`Geometry feature ${featureIndex} is out of range`);
        }
        if (featureIndex === this.currentFeatureIndex) {
            return this;
        }

        if (featureIndex < this.currentFeatureIndex - featureIndex) {
            this.reset();
        }
        while (this.currentFeatureIndex > featureIndex) {
            this.scanPreviousFeature();
        }

        while (this.nextFeatureIndex <= featureIndex) {
            this.scanNextFeature();
        }
        return this;
    }

    reset(): this {
        this.nextFeatureIndex = 0;
        this.nextGeometryOffset = 1;
        this.nextPartOffset = 1;
        this.nextRingOffset = 1;
        this.nextVertex = 0;
        this.currentFeatureIndex = -1;
        this.currentPartCount = 0;
        this.selectedFeatureIndex = -1;
        this.selectedPartIndex = -1;
        return this;
    }

    get featureIndex(): number {
        this.requireFeature();
        return this.currentFeatureIndex;
    }

    get geometryType(): number {
        this.requireFeature();
        return this.currentGeometryType;
    }

    get partCount(): number {
        this.requireFeature();
        return this.currentPartCount;
    }

    selectPart(partIndex: number): this {
        this.requireFeature();
        if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= this.currentPartCount) {
            throw new RangeError(`Geometry part ${partIndex} is out of range`);
        }
        if (this.selectedFeatureIndex === this.currentFeatureIndex && this.selectedPartIndex === partIndex) {
            return this;
        }

        this.iterateParts(undefined, partIndex);
        return this;
    }

    get partIndex(): number {
        this.requirePart();
        return this.selectedPartIndex;
    }

    get start(): number {
        this.requirePart();
        return this.selectedStart;
    }

    get end(): number {
        this.requirePart();
        return this.selectedEnd;
    }

    get close(): boolean {
        this.requirePart();
        return this.selectedClose;
    }

    get polygonIndex(): number {
        this.requirePart();
        return this.selectedPolygonIndex;
    }

    forEachPart(visitor: GeometryPartVisitor): void {
        this.requireFeature();
        this.iterateParts(visitor, -1);
    }

    private scanNextFeature(): void {
        const featureIndex = this.nextFeatureIndex;
        const geometryType = this.geometryVector.geometryType(featureIndex);
        this.currentFeatureIndex = featureIndex;
        this.currentGeometryType = geometryType;
        this.currentGeometryOffset = this.nextGeometryOffset;
        this.currentPartOffset = this.nextPartOffset;
        this.currentRingOffset = this.nextRingOffset;
        this.currentVertex = this.nextVertex;
        this.currentPartCount = 0;
        this.selectedFeatureIndex = -1;
        this.selectedPartIndex = -1;

        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
                this.currentPartCount = 1;
                this.nextVertex++;
                if (hasOffsets(this.geometryOffsets)) this.nextGeometryOffset++;
                if (hasOffsets(this.partOffsets)) this.nextPartOffset++;
                if (hasOffsets(this.ringOffsets)) this.nextRingOffset++;
                break;

            case GEOMETRY_TYPE.MULTIPOINT: {
                const numPoints = requireOffsetDiff(this.geometryOffsets, this.nextGeometryOffset++, "geometry");
                this.currentPartCount = numPoints;
                this.nextVertex += numPoints;
                this.nextPartOffset += numPoints;
                this.nextRingOffset += numPoints;
                break;
            }

            case GEOMETRY_TYPE.LINESTRING: {
                const numVertices = this.hasPolygonGeometry
                    ? requireOffsetDiff(this.ringOffsets, this.nextRingOffset++, "ring")
                    : requireOffsetDiff(this.partOffsets, this.nextPartOffset, "part");
                this.currentPartCount = 1;
                this.nextPartOffset++;
                this.nextVertex += numVertices;
                if (hasOffsets(this.geometryOffsets)) this.nextGeometryOffset++;
                break;
            }

            case GEOMETRY_TYPE.POLYGON: {
                const numRings = requireOffsetDiff(this.partOffsets, this.nextPartOffset++, "part");
                this.currentPartCount = numRings;
                for (let ringIndex = 0; ringIndex < numRings; ringIndex++) {
                    this.nextVertex += requireOffsetDiff(this.ringOffsets, this.nextRingOffset++, "ring");
                }
                if (hasOffsets(this.geometryOffsets)) this.nextGeometryOffset++;
                break;
            }

            case GEOMETRY_TYPE.MULTILINESTRING: {
                const numLineStrings = hasOffsets(this.geometryOffsets)
                    ? requireOffsetDiff(this.geometryOffsets, this.nextGeometryOffset++, "geometry")
                    : requireOffsetDiff(this.partOffsets, this.nextPartOffset, "part");
                this.currentPartCount = numLineStrings;
                for (let lineIndex = 0; lineIndex < numLineStrings; lineIndex++) {
                    this.nextVertex += this.hasPolygonGeometry
                        ? requireOffsetDiff(this.ringOffsets, this.nextRingOffset++, "ring")
                        : requireOffsetDiff(this.partOffsets, this.nextPartOffset, "part");
                    this.nextPartOffset++;
                }
                break;
            }

            case GEOMETRY_TYPE.MULTIPOLYGON: {
                const numPolygons = requireOffsetDiff(this.geometryOffsets, this.nextGeometryOffset++, "geometry");
                for (let polygonIndex = 0; polygonIndex < numPolygons; polygonIndex++) {
                    const numRings = requireOffsetDiff(this.partOffsets, this.nextPartOffset++, "part");
                    this.currentPartCount += numRings;
                    for (let ringIndex = 0; ringIndex < numRings; ringIndex++) {
                        this.nextVertex += requireOffsetDiff(this.ringOffsets, this.nextRingOffset++, "ring");
                    }
                }
                break;
            }

            default:
                throw new Error(`Unsupported MLT geometry type: ${geometryType}`);
        }

        this.nextFeatureIndex++;
    }

    private scanPreviousFeature(): void {
        const featureIndex = this.currentFeatureIndex - 1;
        if (featureIndex < 0) {
            throw new Error("Geometry cursor cannot seek before the first feature");
        }

        const nextFeatureIndex = this.currentFeatureIndex;
        const nextGeometryOffset = this.currentGeometryOffset;
        const nextPartOffset = this.currentPartOffset;
        const nextRingOffset = this.currentRingOffset;
        const nextVertex = this.currentVertex;
        const geometryType = this.geometryVector.geometryType(featureIndex);

        let geometryOffset = nextGeometryOffset;
        let partOffset = nextPartOffset;
        let ringOffset = nextRingOffset;
        let vertex = nextVertex;
        let partCount: number;

        switch (geometryType) {
            case GEOMETRY_TYPE.POINT:
                partCount = 1;
                vertex--;
                if (hasOffsets(this.geometryOffsets)) geometryOffset--;
                if (hasOffsets(this.partOffsets)) partOffset--;
                if (hasOffsets(this.ringOffsets)) ringOffset--;
                break;

            case GEOMETRY_TYPE.MULTIPOINT: {
                geometryOffset--;
                const numPoints = requireOffsetDiff(this.geometryOffsets, geometryOffset, "geometry");
                partCount = numPoints;
                partOffset -= numPoints;
                ringOffset -= numPoints;
                vertex -= numPoints;
                break;
            }

            case GEOMETRY_TYPE.LINESTRING: {
                if (hasOffsets(this.geometryOffsets)) geometryOffset--;
                partOffset--;
                if (this.hasPolygonGeometry) {
                    ringOffset--;
                    vertex -= requireOffsetDiff(this.ringOffsets, ringOffset, "ring");
                } else {
                    vertex -= requireOffsetDiff(this.partOffsets, partOffset, "part");
                }
                partCount = 1;
                break;
            }

            case GEOMETRY_TYPE.POLYGON: {
                if (hasOffsets(this.geometryOffsets)) geometryOffset--;
                partOffset--;
                const numRings = requireOffsetDiff(this.partOffsets, partOffset, "part");
                ringOffset -= numRings;
                vertex -= this.sumOffsetDiffs(this.ringOffsets, ringOffset, numRings, "ring");
                partCount = numRings;
                break;
            }

            case GEOMETRY_TYPE.MULTILINESTRING: {
                let numLineStrings: number;
                if (hasOffsets(this.geometryOffsets)) {
                    geometryOffset--;
                    numLineStrings = requireOffsetDiff(this.geometryOffsets, geometryOffset, "geometry");
                    partOffset -= numLineStrings;
                } else {
                    partOffset = this.findPreviousPartOffset(partOffset);
                    numLineStrings = nextPartOffset - partOffset;
                }
                partCount = numLineStrings;
                if (this.hasPolygonGeometry) {
                    ringOffset -= numLineStrings;
                    vertex -= this.sumOffsetDiffs(this.ringOffsets, ringOffset, numLineStrings, "ring");
                } else {
                    vertex -= this.sumOffsetDiffs(this.partOffsets, partOffset, numLineStrings, "part");
                }
                break;
            }

            case GEOMETRY_TYPE.MULTIPOLYGON: {
                geometryOffset--;
                const numPolygons = requireOffsetDiff(this.geometryOffsets, geometryOffset, "geometry");
                partOffset -= numPolygons;
                const numRings = this.sumOffsetDiffs(this.partOffsets, partOffset, numPolygons, "part");
                ringOffset -= numRings;
                vertex -= this.sumOffsetDiffs(this.ringOffsets, ringOffset, numRings, "ring");
                partCount = numRings;
                break;
            }

            default:
                throw new Error(`Unsupported MLT geometry type: ${geometryType}`);
        }

        this.currentFeatureIndex = featureIndex;
        this.currentGeometryType = geometryType;
        this.currentGeometryOffset = geometryOffset;
        this.currentPartOffset = partOffset;
        this.currentRingOffset = ringOffset;
        this.currentVertex = vertex;
        this.currentPartCount = partCount;
        this.selectedFeatureIndex = -1;
        this.selectedPartIndex = -1;

        this.nextFeatureIndex = nextFeatureIndex;
        this.nextGeometryOffset = nextGeometryOffset;
        this.nextPartOffset = nextPartOffset;
        this.nextRingOffset = nextRingOffset;
        this.nextVertex = nextVertex;
    }

    private sumOffsetDiffs(offsets: OffsetArray, start: number, count: number, name: string): number {
        let sum = 0;
        for (let index = 0; index < count; index++) {
            sum += requireOffsetDiff(offsets, start + index, name);
        }
        return sum;
    }

    private findPreviousPartOffset(nextPartOffset: number): number {
        for (let partOffset = nextPartOffset - 1; partOffset > 0; partOffset--) {
            if (requireOffsetDiff(this.partOffsets, partOffset, "part") === nextPartOffset - partOffset) {
                return partOffset;
            }
        }
        throw new Error(`Geometry traversal cannot resolve part offsets before index ${nextPartOffset}`);
    }

    private iterateParts(visitor: GeometryPartVisitor | undefined, targetPartIndex: number): void {
        let partIndex = 0;
        let vertex = this.currentVertex;
        let partOffset = this.currentPartOffset;
        let ringOffset = this.currentRingOffset;

        switch (this.currentGeometryType) {
            case GEOMETRY_TYPE.POINT:
                this.emitPart(visitor, targetPartIndex, 0, vertex, vertex + 1, false, -1);
                return;

            case GEOMETRY_TYPE.MULTIPOINT: {
                const numPoints = requireOffsetDiff(this.geometryOffsets, this.currentGeometryOffset, "geometry");
                for (; partIndex < numPoints; partIndex++, vertex++) {
                    if (this.emitPart(visitor, targetPartIndex, partIndex, vertex, vertex + 1, false, -1)) return;
                }
                return;
            }

            case GEOMETRY_TYPE.LINESTRING: {
                const numVertices = this.hasPolygonGeometry
                    ? requireOffsetDiff(this.ringOffsets, ringOffset, "ring")
                    : requireOffsetDiff(this.partOffsets, partOffset, "part");
                this.emitPart(visitor, targetPartIndex, 0, vertex, vertex + numVertices, false, -1);
                return;
            }

            case GEOMETRY_TYPE.POLYGON: {
                const numRings = requireOffsetDiff(this.partOffsets, partOffset, "part");
                for (; partIndex < numRings; partIndex++) {
                    const numVertices = requireOffsetDiff(this.ringOffsets, ringOffset++, "ring");
                    if (this.emitPart(visitor, targetPartIndex, partIndex, vertex, vertex + numVertices, true, 0))
                        return;
                    vertex += numVertices;
                }
                return;
            }

            case GEOMETRY_TYPE.MULTILINESTRING: {
                const numLineStrings = hasOffsets(this.geometryOffsets)
                    ? requireOffsetDiff(this.geometryOffsets, this.currentGeometryOffset, "geometry")
                    : requireOffsetDiff(this.partOffsets, partOffset, "part");
                for (; partIndex < numLineStrings; partIndex++) {
                    const numVertices = this.hasPolygonGeometry
                        ? requireOffsetDiff(this.ringOffsets, ringOffset++, "ring")
                        : requireOffsetDiff(this.partOffsets, partOffset, "part");
                    partOffset++;
                    if (this.emitPart(visitor, targetPartIndex, partIndex, vertex, vertex + numVertices, false, -1))
                        return;
                    vertex += numVertices;
                }
                return;
            }

            case GEOMETRY_TYPE.MULTIPOLYGON: {
                const numPolygons = requireOffsetDiff(this.geometryOffsets, this.currentGeometryOffset, "geometry");
                for (let polygonIndex = 0; polygonIndex < numPolygons; polygonIndex++) {
                    const numRings = requireOffsetDiff(this.partOffsets, partOffset++, "part");
                    for (let ringIndex = 0; ringIndex < numRings; ringIndex++, partIndex++) {
                        const numVertices = requireOffsetDiff(this.ringOffsets, ringOffset++, "ring");
                        if (
                            this.emitPart(
                                visitor,
                                targetPartIndex,
                                partIndex,
                                vertex,
                                vertex + numVertices,
                                true,
                                polygonIndex,
                            )
                        )
                            return;
                        vertex += numVertices;
                    }
                }
                return;
            }
        }
    }

    private emitPart(
        visitor: GeometryPartVisitor | undefined,
        targetPartIndex: number,
        partIndex: number,
        start: number,
        end: number,
        close: boolean,
        polygonIndex: number,
    ): boolean {
        if (targetPartIndex === partIndex) {
            this.selectedFeatureIndex = this.currentFeatureIndex;
            this.selectedPartIndex = partIndex;
            this.selectedStart = start;
            this.selectedEnd = end;
            this.selectedClose = close;
            this.selectedPolygonIndex = polygonIndex;
            return true;
        }

        visitor?.(partIndex, start, end, close, polygonIndex);
        return false;
    }

    private requireFeature(): void {
        if (this.currentFeatureIndex < 0) {
            throw new Error("Geometry cursor is not positioned on a feature");
        }
    }

    private requirePart(): void {
        if (this.selectedFeatureIndex !== this.currentFeatureIndex || this.selectedPartIndex < 0) {
            throw new Error("Geometry cursor is not positioned on a part");
        }
    }
}
