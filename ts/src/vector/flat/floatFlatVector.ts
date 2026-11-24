import { FixedSizeVector } from "../fixedSizeVector";
import type { MltColumnType, MltPropertyColumn } from "../../columns";

export class FloatFlatVector extends FixedSizeVector<Float32Array, number> {
    protected getValueFromBuffer(index: number): number {
        return this.dataBuffer[index];
    }

    protected columnType(): MltColumnType {
        return "f32";
    }

    /**
     * The vector as a property column whose values are its buffer: the buffer has a slot for every feature,
     * whether the feature has a value or not.
     */
    toColumn(): MltPropertyColumn {
        const present = this.nullabilityBuffer?.getBuffer();
        return { name: this.name, type: "f32", values: this.dataBuffer, present };
    }
}
