import { FixedSizeVector } from "../fixedSizeVector";
import type { MltColumnType, MltPropertyColumn } from "../../columns";

export class Int32FlatVector extends FixedSizeVector<Int32Array | Uint32Array, number> {
    protected getValueFromBuffer(index: number): number {
        return this.dataBuffer[index];
    }

    protected columnType(): MltColumnType {
        return this.dataBuffer instanceof Uint32Array ? "u32" : "i32";
    }

    /**
     * The vector as a property column whose values are its buffer: the buffer has a slot for every feature,
     * whether the feature has a value or not.
     */
    toColumn(): MltPropertyColumn {
        const present = this.nullabilityBuffer?.getBuffer();
        return this.dataBuffer instanceof Uint32Array
            ? { name: this.name, type: "u32", values: this.dataBuffer, present }
            : { name: this.name, type: "i32", values: this.dataBuffer, present };
    }
}
