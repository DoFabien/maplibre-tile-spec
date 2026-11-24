import { GEOMETRY_TYPE } from "../vector/geometry/geometryType";
import { ScalarType } from "../metadata/tileset/tilesetMetadata";
import { PhysicalStreamType } from "../metadata/tile/physicalStreamType";
import { LengthType } from "../metadata/tile/lengthType";
import { DictionaryType } from "../metadata/tile/dictionaryType";
import { PhysicalLevelTechnique } from "../metadata/tile/physicalLevelTechnique";
import { createStream } from "../decoding/decodingTestUtils";
import IntWrapper from "../decoding/intWrapper";
import { concatenateBuffers } from "./encodingUtils";
import { encodeVarintInt32, encodeVarintInt32Value, encodeZigZagVarintInt32 } from "./integerEncodingUtils";
import { encodeChildCount, encodeFieldName, encodeTypeCode, scalarTypeCode } from "./embeddedTilesetMetadataEncoder";
import { ColumnTypeCode } from "../metadata/tileset/typeMap";
import { encodeDictionaryCodes, encodeDictionaryStrings, encodePlainStrings } from "./stringEncoder";
import type { MltColumn, MltColumnLayer, MltGeometryColumns, MltPropertyColumn } from "../columns";
import { encodeMapPropertyColumn, type MapEncodingOptions, type MapValue } from "./mapPropertyEncoder";
import {
    encodeBooleanColumn,
    encodeBooleanNullableColumn,
    encodeDoubleColumn,
    encodeDoubleNullableColumn,
    encodeFloatColumn,
    encodeFloatNullableColumn,
    encodeInt32NoneColumn,
    encodeInt32NullableColumn,
    encodeInt64NoneColumn,
    encodeInt64NullableColumn,
    encodeUint32Column,
    encodeUint32NullableColumn,
    encodeUint64Column,
    encodeUint64NullableColumn,
} from "./propertyEncoder";

/** A coordinate pair in tile-local units. */
export type Position = [number, number];

/**
 * The geometry of one feature, in the same nesting GeoJSON uses:
 * a point is a position, a line string a list of positions, a polygon a list of rings, and the
 * multi variants add one more level. Polygon rings are given without a repeated closing position.
 */
export type FeatureGeometry =
    | { type: "Point"; coordinates: Position }
    | { type: "MultiPoint"; coordinates: Position[] }
    | { type: "LineString"; coordinates: Position[] }
    | { type: "MultiLineString"; coordinates: Position[][] }
    | { type: "Polygon"; coordinates: Position[][] }
    | { type: "MultiPolygon"; coordinates: Position[][][] };

/**
 * A property value. Maps and lists of arbitrary depth are allowed and go out as a nested (MAP)
 * column; `null` means the property is absent for that feature.
 */
export type PropertyValue = MapValue | null;

export interface Feature {
    id?: number | bigint;
    geometry: FeatureGeometry;
    properties?: Record<string, PropertyValue>;
}

/** One feature table, the equivalent of a layer in the Java encoder's `LayerSource`. */
export interface Layer {
    name: string;
    features: Feature[];
    extent?: number;
}

/**
 * The physical type a property column is written as. Inferred per column when not given, which is
 * all the synthetic cases need; pass it explicitly to pin a width the values alone do not imply.
 *
 * `map` is the nested column, which holds maps, lists and scalars of any shape. It is inferred for
 * any column holding a map or a list, and can be pinned to keep a column nested even when the
 * values it happens to hold are all scalars.
 */
export type PropertyType = "boolean" | "int32" | "int64" | "uint64" | "float" | "double" | "string" | "map";

/**
 * How a string column is written: `plain` holds one value per feature, `dictionary` holds each distinct value once
 * and, per feature, the index of its value.
 */
export type StringEncoding = "plain" | "dictionary";

export interface EncodeOptions {
    /** Physical type per property name, for columns whose values do not imply one. */
    propertyTypes?: Record<string, PropertyType>;
    /** Dictionary widths for nested columns, which the values alone do not always imply. */
    mapOptions?: MapEncodingOptions;
    /**
     * How string columns are written: one encoding for all of them, or one per property name. Under names, a string
     * column that is not named is written `plain`, and a name that is not a string column is ignored.
     */
    stringEncodings?: StringEncoding | Record<string, StringEncoding>;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const UINT32_MAX = 2 ** 32 - 1;
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const DEFAULT_EXTENT = 4096;
const TAG = 1;

/**
 * Encodes layers into an MLT tile, the inverse of `decodeTile`.
 *
 * This is the plainest encoding the format allows: values go out as varints and plain strings, with
 * no RLE, no FastPFOR or FSST, no morton-coded or dictionary-encoded vertices and no
 * pre-tessellation. The result is larger than what the Java or Rust encoders produce but is
 * built only from the stream encoders already in this package, and decodes to the same features.
 *
 * There are two exceptions. A string column goes out as a dictionary where `stringEncodings` asks
 * for it. And nested (MAP) columns are always dictionaries of scalars and a stream of tokens, as
 * the format has no plainer form to write them in.
 */
export function encodeTile(layers: Layer[], options: EncodeOptions = {}): Uint8Array {
    return concatenateBuffers(...layers.map((layer) => encodeLayer(layer, options)));
}

/** Each layer is a self-contained, length-prefixed block, so tiles are concatenations of layers. */
function encodeLayer(layer: Layer, options: EncodeOptions): Uint8Array {
    const extent = layer.extent ?? DEFAULT_EXTENT;
    const propertyNames = collectPropertyNames(layer.features);
    const hasIds = layer.features.some((feature) => feature.id !== undefined);

    const columns: Uint8Array[] = [];
    const metadata: Uint8Array[] = [];

    if (hasIds) {
        const ids = encodeIdColumn(layer.features);
        metadata.push(encodeTypeCode(ids.typeCode));
        columns.push(ids.data);
    }

    metadata.push(encodeTypeCode(ColumnTypeCode.GEOMETRY));
    columns.push(encodeGeometryColumn(layer.features));

    const { stringEncodings } = options;
    for (const name of propertyNames) {
        const values = layer.features.map((feature) => feature.properties?.[name] ?? null);
        const type = options.propertyTypes?.[name] ?? inferPropertyType(name, values);

        if (type === "map") {
            const { data, numStreams } = encodeMapPropertyColumn([values], options.mapOptions);
            metadata.push(encodeTypeCode(ColumnTypeCode.MAP), encodeFieldName(name), encodeChildCount(0));
            columns.push(concatenateBuffers(encodeVarintValue(numStreams), data));
            continue;
        }

        const nullable = values.some((value) => value === null);
        metadata.push(encodeTypeCode(scalarTypeCode(scalarTypeOf(type), nullable)), encodeFieldName(name));
        const stringEncoding = typeof stringEncodings === "string" ? stringEncodings : stringEncodings?.[name];
        columns.push(encodePropertyColumn(type, values, nullable, stringEncoding));
    }

    return layerBlock(layer.name, extent, metadata, columns);
}

/**
 * The block of a layer: the length of what follows, then the tag, the name of the layer, its extent, the number
 * of its columns, the metadata of each column and the data of each.
 */
function layerBlock(name: string, extent: number, metadata: Uint8Array[], columns: Uint8Array[]): Uint8Array {
    const body = concatenateBuffers(
        encodeVarintValue(TAG),
        encodeFieldName(name),
        encodeVarintValue(extent),
        encodeVarintValue(columns.length),
        ...metadata,
        ...columns,
    );
    return concatenateBuffers(encodeVarintValue(body.length), body);
}

/** Property columns appear in every feature's order of first appearance, so the layout is stable. */
function collectPropertyNames(features: Feature[]): string[] {
    const names = new Set<string>();
    for (const feature of features) {
        for (const name of Object.keys(feature.properties ?? {})) names.add(name);
    }
    return [...names];
}

function inferPropertyType(name: string, values: PropertyValue[]): PropertyType {
    const kinds = new Set<string>();
    let aboveInt64 = false;
    let allSafeIntegers = true;
    let allInt32 = true;
    for (const value of values) {
        if (value === null) continue;
        // One map or list anywhere in the column makes the whole column nested. The nested encoding also
        // takes plain scalars, so the features whose value is a scalar still fit.
        if (typeof value === "object") return "map";
        kinds.add(typeof value);
        if (typeof value === "bigint" && value > INT64_MAX) aboveInt64 = true;
        if (typeof value !== "number") continue;
        if (!Number.isSafeInteger(value)) allSafeIntegers = false;
        else if (value < INT32_MIN || value > INT32_MAX) allInt32 = false;
    }
    if (kinds.size === 0) return "string";
    const kind = kinds.size === 1 ? [...kinds][0] : undefined;
    if (kind === "boolean") return "boolean";
    if (kind === "string") return "string";
    // Values past the signed maximum only fit in the unsigned column.
    if (kind === "bigint") return aboveInt64 ? "uint64" : "int64";
    if (kind === "number" && !allSafeIntegers) return "double";
    if (kind === "number") return allInt32 ? "int32" : "int64";
    throw new Error(`Property "${name}" mixes value types, so no single column type fits it`);
}

function scalarTypeOf(type: Exclude<PropertyType, "map">): number {
    switch (type) {
        case "boolean":
            return ScalarType.BOOLEAN;
        case "int32":
            return ScalarType.INT_32;
        case "int64":
            return ScalarType.INT_64;
        case "uint64":
            return ScalarType.UINT_64;
        case "float":
            return ScalarType.FLOAT;
        case "double":
            return ScalarType.DOUBLE;
        case "string":
            return ScalarType.STRING;
    }
}

/**
 * Writes the id column and the type code describing it. Nullable ids always go out as 64-bit,
 * because only the 64-bit encoder has a nullable form.
 */
function encodeIdColumn(features: Feature[]): { typeCode: number; data: Uint8Array } {
    const ids = features.map((feature) => feature.id);
    const nullable = ids.some((id) => id === undefined);

    if (nullable) {
        return {
            typeCode: ColumnTypeCode.ID | ColumnTypeCode.ID_LONG | ColumnTypeCode.ID_NULLABLE,
            data: encodeUint64NullableColumn(ids.map((id) => (id === undefined ? null : BigInt(id)))),
        };
    }
    const wide = ids.some((id) => id !== undefined && id > UINT32_MAX);
    if (wide) {
        return {
            typeCode: ColumnTypeCode.ID | ColumnTypeCode.ID_LONG,
            data: encodeUint64Column(BigUint64Array.from(ids, (id) => BigInt(id ?? 0))),
        };
    }
    return { typeCode: ColumnTypeCode.ID, data: encodeUint32Column(Uint32Array.from(ids, (id) => Number(id ?? 0))) };
}

/** Writes one non-nested column. Nested columns go through {@link encodeMapPropertyColumn}. */
function encodePropertyColumn(
    type: Exclude<PropertyType, "map">,
    values: PropertyValue[],
    nullable: boolean,
    stringEncoding: StringEncoding = "plain",
): Uint8Array {
    if (type === "string") {
        const strings = values.map((value) => (value === null ? null : String(value)));
        // The decoder is told how many streams the column holds: two for plain strings, three for a
        // dictionary, and one more for the presence stream of a nullable column.
        if (stringEncoding === "dictionary") {
            return concatenateBuffers(encodeVarintValue(nullable ? 4 : 3), encodeDictionaryStrings(strings));
        }
        return concatenateBuffers(encodeVarintValue(nullable ? 3 : 2), encodePlainStrings(strings));
    }

    if (type === "boolean") {
        const booleans = values.map((value) => (value === null ? null : Boolean(value)));
        return nullable ? encodeBooleanNullableColumn(booleans) : encodeBooleanColumn(booleans);
    }

    if (type === "int64" || type === "uint64") {
        const bigints = values.map((value) => (value === null ? null : BigInt(value as number | bigint)));
        if (type === "uint64") {
            return nullable ? encodeUint64NullableColumn(bigints) : encodeUint64Column(BigUint64Array.from(bigints));
        }
        return nullable ? encodeInt64NullableColumn(bigints) : encodeInt64NoneColumn(BigInt64Array.from(bigints));
    }

    const numbers = values.map((value) => (value === null ? null : Number(value)));
    if (type === "int32") {
        return nullable ? encodeInt32NullableColumn(numbers) : encodeInt32NoneColumn(Int32Array.from(numbers));
    }
    if (type === "float") {
        return nullable ? encodeFloatNullableColumn(numbers) : encodeFloatColumn(Float32Array.from(numbers));
    }
    return nullable ? encodeDoubleNullableColumn(numbers) : encodeDoubleColumn(Float64Array.from(numbers));
}

/**
 * Writes the geometry column: a stream of geometry types, the nested length streams, then the
 * vertex buffer.
 *
 * Which length streams are written depends on the geometry types in the layer, because the decoder
 * reads each combination differently. With a GEOMETRIES stream present it takes the part count of a
 * line string to be implicit, so writing the full set unconditionally would lose their vertex
 * counts. The four combinations below are the ones the decoder recognises:
 *
 * - multi + polygon: GEOMETRIES, PARTS (rings per polygon), RINGS (vertices per ring)
 * - multi, no polygon: GEOMETRIES, PARTS (vertices per line string)
 * - polygon, no multi: PARTS (rings per polygon), RINGS (vertices per ring)
 * - line strings only: PARTS (vertices per line string)
 * - points only: no length streams at all
 */
function encodeGeometryColumn(features: Feature[]): Uint8Array {
    const types = features.map((feature) => geometryTypeOf(feature.geometry));
    const levels = geometryLevels(types);
    const { hasPolygon } = levels;

    const geometryLengths: number[] = [];
    const partLengths: number[] = [];
    const ringLengths: number[] = [];
    const vertices: number[] = [];

    for (let index = 0; index < features.length; index++) {
        const feature = features[index];
        const type = types[index];
        // Every geometry is normalised to polygon -> ring -> position, so one walk covers them all.
        const polygons = toPolygons(feature.geometry);
        const polygonal = type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON;
        const linear = type === GEOMETRY_TYPE.LINESTRING || type === GEOMETRY_TYPE.MULTILINESTRING;

        if (type > GEOMETRY_TYPE.POLYGON) {
            geometryLengths.push(polygons.length);
        }

        for (const rings of polygons) {
            if (hasPolygon) {
                // PARTS is read only for polygons; RINGS covers everything except point types.
                if (polygonal) partLengths.push(rings.length);
                if (polygonal || linear) for (const ring of rings) ringLengths.push(ring.length);
            } else if (linear) {
                partLengths.push(rings[0].length);
            }

            for (const ring of rings) {
                for (let i = 0; i < ring.length; i++) vertices.push(ring[i][0], ring[i][1]);
            }
        }
    }

    return geometryStreams(types, levels, geometryLengths, partLengths, ringLengths, vertices);
}

/** Which length streams a geometry column has, see {@link encodeGeometryColumn}. */
type GeometryLevels = { hasMulti: boolean; hasPolygon: boolean; hasLine: boolean };

function geometryLevels(types: ArrayLike<number>): GeometryLevels {
    let hasMulti = false;
    let hasPolygon = false;
    let hasLine = false;
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        if (type > GEOMETRY_TYPE.POLYGON) hasMulti = true;
        if (type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON) hasPolygon = true;
        if (type === GEOMETRY_TYPE.LINESTRING || type === GEOMETRY_TYPE.MULTILINESTRING) hasLine = true;
    }
    return { hasMulti, hasPolygon, hasLine };
}

/** The streams of a geometry column, preceded by their count, from the lengths its features were walked into. */
function geometryStreams(
    types: ArrayLike<number>,
    { hasMulti, hasPolygon, hasLine }: GeometryLevels,
    geometryLengths: number[],
    partLengths: number[],
    ringLengths: number[],
    vertices: ArrayLike<number>,
): Uint8Array {
    const streams = [
        createStream(PhysicalStreamType.LENGTH, encodeVarints(Uint32Array.from(types)), {
            technique: PhysicalLevelTechnique.VARINT,
            count: types.length,
        }),
    ];

    if (hasMulti) streams.push(lengthStream(LengthType.GEOMETRIES, geometryLengths));
    if (hasMulti || hasPolygon || hasLine) streams.push(lengthStream(LengthType.PARTS, partLengths));
    if (hasPolygon) streams.push(lengthStream(LengthType.RINGS, ringLengths));

    streams.push(
        createStream(PhysicalStreamType.DATA, encodeZigZagVarintInt32(vertices), {
            logical: { dictionaryType: DictionaryType.VERTEX },
            technique: PhysicalLevelTechnique.VARINT,
            count: vertices.length,
        }),
    );

    return concatenateBuffers(encodeVarintValue(streams.length), ...streams);
}

function lengthStream(lengthType: LengthType, values: number[]): Uint8Array {
    return createStream(PhysicalStreamType.LENGTH, encodeVarints(values), {
        logical: { lengthType },
        technique: PhysicalLevelTechnique.VARINT,
        count: values.length,
    });
}

function geometryTypeOf(geometry: FeatureGeometry): number {
    switch (geometry.type) {
        case "Point":
            return GEOMETRY_TYPE.POINT;
        case "LineString":
            return GEOMETRY_TYPE.LINESTRING;
        case "Polygon":
            return GEOMETRY_TYPE.POLYGON;
        case "MultiPoint":
            return GEOMETRY_TYPE.MULTIPOINT;
        case "MultiLineString":
            return GEOMETRY_TYPE.MULTILINESTRING;
        case "MultiPolygon":
            return GEOMETRY_TYPE.MULTIPOLYGON;
    }
}

/** Normalises any geometry to polygon -> ring -> position, so one walk covers every type. */
function toPolygons(geometry: FeatureGeometry): Position[][][] {
    switch (geometry.type) {
        case "Point":
            return [[[geometry.coordinates]]];
        case "MultiPoint":
            return geometry.coordinates.map((position) => [[position]]);
        case "LineString":
            return [[geometry.coordinates]];
        case "MultiLineString":
            return geometry.coordinates.map((line) => [line]);
        case "Polygon":
            return [geometry.coordinates.map(openRing)];
        case "MultiPolygon":
            return geometry.coordinates.map((polygon) => polygon.map(openRing));
    }
}

/** Rings are stored without the repeated closing position; the decoder puts it back. */
function openRing(ring: Position[]): Position[] {
    if (ring.length < 2) return ring;
    const [firstX, firstY] = ring[0];
    const [lastX, lastY] = ring[ring.length - 1];
    return firstX === lastX && firstY === lastY ? ring.slice(0, -1) : ring;
}

function encodeVarints(values: number[] | Uint32Array): Uint8Array {
    return encodeVarintInt32(values instanceof Uint32Array ? values : Uint32Array.from(values));
}

function encodeVarintValue(value: number): Uint8Array {
    const buffer = new Uint8Array(5);
    const offset = new IntWrapper(0);
    encodeVarintInt32Value(value, buffer, offset);
    return buffer.slice(0, offset.get());
}

/**
 * Encodes layers given as columns, in the shape `decodeTileColumns` gives them, with the encodings
 * {@link encodeTile} writes. A tile read as columns, or sliced on its columns, is written without
 * an object for each feature.
 *
 * `decodeTileColumns` reads the same values back, but not always as the same columns: a `u32` or
 * `i64` column goes out as doubles and comes back as `f64`, a dictionary column keeps only the
 * entries its features use, and a column whose features all have a value comes back without `present`.
 */
export function encodeTileColumns(layers: readonly MltColumnLayer[]): Uint8Array {
    return concatenateBuffers(...layers.map(encodeColumnLayer));
}

function encodeColumnLayer(layer: MltColumnLayer): Uint8Array {
    const columns: Uint8Array[] = [];
    const metadata: Uint8Array[] = [];

    if (layer.ids) {
        const ids = encodeIdValues(layer.ids);
        metadata.push(encodeTypeCode(ids.typeCode));
        columns.push(ids.data);
    }

    metadata.push(encodeTypeCode(ColumnTypeCode.GEOMETRY));
    columns.push(encodeGeometryFromColumns(layer.geometry, layer.featureCount));

    for (const column of layer.properties) {
        const { scalarType, nullable, data } = encodePropertyValues(column, layer.featureCount);
        metadata.push(encodeTypeCode(scalarTypeCode(scalarType, nullable)), encodeFieldName(column.name));
        columns.push(data);
    }

    return layerBlock(layer.name, layer.extent, metadata, columns);
}

/**
 * Whether some of the first `count` features lack a value. A column whose features all have one is written as
 * not nullable, whatever its presence bits say: the string encoders write a presence stream only for a column
 * with absent values, and the stream count and type code have to agree with them.
 */
function lacksAValue(present: Uint8Array | undefined, count: number): boolean {
    if (!present) return false;
    for (let row = 0; row < count; row++) if (!isPresent(present, row)) return true;
    return false;
}

function isPresent(present: Uint8Array | undefined, row: number): boolean {
    return !present || (present[row >> 3] & (1 << (row & 7))) !== 0;
}

/** The value of each feature, or `null` for one without, as the nullable column encoders take them. */
function nullableValues<T>(present: Uint8Array | undefined, count: number, value: (row: number) => T): (T | null)[] {
    const values = new Array<T | null>(count);
    for (let row = 0; row < count; row++) values[row] = isPresent(present, row) ? value(row) : null;
    return values;
}

/**
 * An id of a column as the unsigned 64-bit integer it is written as. A double rounds the largest of them up to
 * `2 ** 64`, one more than the format holds, which is written as the largest it holds.
 */
function idValue(id: number): bigint {
    const value = BigInt(id);
    return value > UINT64_MAX ? UINT64_MAX : value;
}

function encodeIdValues(ids: MltColumn<Float64Array>): { typeCode: number; data: Uint8Array } {
    const { values, present } = ids;
    if (lacksAValue(present, values.length)) {
        return {
            typeCode: ColumnTypeCode.ID | ColumnTypeCode.ID_LONG | ColumnTypeCode.ID_NULLABLE,
            data: encodeUint64NullableColumn(nullableValues(present, values.length, (row) => idValue(values[row]))),
        };
    }
    if (values.some((id) => id > UINT32_MAX)) {
        return {
            typeCode: ColumnTypeCode.ID | ColumnTypeCode.ID_LONG,
            data: encodeUint64Column(BigUint64Array.from(values, idValue)),
        };
    }
    return { typeCode: ColumnTypeCode.ID, data: encodeUint32Column(Uint32Array.from(values)) };
}

/**
 * Writes the geometry of a layer from its offset levels, as {@link encodeGeometryColumn} writes the
 * same features: each geometry of a feature is walked as a polygon of rings, a line string or a
 * point as a polygon of one ring.
 */
function encodeGeometryFromColumns(geometry: MltGeometryColumns, featureCount: number): Uint8Array {
    const { types, vertices, geometryOffsets, partOffsets, ringOffsets } = geometry;
    const levels = geometryLevels(types);
    const { hasPolygon } = levels;
    const geometryLengths: number[] = [];
    const partLengths: number[] = [];
    const ringLengths: number[] = [];

    for (let feature = 0; feature < featureCount; feature++) {
        const type = types[feature];
        const polygonal = type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON;
        const linear = type === GEOMETRY_TYPE.LINESTRING || type === GEOMETRY_TYPE.MULTILINESTRING;
        const first = geometryOffsets ? geometryOffsets[feature] : feature;
        const end = geometryOffsets ? geometryOffsets[feature + 1] : feature + 1;
        if (type > GEOMETRY_TYPE.POLYGON) geometryLengths.push(end - first);

        for (let part = first; part < end; part++) {
            const firstRing = ringOffsets ? partOffsets[part] : part;
            const endRing = ringOffsets ? partOffsets[part + 1] : part + 1;

            if (hasPolygon) {
                if (polygonal) partLengths.push(endRing - firstRing);
                if (polygonal || linear)
                    for (let ring = firstRing; ring < endRing; ring++) ringLengths.push(vertexCount(geometry, ring));
            } else if (linear) {
                partLengths.push(vertexCount(geometry, firstRing));
            }
        }
    }

    return geometryStreams(types, levels, geometryLengths, partLengths, ringLengths, vertices);
}

/** The number of vertices of a ring, or of the line string or point that stands in its place, from the last offset level. */
function vertexCount({ partOffsets, ringOffsets }: MltGeometryColumns, ring: number): number {
    if (ringOffsets) return ringOffsets[ring + 1] - ringOffsets[ring];
    return partOffsets ? partOffsets[ring + 1] - partOffsets[ring] : 1;
}

/**
 * Writes the values of a property column and the scalar type it is stored as. A dictionary column
 * keeps the entries its features use, in the order they first use them, as {@link encodeDictionaryStrings}
 * numbers them. A column of 64-bit integers, whose values come as doubles, is written as doubles.
 */
function encodePropertyValues(
    column: MltPropertyColumn,
    count: number,
): { scalarType: number; nullable: boolean; data: Uint8Array } {
    const present = lacksAValue(column.present, count) ? column.present : undefined;
    const nullable = present !== undefined;

    if ("codes" in column) {
        const remap = new Int32Array(column.dictionary.length).fill(-1);
        const entries: string[] = [];
        const codes = new Uint32Array(count);
        let coded = 0;
        for (let row = 0; row < count; row++) {
            if (!isPresent(present, row)) continue;
            const code = column.codes[row];
            if (remap[code] < 0) {
                remap[code] = entries.length;
                entries.push(column.dictionary[code]);
            }
            codes[coded++] = remap[code];
        }
        const presence = nullable ? Array.from({ length: count }, (_, row) => isPresent(present, row)) : undefined;
        const data = encodeDictionaryCodes(entries, codes.subarray(0, coded), presence);
        return {
            scalarType: ScalarType.STRING,
            nullable,
            data: concatenateBuffers(encodeVarintValue(nullable ? 4 : 3), data),
        };
    }

    switch (column.type) {
        case "string": {
            const strings = nullableValues(present, count, (row) => column.values[row]);
            return {
                scalarType: ScalarType.STRING,
                nullable,
                data: concatenateBuffers(encodeVarintValue(nullable ? 3 : 2), encodePlainStrings(strings)),
            };
        }
        case "bool": {
            const booleans = nullableValues(present, count, (row) => column.values[row] === 1);
            return {
                scalarType: ScalarType.BOOLEAN,
                nullable,
                data: nullable ? encodeBooleanNullableColumn(booleans) : encodeBooleanColumn(booleans),
            };
        }
        case "i32":
            return {
                scalarType: ScalarType.INT_32,
                nullable,
                data: nullable
                    ? encodeInt32NullableColumn(nullableValues(present, count, (row) => column.values[row]))
                    : encodeInt32NoneColumn(column.values),
            };
        case "u32":
            return {
                scalarType: ScalarType.UINT_32,
                nullable,
                data: nullable
                    ? encodeUint32NullableColumn(nullableValues(present, count, (row) => column.values[row]))
                    : encodeUint32Column(column.values),
            };
        case "f32":
            return {
                scalarType: ScalarType.FLOAT,
                nullable,
                data: nullable
                    ? encodeFloatNullableColumn(nullableValues(present, count, (row) => column.values[row]))
                    : encodeFloatColumn(column.values),
            };
        case "i64":
        case "f64":
            return {
                scalarType: ScalarType.DOUBLE,
                nullable,
                data: nullable
                    ? encodeDoubleNullableColumn(nullableValues(present, count, (row) => column.values[row]))
                    : encodeDoubleColumn(column.values),
            };
    }
}
