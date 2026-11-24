import { decodeTileLayer, scanTileLayers, type TileLayerIndexEntry } from "./mltDecoder";
import type FeatureTable from "./vector/featureTable";
import type { GeometryVector } from "./vector/geometry/geometryVector";
import type { GpuVector } from "./vector/geometry/gpuVector";

/**
 * The array each column type comes as, one value per feature. `bool` comes as `0`/`1` in a `Uint8Array`, and
 * `i64` as a `Float64Array`, so values above `Number.MAX_SAFE_INTEGER` lose precision.
 */
interface MltColumnValuesByType {
    bool: Uint8Array;
    i32: Int32Array;
    u32: Uint32Array;
    i64: Float64Array;
    f32: Float32Array;
    f64: Float64Array;
    string: string[];
}

/** The type a property column comes as. */
export type MltColumnType = keyof MltColumnValuesByType;

/**
 * One value per feature. A slot whose feature has no value holds `0` or `""`; `present` says which slots those
 * are, one bit per feature, LSB-first, and is left out when every feature has a value.
 */
export interface MltColumn<V extends MltColumnValuesByType[MltColumnType] = MltColumnValuesByType[MltColumnType]> {
    readonly values: V;
    readonly present?: Uint8Array;
}

/**
 * A property column, the shape `decodeTileColumns` of `@maplibre/mlt-wasm` gives it. With `stringCodes`, a column
 * stored as a dictionary comes as one code per feature, `dictionary[code]` being the string, and the columns of
 * a shared dictionary share one `dictionary`.
 */
export type MltPropertyColumn =
    | {
          [T in MltColumnType]: MltColumn<MltColumnValuesByType[T]> & { readonly name: string; readonly type: T };
      }[MltColumnType]
    | {
          readonly name: string;
          readonly type: "string";
          readonly codes: Uint32Array;
          readonly dictionary: readonly string[];
          readonly present?: Uint8Array;
      };

/**
 * The geometry of a layer as `@maplibre/mlt-wasm` gives it. Offset arrays are cumulative, entry `i` starting
 * item `i`; each level indexes into the next, and the last one present indexes vertices. A level the layer does
 * not need is left out. A layer of pre-tessellated polygons holds the vertices of its triangles.
 */
export interface MltGeometryColumns {
    /** The MLT geometry type of each feature, see `GEOMETRY_TYPE`. */
    readonly types: Uint8Array;
    readonly dimension: 2;
    /** `x` and `y` of each vertex in tile coordinates; a polygon ring's closing vertex is not stored. */
    readonly vertices: Int32Array;
    readonly geometryOffsets?: Uint32Array;
    readonly partOffsets?: Uint32Array;
    readonly ringOffsets?: Uint32Array;
}

/** A layer of a tile as columns, decoded when any of them but its name is first read; its properties when they are first read. */
export interface MltColumnLayer {
    readonly name: string;
    readonly extent: number;
    readonly featureCount: number;
    readonly geometry: MltGeometryColumns;
    /** The id of each feature as the unsigned 64-bit number it is stored as; left out when the layer has none. */
    readonly ids?: MltColumn<Float64Array>;
    /** In wire order, a shared dictionary's columns named by its prefix and their own names. */
    readonly properties: readonly MltPropertyColumn[];
}

/** A tile as the columns of its layers, which is what {@link decodeTileColumns} returns. */
export interface MltColumnTile {
    /** In wire order; layer names need not be unique. */
    readonly layers: readonly MltColumnLayer[];
}

/** Which layers and properties {@link decodeTileColumns} reads of a tile, and how it passes dictionary strings on. */
export interface DecodeTileColumnsOptions {
    /** Decode only the layers with one of these names. Every layer is decoded when left out. */
    readonly layers?: readonly string[];
    /**
     * The properties to keep of each layer it lists, by layer name. The other property columns of that layer are
     * neither decoded nor passed on. A layer it does not list keeps all its properties.
     */
    readonly properties?: ReadonlyMap<string, readonly string[]>;
    /** Pass string properties stored as dictionaries on as codes into their dictionary, rather than as strings. */
    readonly stringCodes?: boolean;
}

/**
 * Decodes the layers of a tile into typed arrays, in the shape `decodeTileColumns` of `@maplibre/mlt-wasm` gives
 * them, so that a reader of columns takes either decoder. A layer is decoded when one of its columns is first read.
 */
export function decodeTileColumns(tile: Uint8Array, options: DecodeTileColumnsOptions = {}): MltColumnTile {
    const { layers, properties, stringCodes = false } = options;
    return {
        layers: scanTileLayers(tile)
            .filter((entry) => !layers || layers.includes(entry.name))
            .map((entry) => new LazyColumnLayer(tile, entry, properties?.get(entry.name), stringCodes)),
    };
}

/**
 * A layer that is read out of its tile on demand. Its name comes from the scan of the tile. The layer is decoded
 * when anything else is first read: with the properties to keep when some are listed, and otherwise without any,
 * all of them being decoded when `properties` is first read. Each column is built once.
 */
class LazyColumnLayer implements MltColumnLayer {
    private table?: FeatureTable;
    private decodedGeometry?: MltGeometryColumns;
    private decodedIds?: MltColumn<Float64Array> | null;
    private decodedProperties?: readonly MltPropertyColumn[];

    constructor(
        private readonly tile: Uint8Array,
        private readonly entry: TileLayerIndexEntry,
        private readonly keptProperties: readonly string[] | undefined,
        private readonly stringCodes: boolean,
    ) {}

    private get featureTable(): FeatureTable {
        this.table ??= decodeTileLayer(this.tile, this.entry, undefined, true, new Set(this.keptProperties));
        return this.table;
    }

    get name(): string {
        return this.entry.name;
    }

    get extent(): number {
        return this.featureTable.extent;
    }

    get featureCount(): number {
        return this.featureTable.numFeatures;
    }

    get geometry(): MltGeometryColumns {
        this.decodedGeometry ??= geometryColumns(this.featureTable.geometryVector);
        return this.decodedGeometry;
    }

    get ids(): MltColumn<Float64Array> | undefined {
        if (this.decodedIds === undefined) {
            const idVector = this.featureTable.idVector;
            this.decodedIds = idVector ? idVector.toUnsignedColumn() : null;
        }
        return this.decodedIds ?? undefined;
    }

    get properties(): readonly MltPropertyColumn[] {
        if (this.decodedProperties) return this.decodedProperties;
        const table = this.featureTable;
        const vectors = this.keptProperties ? table.propertyVectors : table.materializePropertyVectors();
        this.decodedProperties = vectors
            .map((vector) => vector.toColumn(this.stringCodes))
            .filter((column): column is MltPropertyColumn => column !== undefined);
        return this.decodedProperties;
    }
}

/**
 * The offsets of a level of the topology as a column, or nothing when the layer does not have that level: fewer
 * than two offsets delimit no item.
 */
function offsetColumn(offsets: Uint32Array | undefined): Uint32Array | undefined {
    return offsets && offsets.length >= 2 ? offsets : undefined;
}

/**
 * The `x` and `y` of every vertex of a geometry vector, read through its vertex dictionary or its Morton codes
 * when it has them, and otherwise the vertex buffer itself.
 */
function vertexColumn(vector: GeometryVector | GpuVector): Int32Array {
    const buffer = vector.vertexBuffer;
    const offsets = "vertexOffsets" in vector ? vector.vertexOffsets : undefined;
    const hasMortonCodes = "mortonSettings" in vector && !!vector.mortonSettings;
    if (!offsets && !hasMortonCodes) {
        return buffer instanceof Int32Array ? buffer : new Int32Array(buffer.buffer, buffer.byteOffset, buffer.length);
    }

    const vertexCount = offsets ? offsets.length : buffer.length;
    const vertices = new Int32Array(vertexCount * 2);
    if (hasMortonCodes) {
        for (let vertex = 0; vertex < vertexCount; vertex++) {
            [vertices[vertex * 2], vertices[vertex * 2 + 1]] = vector.getVertex(vertex);
        }
        return vertices;
    }

    for (let vertex = 0; vertex < vertexCount; vertex++) {
        vertices[vertex * 2] = buffer[offsets[vertex] * 2];
        vertices[vertex * 2 + 1] = buffer[offsets[vertex] * 2 + 1];
    }
    return vertices;
}

/** The geometry of a layer as columns: the type of each feature, the vertices, and the offset levels the layer has. */
function geometryColumns(vector: GeometryVector | GpuVector): MltGeometryColumns {
    const types = new Uint8Array(vector.numGeometries);
    for (let feature = 0; feature < types.length; feature++) types[feature] = vector.geometryType(feature);
    const topology = vector.topologyVector;
    return {
        types,
        dimension: 2,
        vertices: vertexColumn(vector),
        geometryOffsets: offsetColumn(topology?.geometryOffsets),
        partOffsets: offsetColumn(topology?.partOffsets),
        ringOffsets: offsetColumn(topology?.ringOffsets),
    };
}
