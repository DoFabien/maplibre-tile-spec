import { decodeGeometryColumn } from "./geometryDecoder";
import IntWrapper from "./intWrapper";
import type GeometryScaling from "./geometryScaling";
import type { GeometryVector } from "../vector/geometry/geometryVector";
import type { GpuVector } from "../vector/geometry/gpuVector";
import { decodeStreamMetadata } from "../metadata/tile/streamMetadataDecoder";
import { decodeConstIntStream, decodeIntStream, getVectorType } from "./integerStreamDecoder";
import { VectorType } from "../vector/vectorType";

type GeometryColumnArgs = {
    tile: Uint8Array;
    numStreams: number;
    numFeatures: number;
    scalingData?: GeometryScaling;
    startOffset: number;
};

export class DeferredGeometryColumn {
    private decoded: GeometryVector | GpuVector | null = null;
    private geometryTypes: Int32Array | number | null = null;

    constructor(private readonly args: GeometryColumnArgs) {}

    get numFeatures(): number {
        return this.args.numFeatures;
    }

    /**
     * Returns the geometry type for a single feature without decoding vertex buffers.
     * Decodes only the geometry type stream and caches it.
     */
    getGeometryType(index: number): number {
        if (index < 0 || index >= this.args.numFeatures) {
            throw new RangeError(
                `Geometry index ${index} out of bounds. Valid range: 0 to ${this.args.numFeatures - 1}`,
            );
        }

        if (this.decoded) {
            return this.decoded.geometryType(index);
        }

        if (this.geometryTypes === null) {
            const offset = new IntWrapper(this.args.startOffset);
            const geometryTypeMetadata = decodeStreamMetadata(this.args.tile, offset);
            const vectorType = getVectorType(geometryTypeMetadata, this.args.numFeatures, this.args.tile, offset);
            this.geometryTypes =
                vectorType === VectorType.CONST
                    ? decodeConstIntStream(this.args.tile, offset, geometryTypeMetadata, false)
                    : decodeIntStream(this.args.tile, offset, geometryTypeMetadata, false);
        }

        return typeof this.geometryTypes === "number" ? this.geometryTypes : this.geometryTypes[index];
    }

    get(): GeometryVector | GpuVector {
        if (!this.decoded) {
            const offset = new IntWrapper(this.args.startOffset);
            this.decoded = decodeGeometryColumn(
                this.args.tile,
                this.args.numStreams,
                offset,
                this.args.numFeatures,
                this.args.scalingData,
            );
        }

        return this.decoded;
    }
}
