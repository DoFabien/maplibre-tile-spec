import { GeometryVector, type CoordinatesArray, type Geometry } from "./geometry/geometryVector";
import type Vector from "./vector";
import { type IntVector } from "./intVector";
import { IntFlatVector } from "./flat/intFlatVector";
import { DoubleFlatVector } from "./flat/doubleFlatVector";
import { IntSequenceVector } from "./sequence/intSequenceVector";
import { IntConstVector } from "./constant/intConstVector";
import { type GpuVector } from "./geometry/gpuVector";
import type { DeferredGeometryColumn } from "../decoding/deferredGeometryColumn";
import { convertSingleGeometry } from "./geometry/geometryVectorConverter";

type GeometryVectorResolver = () => GeometryVector | GpuVector;

class LazyGeometryCoordinatesResolver {
    // Conservative heuristic defaults:
    // - stay in "single geometry" mode for sparse access (selective filters)
    // - switch to "bulk" mode only when access looks like a sequential scan
    private static readonly maxIndexDeltaForSequential = 2;
    private static readonly nearSequentialThreshold = 32;
    private static readonly absoluteAccessThreshold = 512;

    private resolvedVector: GeometryVector | GpuVector | null = null;
    private resolvedIsGeometryVector = false;
    private allGeometries: CoordinatesArray[] | null = null;

    private lastRequestedIndex: number | null = null;
    private nearSequentialCount = 0;
    private coordinateAccessCount = 0;

    constructor(private readonly resolveVector: GeometryVectorResolver) {}

    getCoordinates(index: number): CoordinatesArray {
        if (this.allGeometries !== null) {
            return this.allGeometries[index];
        }

        this.maybeMaterializeAllGeometries(index);
        if (this.allGeometries !== null) {
            return this.allGeometries[index];
        }

        if (!this.resolvedVector) {
            this.resolvedVector = this.resolveVector();
            this.resolvedIsGeometryVector = this.resolvedVector instanceof GeometryVector;
        }

        return this.resolvedIsGeometryVector
            ? convertSingleGeometry(this.resolvedVector as GeometryVector, index)
            : (this.resolvedVector as GpuVector).getGeometries()[index];
    }

    private maybeMaterializeAllGeometries(requestedIndex: number): void {
        if (this.allGeometries !== null) {
            return;
        }

        this.coordinateAccessCount++;
        if (this.lastRequestedIndex !== null) {
            const delta = requestedIndex - this.lastRequestedIndex;
            this.nearSequentialCount =
                delta > 0 && delta <= LazyGeometryCoordinatesResolver.maxIndexDeltaForSequential
                    ? this.nearSequentialCount + 1
                    : 0;
        }
        this.lastRequestedIndex = requestedIndex;

        if (!this.resolvedVector) {
            this.resolvedVector = this.resolveVector();
            this.resolvedIsGeometryVector = this.resolvedVector instanceof GeometryVector;

            // GpuVector does not support single-geometry conversion; materialize once.
            if (!this.resolvedIsGeometryVector) {
                this.allGeometries = this.resolvedVector.getGeometries();
                return;
            }
        }

        if (
            this.nearSequentialCount >= LazyGeometryCoordinatesResolver.nearSequentialThreshold ||
            this.coordinateAccessCount >= LazyGeometryCoordinatesResolver.absoluteAccessThreshold
        ) {
            this.allGeometries = (this.resolvedVector as GeometryVector).getGeometries();
        }
    }
}

export interface Feature {
    id: number | bigint;
    geometry: Geometry;
    properties: { [key: string]: unknown };
}

export default class FeatureTable implements Iterable<Feature> {
    private propertyVectorsMap: Map<string, Vector>;
    private _geometryVector: GeometryVector | GpuVector | null;
    private _deferredGeometry: DeferredGeometryColumn | null;

    // Either _geometryVector or _deferredGeometry is expected to be set.
    constructor(
        private readonly _name: string,
        geometryVector: GeometryVector | GpuVector | null,
        private readonly _idVector?: IntVector,
        private readonly _propertyVectors?: Vector[],
        private readonly _extent = 4096,
        deferredGeometry: DeferredGeometryColumn | null = null,
    ) {
        this._geometryVector = geometryVector;
        this._deferredGeometry = deferredGeometry;
    }

    get name(): string {
        return this._name;
    }

    get idVector(): IntVector {
        return this._idVector;
    }

    get geometryVector(): GeometryVector | GpuVector {
        return this.resolveGeometryVector();
    }

    get propertyVectors(): Vector[] {
        return this._propertyVectors;
    }

    getPropertyVector(name: string): Vector {
        if (!this.propertyVectorsMap) {
            this.propertyVectorsMap = new Map(this._propertyVectors.map((vector) => [vector.name, vector]));
        }

        return this.propertyVectorsMap.get(name);
    }

    *[Symbol.iterator](): Iterator<Feature> {
        const geometryIterator = this.resolveGeometryVector()[Symbol.iterator]();
        let index = 0;

        while (index < this.numFeatures) {
            let id;
            if (this.idVector) {
                id = this.containsMaxSaveIntegerValues(this.idVector)
                    ? Number(this.idVector.getValue(index))
                    : this.idVector.getValue(index);
            }

            const geometry = geometryIterator?.next().value;

            const properties: { [key: string]: unknown } = {};
            for (const propertyColumn of this.propertyVectors) {
                if (!propertyColumn) {
                    continue;
                }

                const columnName = propertyColumn.name;
                const propertyValue = propertyColumn.getValue(index);
                if (propertyValue !== null) {
                    properties[columnName] = propertyValue;
                }
            }

            index++;
            yield { id, geometry, properties };
        }
    }

    get numFeatures(): number {
        return (
            this._deferredGeometry?.numFeatures ??
            this._geometryVector?.numGeometries ??
            this.missingGeometryVector()
        );
    }

    get extent(): number {
        return this._extent;
    }

    /**
     * Returns all features as an array.
     * Geometry coordinates are lazily evaluated - coordinates are only materialized when accessed.
     */
    getFeatures(): Feature[] {
        const features: Feature[] = [];
        const numFeatures = this.numFeatures;
        const coordinatesResolver = new LazyGeometryCoordinatesResolver(() => this.resolveGeometryVector());

        for (let i = 0; i < numFeatures; i++) {
            let id;
            if (this.idVector) {
                id = this.containsMaxSaveIntegerValues(this.idVector)
                    ? Number(this.idVector.getValue(i))
                    : this.idVector.getValue(i);
            }

            const geometryType = this.getGeometryType(i);
            let cachedCoordinates: CoordinatesArray | null = null;
            const featureIndex = i;
            const geometry: Geometry = {
                type: geometryType,
                // Lazily evaluates and caches the geometry coordinates.
                // Coordinates are only materialized when accessed for the first time.
                get coordinates() {
                    if (cachedCoordinates !== null) {
                        return cachedCoordinates;
                    }

                    cachedCoordinates = coordinatesResolver.getCoordinates(featureIndex);
                    return cachedCoordinates;
                },
            };

            const properties: { [key: string]: unknown } = {};
            for (const propertyColumn of this.propertyVectors) {
                if (!propertyColumn) continue;
                const columnName = propertyColumn.name;
                const propertyValue = propertyColumn.getValue(i);
                if (propertyValue !== null) {
                    properties[columnName] = propertyValue;
                }
            }

            features.push({ id, geometry, properties });
        }
        return features;
    }

    private getGeometryType(index: number): number {
        if (this._geometryVector) {
            return this._geometryVector.geometryType(index);
        }

        if (!this._deferredGeometry) {
            return this.missingGeometryVector();
        }

        return this._deferredGeometry.getGeometryType(index);
    }

    private containsMaxSaveIntegerValues(intVector: IntVector) {
        return (
            intVector instanceof IntFlatVector ||
            (intVector instanceof IntConstVector && intVector instanceof IntSequenceVector) ||
            intVector instanceof DoubleFlatVector
        );
    }

    private resolveGeometryVector(): GeometryVector | GpuVector {
        if (!this._geometryVector) {
            if (!this._deferredGeometry) {
                return this.missingGeometryVector();
            }

            this._geometryVector = this._deferredGeometry.get();
            this._deferredGeometry = null;
        }

        return this._geometryVector;
    }

    private missingGeometryVector(): never {
        throw new Error("Geometry vector is not available.");
    }
}
