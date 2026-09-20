export default class TopologyVector {
    constructor(
        readonly geometryOffsets?: Uint32Array | null,
        readonly partOffsets?: Uint32Array | null,
        readonly ringOffsets?: Uint32Array | null,
    ) {}
}

export { TopologyVector };
