import Vector from "./vector";

/**
 * Read-only row selection over another vector, without copying or decoding its values.
 * The backing data contains source row indices, not scalar values. Consumers must use
 * getValue/has or explicitly handle this layout. Source and indices must remain immutable,
 * and every index must be in the source's range, as for other vector accessors.
 */
export class IndexedVector<K = unknown> extends Vector<Uint32Array, K | null> {
    constructor(
        readonly source: Vector<ArrayBufferView, K | null>,
        indices: Uint32Array,
    ) {
        super(source.name, indices, indices.length);
    }

    override has(index: number): boolean {
        return this.source.has(this.dataBuffer[index]);
    }

    protected getValueFromBuffer(index: number): K | null {
        return this.source.getValue(this.dataBuffer[index]);
    }
}
