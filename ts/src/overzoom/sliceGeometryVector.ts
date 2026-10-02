import type FeatureTable from "../vector/featureTable";
import { createFlatGeometryVector, type FlatGeometryVector } from "../vector/geometry/flatGeometryVector";
import { GEOMETRY_TYPE } from "../vector/geometry/geometryType";
import { GeometryTopologyCursor } from "../vector/geometry/geometryTopologyCursor";
import type { GeometryVector } from "../vector/geometry/geometryVector";
import TopologyVector from "../vector/geometry/topologyVector";

export type SlicedGeometryVector = {
    geometryVector: FlatGeometryVector;
    sourceIndices: Uint32Array;
    /** The extent of the sliced vertices. */
    extent: number;
};

const enum Axis {
    X = 0,
    Y = 1,
}

type ClipVisitor = {
    point(x: number, y: number): void;
    endPart(): void;
};

/** Writes only final rounded vertices, retaining unrounded endpoints for exact closure removal. */
class GeometrySliceBuilder implements ClipVisitor {
    readonly sourceIndices: number[] = [];
    readonly geometryTypes: number[] = [];
    readonly featurePartOffsets: number[] = [0];
    readonly partVertexOffsets: number[] = [0];
    readonly partPolygonIndices: number[] = [];
    readonly vertices: number[] = [];
    private partStart = 0;
    private polygonIndex = 0;
    private stripClosure = false;
    private firstX = 0;
    private firstY = 0;
    private lastX = 0;
    private lastY = 0;
    private readonly clipY: AxisClipper;
    private readonly clipX: AxisClipper;

    constructor(
        private readonly min: number,
        private readonly max: number,
        private readonly outputScale: number,
    ) {
        this.clipY = new AxisClipper(min, max, Axis.Y, this);
        this.clipX = new AxisClipper(min, max, Axis.X, this.clipY);
    }

    appendFeature(
        reader: TransformedVertexReader,
        cursor: GeometryTopologyCursor,
        sourceIndex: number,
        geometryType: GEOMETRY_TYPE,
    ): void {
        const firstPart = this.partPolygonIndices.length;
        const isPolygon = geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON;
        this.stripClosure = this.clipX.isPolygon = this.clipY.isPolygon = isPolygon;
        const isPoint = geometryType === GEOMETRY_TYPE.POINT || geometryType === GEOMETRY_TYPE.MULTIPOINT;

        cursor.forEachPart((_partIndex, start, end, close, polygonIndex) => {
            if (end <= start) return;
            this.polygonIndex = polygonIndex;
            reader.read(start);
            const firstX = reader.x;
            const firstY = reader.y;
            if (isPoint) {
                if (firstX >= this.min && firstX <= this.max && firstY >= this.min && firstY <= this.max) {
                    this.point(firstX, firstY);
                    this.endPart();
                }
                return;
            }

            this.clipX.point(firstX, firstY);
            for (let vertexIndex = start + 1; vertexIndex < end; vertexIndex++) {
                reader.read(vertexIndex);
                this.clipX.point(reader.x, reader.y);
            }
            if (close) this.clipX.point(firstX, firstY);
            this.clipX.endPart();
        });

        const partCount = this.partPolygonIndices.length - firstPart;
        if (partCount === 0) return;

        this.sourceIndices.push(sourceIndex);
        this.geometryTypes.push(normalizeGeometryType(geometryType, partCount));
        this.featurePartOffsets.push(this.partPolygonIndices.length);
    }

    point(x: number, y: number): void {
        if (this.vertices.length === this.partStart) {
            this.firstX = x;
            this.firstY = y;
        }
        this.lastX = x;
        this.lastY = y;
        this.vertices.push(Math.round(x * this.outputScale), Math.round(y * this.outputScale));
    }

    endPart(): void {
        if (
            this.stripClosure &&
            this.vertices.length - this.partStart > 2 &&
            this.firstX === this.lastX &&
            this.firstY === this.lastY
        ) {
            this.vertices.length -= 2;
        }
        if (this.vertices.length === this.partStart) return;
        this.partPolygonIndices.push(this.polygonIndex);
        this.partVertexOffsets.push(this.vertices.length / 2);
        this.partStart = this.vertices.length;
    }
}

export function sliceGeometryVector(
    featureTable: FeatureTable,
    scale: number,
    offsetX: number,
    offsetY: number,
    min: number,
    max: number,
    outputScale = 1,
): SlicedGeometryVector {
    const cursor = new GeometryTopologyCursor(featureTable.geometryVector);
    const builder = new GeometrySliceBuilder(min, max, outputScale);
    const reader = new TransformedVertexReader(featureTable.geometryVector as GeometryVector, scale, offsetX, offsetY);

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        builder.appendFeature(
            reader,
            cursor.seek(featureIndex),
            featureIndex,
            featureTable.geometryVector.geometryType(featureIndex),
        );
    }

    return {
        geometryVector: buildGeometryVector(builder),
        sourceIndices: new Uint32Array(builder.sourceIndices),
        extent: featureTable.extent * outputScale,
    };
}

/** Reads dense/indexed vertices without coordinate tuples; the existing Morton decoder remains supported. */
class TransformedVertexReader {
    x = 0;
    y = 0;
    private readonly vertices: GeometryVector["vertexBuffer"];
    private readonly offsets: GeometryVector["vertexOffsets"];
    private readonly morton: boolean;

    constructor(
        private readonly geometry: GeometryVector,
        private readonly scale: number,
        private readonly offsetX: number,
        private readonly offsetY: number,
    ) {
        this.vertices = geometry.vertexBuffer;
        this.offsets = geometry.vertexOffsets?.length ? geometry.vertexOffsets : undefined;
        this.morton = !!(this.offsets && geometry.mortonSettings);
    }

    read(index: number): void {
        if (this.morton) {
            const [x, y] = this.geometry.getVertex(index);
            this.x = x * this.scale - this.offsetX;
            this.y = y * this.scale - this.offsetY;
            return;
        }
        const offset = this.offsets ? this.offsets[index] * 2 : index * 2;
        this.x = this.vertices[offset] * this.scale - this.offsetX;
        this.y = this.vertices[offset + 1] * this.scale - this.offsetY;
    }
}

/**
 * Emits the legacy axis-clipping sequence with constant working storage. X feeds Y synchronously,
 * including polygon closure before Y processes the next part. Rounding belongs only to the final sink.
 */
class AxisClipper implements ClipVisitor {
    isPolygon = false;
    private hasPrevious = false;
    private previousX = 0;
    private previousY = 0;
    private sliceLength = 0;
    private firstX = 0;
    private firstY = 0;
    private lastX = 0;
    private lastY = 0;

    constructor(
        private readonly start: number,
        private readonly end: number,
        private readonly axis: Axis,
        private readonly next: ClipVisitor,
    ) {}

    point(x: number, y: number): void {
        if (this.hasPrevious) this.segment(this.previousX, this.previousY, x, y);
        this.previousX = x;
        this.previousY = y;
        this.hasPrevious = true;
    }

    endPart(): void {
        if (!this.hasPrevious) return;
        const position = this.axis === Axis.X ? this.previousX : this.previousY;
        if (position >= this.start && position <= this.end) this.emit(this.previousX, this.previousY);
        this.finishSlice();
        this.hasPrevious = false;
    }

    private segment(p1x: number, p1y: number, p2x: number, p2y: number): void {
        const pos1 = this.axis === Axis.X ? p1x : p1y;
        const pos2 = this.axis === Axis.X ? p2x : p2y;
        let exited = false;

        if (pos1 < this.start) {
            if (pos2 > this.start) this.intersection(p1x, p1y, p2x, p2y, this.start);
        } else if (pos1 > this.end) {
            if (pos2 < this.end) this.intersection(p1x, p1y, p2x, p2y, this.end);
        } else {
            this.emit(p1x, p1y);
        }

        if (pos2 < this.start && pos1 >= this.start) {
            this.intersection(p1x, p1y, p2x, p2y, this.start);
            exited = true;
        }
        if (pos2 > this.end && pos1 <= this.end) {
            this.intersection(p1x, p1y, p2x, p2y, this.end);
            exited = true;
        }
        if (!this.isPolygon && exited) this.finishSlice();
    }

    private emit(x: number, y: number): void {
        if (this.sliceLength === 0) {
            this.firstX = x;
            this.firstY = y;
        }
        this.lastX = x;
        this.lastY = y;
        this.sliceLength++;
        this.next.point(x, y);
    }

    private finishSlice(): void {
        if (this.sliceLength === 0) return;
        if (this.isPolygon && (this.firstX !== this.lastX || this.firstY !== this.lastY)) {
            this.emit(this.firstX, this.firstY);
        }
        this.next.endPart();
        this.sliceLength = 0;
    }

    private intersection(x1: number, y1: number, x2: number, y2: number, value: number): void {
        if (this.axis === Axis.X) {
            const t = (value - x1) / (x2 - x1);
            this.emit(value, y1 + (y2 - y1) * t);
        } else {
            const t = (value - y1) / (y2 - y1);
            this.emit(x1 + (x2 - x1) * t, value);
        }
    }
}

function normalizeGeometryType(geometryType: GEOMETRY_TYPE, partCount: number): GEOMETRY_TYPE {
    switch (geometryType) {
        case GEOMETRY_TYPE.POINT:
        case GEOMETRY_TYPE.MULTIPOINT:
            return partCount > 1 ? GEOMETRY_TYPE.MULTIPOINT : GEOMETRY_TYPE.POINT;
        case GEOMETRY_TYPE.LINESTRING:
        case GEOMETRY_TYPE.MULTILINESTRING:
            return partCount > 1 ? GEOMETRY_TYPE.MULTILINESTRING : GEOMETRY_TYPE.LINESTRING;
        default:
            return geometryType;
    }
}

function buildGeometryVector(builder: GeometrySliceBuilder): FlatGeometryVector {
    const geometryOffsets: number[] = [0];
    const containsPolygon = builder.geometryTypes.some(
        (geometryType) => geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON,
    );
    const ringOffsets = containsPolygon ? new Uint32Array(builder.partVertexOffsets) : undefined;
    const partOffsets: number[] | Uint32Array = containsPolygon ? [0] : new Uint32Array(builder.partVertexOffsets);

    let geometryComponentCount = 0;
    for (let featureIndex = 0; featureIndex < builder.geometryTypes.length; featureIndex++) {
        const geometryType = builder.geometryTypes[featureIndex];
        const firstPart = builder.featurePartOffsets[featureIndex];
        const endPart = builder.featurePartOffsets[featureIndex + 1];
        const partCount = endPart - firstPart;

        if (!containsPolygon) {
            geometryComponentCount +=
                geometryType === GEOMETRY_TYPE.MULTIPOINT || geometryType === GEOMETRY_TYPE.MULTILINESTRING
                    ? partCount
                    : 1;
        } else if (geometryType === GEOMETRY_TYPE.POLYGON) {
            (partOffsets as number[]).push(endPart);
            geometryComponentCount++;
        } else if (geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
            let groupCount = 0;
            let previousPolygonIndex: number | undefined;
            for (let partIndex = firstPart; partIndex < endPart; partIndex++) {
                const polygonIndex = builder.partPolygonIndices[partIndex];
                if (previousPolygonIndex !== undefined && polygonIndex !== previousPolygonIndex) {
                    (partOffsets as number[]).push(partIndex);
                }
                if (polygonIndex !== previousPolygonIndex) groupCount++;
                previousPolygonIndex = polygonIndex;
            }
            (partOffsets as number[]).push(endPart);
            geometryComponentCount += groupCount;
        } else {
            for (let partIndex = firstPart; partIndex < endPart; partIndex++) {
                (partOffsets as number[]).push(partIndex + 1);
            }
            geometryComponentCount +=
                geometryType === GEOMETRY_TYPE.MULTIPOINT || geometryType === GEOMETRY_TYPE.MULTILINESTRING
                    ? partCount
                    : 1;
        }
        geometryOffsets.push(geometryComponentCount);
    }

    return createFlatGeometryVector(
        new Int32Array(builder.geometryTypes),
        new TopologyVector(
            new Uint32Array(geometryOffsets),
            partOffsets instanceof Uint32Array ? partOffsets : new Uint32Array(partOffsets),
            ringOffsets,
        ),
        undefined,
        new Int32Array(builder.vertices),
    );
}
