import type { SINGLE_PART_GEOMETRY_TYPE } from "./geometryType";
import { createFlatGeometryVector } from "./flatGeometryVector";
import type { CoordinatesArray } from "./geometryVector";
import type { TopologyVector } from "./topologyVector";
import type { SelectionVector } from "../filter/selectionVector";
import {
    createSelectionVectorByTypeConst,
    createSelectionVectorByTypeFlat,
    filterSelectedByTypeConst,
    filterSelectedByTypeFlat,
} from "./geometryVectorFilterUtils";

export abstract class GpuVector implements Iterable<CoordinatesArray> {
    protected constructor(
        private readonly _triangleOffsets: Uint32Array,
        private readonly _indexBuffer: Uint32Array,
        private readonly _vertexBuffer: Int32Array | Uint32Array,
        private readonly _topologyVector: TopologyVector | null = null,
    ) {}

    abstract geometryType(index: number): number;

    abstract get numGeometries(): number;

    abstract containsSingleGeometryType(): boolean;

    get triangleOffsets(): Uint32Array {
        return this._triangleOffsets;
    }

    get indexBuffer(): Uint32Array {
        return this._indexBuffer;
    }

    get vertexBuffer(): Int32Array | Uint32Array {
        return this._vertexBuffer;
    }

    get topologyVector(): TopologyVector | null {
        return this._topologyVector;
    }

    filter(geometryType: SINGLE_PART_GEOMETRY_TYPE): SelectionVector {
        if (this.containsSingleGeometryType()) {
            return createSelectionVectorByTypeConst(geometryType, this.geometryType(0), this.numGeometries);
        }

        return createSelectionVectorByTypeFlat(geometryType, this.collectGeometryTypes(), this.numGeometries);
    }

    filterSelected(geometryType: SINGLE_PART_GEOMETRY_TYPE, selectionVector: SelectionVector): void {
        if (this.containsSingleGeometryType()) {
            filterSelectedByTypeConst(geometryType, this.geometryType(0), selectionVector);
            return;
        }

        filterSelectedByTypeFlat(geometryType, this.collectGeometryTypes(), selectionVector);
    }

    private collectGeometryTypes(): Uint32Array {
        const geometryTypes = new Uint32Array(this.numGeometries);
        for (let i = 0; i < this.numGeometries; i++) {
            geometryTypes[i] = this.geometryType(i);
        }
        return geometryTypes;
    }

    /** Returns geometries as coordinate arrays by extracting outlines from topology. */
    getGeometries(): CoordinatesArray[] {
        if (!this._topologyVector) {
            throw new Error("Cannot convert GpuVector to coordinates without topology information");
        }
        const types = new Uint32Array(this.numGeometries);
        for (let i = 0; i < this.numGeometries; i++) {
            types[i] = this.geometryType(i);
        }
        return createFlatGeometryVector(types, this._topologyVector, undefined, this._vertexBuffer).getGeometries();
    }

    [Symbol.iterator](): Iterator<CoordinatesArray> {
        /*for(let i = 1; i < this.triangleOffsets.length; i++) {
           const numTriangles = this.triangleOffsets[i] - this.triangleOffsets[i-1];
           const startIndex = this.triangleOffsets[i-1] * 3;
           const endIndex = this.triangleOffsets[i] * 3;
       }

        while (index < this.numGeometries) {
            yield geometries[index++];
        }*/

        //throw new Error("Iterator on a GpuVector is not implemented yet.");
        return null;
    }
}
