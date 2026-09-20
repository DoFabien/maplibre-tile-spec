import type { Geometry, GeometryVector } from "./geometry/geometryVector";
import type Vector from "./vector";
import type { IdVector } from "./idVector";
import { Int32FlatVector } from "./flat/int32FlatVector";
import { DoubleFlatVector } from "./flat/doubleFlatVector";
import { Int32SequenceVector } from "./sequence/int32SequenceVector";
import { Int32ConstVector } from "./constant/int32ConstVector";
import type { GpuVector } from "./geometry/gpuVector";
import type { SelectionVector } from "./filter/selectionVector";

export type PropertyVectorResolver = (propertyName: string) => Vector | Vector[] | undefined;
export type PropertyVectorResolutionListener = (propertyVectors: readonly Vector[]) => void;

export interface Feature {
    id: number | bigint | undefined;
    geometry: Geometry;
    properties: { [key: string]: unknown };
}

export default class FeatureTable {
    private propertyVectorsMap?: Map<string, Vector>;
    private propertyVectorResolutionListeners?: Set<PropertyVectorResolutionListener>;
    private allPropertyVectorsMaterialized: boolean;

    constructor(
        private readonly _name: string,
        private readonly _geometryVector: GeometryVector | GpuVector,
        private readonly _idVector?: IdVector,
        private readonly _propertyVectors?: Vector[],
        private readonly _extent = 4096,
        private readonly propertyVectorResolver?: PropertyVectorResolver,
        private readonly _availablePropertyNames?: readonly string[],
    ) {
        if (_name.length === 0) {
            throw new Error("Missing layer name");
        }
        // Tables without a deferred resolver are complete as soon as they are
        // constructed. Deferred tables flip this flag after their first full
        // materialization, making subsequent full-access calls O(1).
        this.allPropertyVectorsMaterialized = propertyVectorResolver === undefined;
    }

    get name(): string {
        return this._name;
    }

    get idVector(): IdVector | undefined {
        return this._idVector;
    }

    get geometryVector(): GeometryVector | GpuVector {
        return this._geometryVector;
    }

    get propertyVectors(): Vector[] {
        return this._propertyVectors ?? [];
    }

    getPropertyVector(name: string): Vector | undefined {
        if (!this.propertyVectorsMap) {
            this.propertyVectorsMap = new Map(this.propertyVectors.map((vector) => [vector.name, vector]));
        }

        let propertyVector = this.propertyVectorsMap.get(name);
        if (propertyVector || !this.propertyVectorResolver) return propertyVector;

        const resolved = this.propertyVectorResolver(name);
        if (!resolved) return undefined;
        const resolvedVectors = Array.isArray(resolved) ? resolved : [resolved];
        for (const vector of resolvedVectors) {
            this.propertyVectorsMap.set(vector.name, vector);
            this._propertyVectors?.push(vector);
        }
        for (const listener of this.propertyVectorResolutionListeners ?? []) {
            listener(resolvedVectors);
        }
        propertyVector = this.propertyVectorsMap.get(name);
        return propertyVector;
    }

    /**
     * Observes property vectors decoded by the deferred resolver. Vectors that
     * were decoded with the FeatureTable itself are deliberately not reported.
     */
    onPropertyVectorsResolved(listener: PropertyVectorResolutionListener): () => void {
        this.propertyVectorResolutionListeners ??= new Set();
        this.propertyVectorResolutionListeners.add(listener);
        return () => {
            this.propertyVectorResolutionListeners?.delete(listener);
        };
    }

    get availablePropertyNames(): readonly string[] {
        return this._availablePropertyNames ?? (this._propertyVectors ?? []).map((vector) => vector.name);
    }

    materializePropertyVectors(propertyNames?: Iterable<string>): Vector[] {
        const materializeAll = propertyNames === undefined;
        if (materializeAll && this.allPropertyVectorsMaterialized) {
            return this._propertyVectors ?? [];
        }

        for (const propertyName of propertyNames ?? this.availablePropertyNames) {
            this.getPropertyVector(propertyName);
        }
        if (materializeAll) {
            this.allPropertyVectorsMaterialized = true;
        }
        return this._propertyVectors ?? [];
    }

    get numFeatures(): number {
        return this.geometryVector.numGeometries;
    }

    get extent(): number {
        return this._extent;
    }

    getFeaturesForSelection(sel: SelectionVector): Feature[] {
        const features: Feature[] = [];
        const geometries = this.geometryVector.getGeometries();

        for (let j = 0; j < sel.limit; j++) {
            const i = sel.getIndex(j);
            features.push(this.featureAt(i, geometries));
        }

        return features;
    }

    /**
     * Returns all features as an array
     */
    getFeatures(): Feature[] {
        const features: Feature[] = [];
        const geometries = this.geometryVector.getGeometries();

        for (let i = 0; i < this.numFeatures; i++) {
            features.push(this.featureAt(i, geometries));
        }
        return features;
    }

    private featureAt(i: number, geometries: Geometry["coordinates"][]): Feature {
        let id: number | bigint | undefined;
        if (this.idVector) {
            const idValue = this.idVector.getValue(i);
            if (idValue !== null) {
                id = this.containsMaxSafeIntegerValues(this.idVector) ? Number(idValue) : idValue;
            }
        }
        const geometry = {
            coordinates: geometries[i],
            type: this.geometryVector.geometryType(i),
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

        return { id, geometry, properties };
    }

    private containsMaxSafeIntegerValues(idVector: IdVector) {
        return (
            idVector instanceof Int32FlatVector ||
            idVector instanceof Int32ConstVector ||
            idVector instanceof Int32SequenceVector ||
            idVector instanceof DoubleFlatVector
        );
    }
}
