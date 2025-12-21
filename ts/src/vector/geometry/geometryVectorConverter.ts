import { type GeometryVector, type MortonSettings, type CoordinatesArray } from "./geometryVector";
import { decodeZOrderCurve } from "./zOrderCurve";
import { GEOMETRY_TYPE } from "./geometryType";
import { VertexBufferType } from "./vertexBufferType";
import Point from "@mapbox/point-geometry";

class MvtGeometryFactory {
    createPoint(coordinate: Point): CoordinatesArray {
        return [[coordinate]];
    }

    createMultiPoint(points: Point[]): CoordinatesArray {
        return points.map((point) => [point]);
    }

    createLineString(vertices: Point[]): CoordinatesArray {
        return [vertices];
    }

    createMultiLineString(lineStrings: Array<Array<Point>>): CoordinatesArray {
        return lineStrings;
    }

    createPolygon(shell: Point[], rings: Array<Array<Point>>): CoordinatesArray {
        return [shell].concat(rings);
    }

    createMultiPolygon(polygons: Array<Array<Point>>[]): CoordinatesArray {
        //TODO: check winding order of shell and holes
        return polygons.flat();
    }
}

function hasDictionaryEncoding(vertexOffsets: Int32Array | null | undefined): vertexOffsets is Int32Array {
    return !!vertexOffsets && vertexOffsets.length > 0;
}

function requireMortonSettings(mortonSettings: MortonSettings | undefined): MortonSettings {
    if (!mortonSettings) {
        throw new Error("Morton settings are missing for a morton-encoded geometry vector.");
    }
    return mortonSettings;
}

function decodePointAtVertexIndex(geometryVector: GeometryVector, vertexIndex: number): Point {
    const vertexBuffer = geometryVector.vertexBuffer;
    const vertexOffsets = geometryVector.vertexOffsets;

    if (!hasDictionaryEncoding(vertexOffsets)) {
        const vertexBufferOffset = vertexIndex * 2;
        return new Point(vertexBuffer[vertexBufferOffset], vertexBuffer[vertexBufferOffset + 1]);
    }

    if (geometryVector.vertexBufferType === VertexBufferType.VEC_2) {
        const vertexBufferOffset = vertexOffsets[vertexIndex] * 2;
        return new Point(vertexBuffer[vertexBufferOffset], vertexBuffer[vertexBufferOffset + 1]);
    }

    const mortonSettings = requireMortonSettings(geometryVector.mortonSettings);
    const mortonCodeOffset = vertexOffsets[vertexIndex];
    const mortonCode = vertexBuffer[mortonCodeOffset];
    const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
    return new Point(vertex.x, vertex.y);
}

function decodeLineStringAtVertexIndex(
    geometryVector: GeometryVector,
    startVertexIndex: number,
    numVertices: number,
    closeLineString: boolean,
): Point[] {
    const vertexBuffer = geometryVector.vertexBuffer;
    const vertexOffsets = geometryVector.vertexOffsets;

    if (!hasDictionaryEncoding(vertexOffsets)) {
        return getLineString(vertexBuffer, startVertexIndex * 2, numVertices, closeLineString);
    }

    return geometryVector.vertexBufferType === VertexBufferType.VEC_2
        ? decodeDictionaryEncodedLineString(vertexBuffer, vertexOffsets, startVertexIndex, numVertices, closeLineString)
        : decodeMortonDictionaryEncodedLineString(
            vertexBuffer,
            vertexOffsets,
            startVertexIndex,
            numVertices,
            closeLineString,
            requireMortonSettings(geometryVector.mortonSettings),
        );
}

function decodeMultiPointAtVertexIndex(
    geometryVector: GeometryVector,
    startVertexIndex: number,
    numPoints: number,
): CoordinatesArray {
    const vertexBuffer = geometryVector.vertexBuffer;
    const vertexOffsets = geometryVector.vertexOffsets;

    const points: CoordinatesArray = new Array(numPoints);

    if (!hasDictionaryEncoding(vertexOffsets)) {
        for (let i = 0; i < numPoints; i++) {
            const vertexBufferOffset = (startVertexIndex + i) * 2;
            points[i] = [new Point(vertexBuffer[vertexBufferOffset], vertexBuffer[vertexBufferOffset + 1])];
        }
        return points;
    }

    if (geometryVector.vertexBufferType === VertexBufferType.VEC_2) {
        for (let i = 0; i < numPoints; i++) {
            const vertexBufferOffset = vertexOffsets[startVertexIndex + i] * 2;
            points[i] = [new Point(vertexBuffer[vertexBufferOffset], vertexBuffer[vertexBufferOffset + 1])];
        }
        return points;
    }

    const mortonSettings = requireMortonSettings(geometryVector.mortonSettings);
    for (let i = 0; i < numPoints; i++) {
        const mortonCodeOffset = vertexOffsets[startVertexIndex + i];
        const mortonCode = vertexBuffer[mortonCodeOffset];
        const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
        points[i] = [new Point(vertex.x, vertex.y)];
    }
    return points;
}

export function convertGeometryVector(geometryVector: GeometryVector): CoordinatesArray[] {
    const geometries: CoordinatesArray[] = new Array(geometryVector.numGeometries);
    let partOffsetCounter = 1;
    let ringOffsetsCounter = 1;
    let geometryOffsetsCounter = 1;
    let geometryCounter = 0;
    const geometryFactory = new MvtGeometryFactory();
    let vertexBufferOffset = 0;
    let vertexOffsetsOffset = 0;

    const topologyVector = geometryVector.topologyVector;
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;
    const vertexOffsets = geometryVector.vertexOffsets;

    const containsPolygon = geometryVector.containsPolygonGeometry();

    for (let i = 0; i < geometryVector.numGeometries; i++) {
        const geometryType = geometryVector.geometryType(i);
        if (geometryType === GEOMETRY_TYPE.POINT) {
            if (!vertexOffsets || vertexOffsets.length === 0) {
                const coordinate = decodePointAtVertexIndex(geometryVector, vertexBufferOffset / 2);
                vertexBufferOffset += 2;
                geometries[geometryCounter++] = geometryFactory.createPoint(coordinate);
            } else {
                const coordinate = decodePointAtVertexIndex(geometryVector, vertexOffsetsOffset++);
                geometries[geometryCounter++] = geometryFactory.createPoint(coordinate);
            }

            if (geometryOffsets) geometryOffsetsCounter++;
            if (partOffsets) partOffsetCounter++;
            if (ringOffsets) ringOffsetsCounter++;
        } else if (geometryType === GEOMETRY_TYPE.MULTIPOINT) {
            const numPoints = geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
            geometryOffsetsCounter++;
            if (!vertexOffsets || vertexOffsets.length === 0) {
                const startVertexIndex = vertexBufferOffset / 2;
                geometries[geometryCounter++] = decodeMultiPointAtVertexIndex(geometryVector, startVertexIndex, numPoints);
                vertexBufferOffset += numPoints * 2;
            } else {
                geometries[geometryCounter++] = decodeMultiPointAtVertexIndex(geometryVector, vertexOffsetsOffset, numPoints);
                vertexOffsetsOffset += numPoints;
            }
        } else if (geometryType === GEOMETRY_TYPE.LINESTRING) {
            let numVertices = 0;
            if (containsPolygon) {
                numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                ringOffsetsCounter++;
            } else {
                numVertices = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
            }
            partOffsetCounter++;

            let vertices: Point[];
            if (!vertexOffsets || vertexOffsets.length === 0) {
                const startVertexIndex = vertexBufferOffset / 2;
                vertices = decodeLineStringAtVertexIndex(geometryVector, startVertexIndex, numVertices, false);
                vertexBufferOffset += numVertices * 2;
            } else {
                vertices = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, false);
                vertexOffsetsOffset += numVertices;
            }

            geometries[geometryCounter++] = geometryFactory.createLineString(vertices);

            if (geometryOffsets) geometryOffsetsCounter++;
        } else if (geometryType === GEOMETRY_TYPE.POLYGON) {
            const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
            partOffsetCounter++;
            const rings: CoordinatesArray = new Array(numRings - 1);
            let numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
            ringOffsetsCounter++;

            if (!vertexOffsets || vertexOffsets.length === 0) {
                const shellStartVertexIndex = vertexBufferOffset / 2;
                const shell = decodeLineStringAtVertexIndex(geometryVector, shellStartVertexIndex, numVertices, true);
                vertexBufferOffset += numVertices * 2;
                for (let j = 0; j < rings.length; j++) {
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    const startVertexIndex = vertexBufferOffset / 2;
                    rings[j] = decodeLineStringAtVertexIndex(geometryVector, startVertexIndex, numVertices, true);
                    vertexBufferOffset += numVertices * 2;
                }
                geometries[geometryCounter++] = geometryFactory.createPolygon(shell, rings);
            } else {
                const shell = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, true);
                vertexOffsetsOffset += numVertices;
                for (let j = 0; j < rings.length; j++) {
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    rings[j] = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, true);
                    vertexOffsetsOffset += numVertices;
                }
                geometries[geometryCounter++] = geometryFactory.createPolygon(shell, rings);
            }

            if (geometryOffsets) geometryOffsetsCounter++;
        } else if (geometryType === GEOMETRY_TYPE.MULTILINESTRING) {
            const numLineStrings =
                geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
            geometryOffsetsCounter++;
            const lineStrings: CoordinatesArray = new Array(numLineStrings);
            if (!vertexOffsets || vertexOffsets.length === 0) {
                for (let j = 0; j < numLineStrings; j++) {
                    let numVertices = 0;
                    if (containsPolygon) {
                        numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                    } else {
                        numVertices = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    }
                    partOffsetCounter++;

                    const startVertexIndex = vertexBufferOffset / 2;
                    lineStrings[j] = decodeLineStringAtVertexIndex(geometryVector, startVertexIndex, numVertices, false);
                    vertexBufferOffset += numVertices * 2;
                }
                geometries[geometryCounter++] = geometryFactory.createMultiLineString(lineStrings);
            } else {
                for (let j = 0; j < numLineStrings; j++) {
                    let numVertices = 0;
                    if (containsPolygon) {
                        numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                    } else {
                        numVertices = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    }
                    partOffsetCounter++;

                    const vertices = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, false);
                    lineStrings[j] = vertices;
                    vertexOffsetsOffset += numVertices;
                }
                geometries[geometryCounter++] = geometryFactory.createMultiLineString(lineStrings);
            }
        } else if (geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
            const numPolygons = geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
            geometryOffsetsCounter++;
            const polygons: CoordinatesArray[] = new Array(numPolygons);
            let numVertices = 0;
            if (!vertexOffsets || vertexOffsets.length === 0) {
                for (let j = 0; j < numPolygons; j++) {
                    const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    partOffsetCounter++;
                    const rings: CoordinatesArray = new Array(numRings - 1);
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    const shellStartVertexIndex = vertexBufferOffset / 2;
                    const shell = decodeLineStringAtVertexIndex(geometryVector, shellStartVertexIndex, numVertices, true);
                    vertexBufferOffset += numVertices * 2;
                    for (let k = 0; k < rings.length; k++) {
                        const numRingVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        const startVertexIndex = vertexBufferOffset / 2;
                        rings[k] = decodeLineStringAtVertexIndex(geometryVector, startVertexIndex, numRingVertices, true);
                        vertexBufferOffset += numRingVertices * 2;
                    }

                    polygons[j] = geometryFactory.createPolygon(shell, rings);
                }
                geometries[geometryCounter++] = geometryFactory.createMultiPolygon(polygons);
            } else {
                for (let j = 0; j < numPolygons; j++) {
                    const numRings = partOffsets[partOffsetCounter] - partOffsets[partOffsetCounter - 1];
                    partOffsetCounter++;
                    const rings: CoordinatesArray = new Array(numRings - 1);
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    const shell = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, true);
                    vertexOffsetsOffset += numVertices;
                    for (let k = 0; k < rings.length; k++) {
                        numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        rings[k] = decodeLineStringAtVertexIndex(geometryVector, vertexOffsetsOffset, numVertices, true);
                        vertexOffsetsOffset += numVertices;
                    }

                    polygons[j] = geometryFactory.createPolygon(shell, rings);
                }
                geometries[geometryCounter++] = geometryFactory.createMultiPolygon(polygons);
            }
        } else {
            throw new Error("The specified geometry type is currently not supported.");
        }
    }

    return geometries;
}

/**
 * Converts a single geometry at the specified index from the geometry vector.
 * For single-type vectors, this attempts to decode only the requested geometry.
 * For mixed-type vectors, this attempts to decode only the requested geometry when possible,
 * otherwise it falls back to decoding all geometries.
 *
 * @param geometryVector - The geometry vector containing geometries
 * @param index - The index of the geometry to convert
 * @returns The coordinates array for the geometry at the specified index
 * @throws RangeError if index is out of bounds
 */
export function convertSingleGeometry(geometryVector: GeometryVector, index: number): CoordinatesArray {
    if (index < 0 || index >= geometryVector.numGeometries) {
        throw new RangeError(
            `Geometry index ${index} out of bounds. Valid range: 0 to ${geometryVector.numGeometries - 1}`,
        );
    }

    const topologyVector = geometryVector.topologyVector;
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;

    if (!geometryVector.containsSingleGeometryType()) {
        const geometryType = geometryVector.geometryType(index);

        if (geometryOffsets) {
            if (geometryType === GEOMETRY_TYPE.POINT || geometryType === GEOMETRY_TYPE.MULTIPOINT) {
                const rootStart = geometryOffsets[index];
                const rootEnd = geometryOffsets[index + 1];

                // In mixed-type vectors, root offsets count geometries, not vertices. Use the topology buffers
                // to derive the vertex range for this (multi)point geometry.
                let start = rootStart;
                let end = rootEnd;
                if (ringOffsets && partOffsets) {
                    const partStart = partOffsets[rootStart];
                    const partEnd = partOffsets[rootEnd];
                    start = ringOffsets[partStart];
                    end = ringOffsets[partEnd];
                } else if (partOffsets) {
                    start = partOffsets[rootStart];
                    end = partOffsets[rootEnd];
                }

                const numPoints = end - start;

                if (geometryType === GEOMETRY_TYPE.POINT) {
                    return [[decodePointAtVertexIndex(geometryVector, start)]];
                }

                return decodeMultiPointAtVertexIndex(geometryVector, start, numPoints);
            }

            if (
                (geometryType === GEOMETRY_TYPE.LINESTRING || geometryType === GEOMETRY_TYPE.MULTILINESTRING) &&
                partOffsets
            ) {
                const lineStart = geometryOffsets[index];
                const lineEnd = geometryOffsets[index + 1];
                const numLines = lineEnd - lineStart;
                const lineStrings: Array<Array<Point>> = new Array(numLines);

                if (ringOffsets) {
                    for (let lineIndex = 0; lineIndex < numLines; lineIndex++) {
                        const globalLineIndex = lineStart + lineIndex;
                        const ringIndex = partOffsets[globalLineIndex];
                        const start = ringOffsets[ringIndex];
                        const end = ringOffsets[ringIndex + 1];
                        const numVertices = end - start;
                        lineStrings[lineIndex] = decodeLineStringAtVertexIndex(geometryVector, start, numVertices, false);
                    }
                } else {
                    for (let lineIndex = 0; lineIndex < numLines; lineIndex++) {
                        const globalLineIndex = lineStart + lineIndex;
                        const start = partOffsets[globalLineIndex];
                        const end = partOffsets[globalLineIndex + 1];
                        const numVertices = end - start;
                        lineStrings[lineIndex] = decodeLineStringAtVertexIndex(geometryVector, start, numVertices, false);
                    }
                }

                return geometryType === GEOMETRY_TYPE.LINESTRING ? [lineStrings[0]] : lineStrings;
            }

            if (
                (geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON) &&
                partOffsets &&
                ringOffsets
            ) {
                const polygonStart = geometryOffsets[index];
                const polygonEnd = geometryOffsets[index + 1];
                const allRings: Array<Array<Point>> = [];
                for (let polygonIndex = polygonStart; polygonIndex < polygonEnd; polygonIndex++) {
                    const ringStart = partOffsets[polygonIndex];
                    const ringEnd = partOffsets[polygonIndex + 1];
                    for (let ringIndex = ringStart; ringIndex < ringEnd; ringIndex++) {
                        const start = ringOffsets[ringIndex];
                        const end = ringOffsets[ringIndex + 1];
                        const numVertices = end - start;
                        allRings.push(decodeLineStringAtVertexIndex(geometryVector, start, numVertices, true));
                    }
                }

                return allRings;
            }
        }

        return convertGeometryVector(geometryVector)[index];
    }

    const geometryType = geometryVector.geometryType(0);

    switch (geometryType) {
        case GEOMETRY_TYPE.POINT: {
            return [[decodePointAtVertexIndex(geometryVector, index)]];
        }
        case GEOMETRY_TYPE.MULTIPOINT: {
            if (!geometryOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const start = geometryOffsets[index];
            const end = geometryOffsets[index + 1];
            return decodeMultiPointAtVertexIndex(geometryVector, start, end - start);
        }
        case GEOMETRY_TYPE.LINESTRING: {
            if (!partOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const start = partOffsets[index];
            const end = partOffsets[index + 1];
            const numVertices = end - start;

            return [decodeLineStringAtVertexIndex(geometryVector, start, numVertices, false)];
        }
        case GEOMETRY_TYPE.MULTILINESTRING: {
            if (!geometryOffsets || !partOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const lineStart = geometryOffsets[index];
            const lineEnd = geometryOffsets[index + 1];
            const numLines = lineEnd - lineStart;
            const lineStrings: Array<Array<Point>> = new Array(numLines);
            for (let lineIndex = 0; lineIndex < numLines; lineIndex++) {
                const globalLineIndex = lineStart + lineIndex;
                const start = partOffsets[globalLineIndex];
                const end = partOffsets[globalLineIndex + 1];
                const numVertices = end - start;
                lineStrings[lineIndex] = decodeLineStringAtVertexIndex(geometryVector, start, numVertices, false);
            }
            return lineStrings;
        }
        case GEOMETRY_TYPE.POLYGON: {
            if (!partOffsets || !ringOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const ringStart = partOffsets[index];
            const ringEnd = partOffsets[index + 1];
            const numRings = ringEnd - ringStart;
            const rings: Array<Array<Point>> = new Array(numRings);
            for (let ringIndex = 0; ringIndex < numRings; ringIndex++) {
                const globalRingIndex = ringStart + ringIndex;
                const start = ringOffsets[globalRingIndex];
                const end = ringOffsets[globalRingIndex + 1];
                const numVertices = end - start;
                rings[ringIndex] = decodeLineStringAtVertexIndex(geometryVector, start, numVertices, true);
            }
            return rings;
        }
        case GEOMETRY_TYPE.MULTIPOLYGON: {
            if (!geometryOffsets || !partOffsets || !ringOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const polygonStart = geometryOffsets[index];
            const polygonEnd = geometryOffsets[index + 1];
            const allRings: Array<Array<Point>> = [];
            for (let polygonIndex = polygonStart; polygonIndex < polygonEnd; polygonIndex++) {
                const ringStart = partOffsets[polygonIndex];
                const ringEnd = partOffsets[polygonIndex + 1];
                for (let ringIndex = ringStart; ringIndex < ringEnd; ringIndex++) {
                    const start = ringOffsets[ringIndex];
                    const end = ringOffsets[ringIndex + 1];
                    const numVertices = end - start;
                    allRings.push(decodeLineStringAtVertexIndex(geometryVector, start, numVertices, true));
                }
            }
            return allRings;
        }
        default:
            return convertGeometryVector(geometryVector)[index];
    }
}

function getLineString(
    vertexBuffer: Int32Array,
    startIndex: number,
    numVertices: number,
    closeLineString: boolean,
): Point[] {
    const vertices: Point[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices * 2; i += 2) {
        const x = vertexBuffer[startIndex + i];
        const y = vertexBuffer[startIndex + i + 1];
        vertices[i / 2] = new Point(x, y);
    }

    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }
    return vertices;
}

function decodeDictionaryEncodedLineString(
    vertexBuffer: Int32Array,
    vertexOffsets: Int32Array,
    vertexOffset: number,
    numVertices: number,
    closeLineString: boolean,
): Point[] {
    const vertices: Point[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices * 2; i += 2) {
        const offset = vertexOffsets[vertexOffset + i / 2] * 2;
        const x = vertexBuffer[offset];
        const y = vertexBuffer[offset + 1];
        vertices[i / 2] = new Point(x, y);
    }

    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }
    return vertices;
}

function decodeMortonDictionaryEncodedLineString(
    vertexBuffer: Int32Array,
    vertexOffsets: Int32Array,
    vertexOffset: number,
    numVertices: number,
    closeLineString: boolean,
    mortonSettings: MortonSettings,
): Point[] {
    const vertices: Point[] = new Array(closeLineString ? numVertices + 1 : numVertices);
    for (let i = 0; i < numVertices; i++) {
        const offset = vertexOffsets[vertexOffset + i];
        const mortonEncodedVertex = vertexBuffer[offset];
        const vertex = decodeZOrderCurve(mortonEncodedVertex, mortonSettings.numBits, mortonSettings.coordinateShift);
        vertices[i] = new Point(vertex.x, vertex.y);
    }
    if (closeLineString) {
        vertices[vertices.length - 1] = vertices[0];
    }

    return vertices;
}
