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

export function convertGeometryVector(geometryVector: GeometryVector): CoordinatesArray[] {
    const geometries: CoordinatesArray[] = new Array(geometryVector.numGeometries);
    let partOffsetCounter = 1;
    let ringOffsetsCounter = 1;
    let geometryOffsetsCounter = 1;
    let geometryCounter = 0;
    const geometryFactory = new MvtGeometryFactory();
    let vertexBufferOffset = 0;
    let vertexOffsetsOffset = 0;

    const mortonSettings = geometryVector.mortonSettings;
    const topologyVector = geometryVector.topologyVector;
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;
    const vertexOffsets = geometryVector.vertexOffsets;

    const containsPolygon = geometryVector.containsPolygonGeometry();
    const vertexBuffer = geometryVector.vertexBuffer;

    for (let i = 0; i < geometryVector.numGeometries; i++) {
        const geometryType = geometryVector.geometryType(i);
        if (geometryType === GEOMETRY_TYPE.POINT) {
            if (!vertexOffsets || vertexOffsets.length === 0) {
                const x = vertexBuffer[vertexBufferOffset++];
                const y = vertexBuffer[vertexBufferOffset++];
                const coordinate = new Point(x, y);
                geometries[geometryCounter++] = geometryFactory.createPoint(coordinate);
            } else if (geometryVector.vertexBufferType === VertexBufferType.VEC_2) {
                const offset = vertexOffsets[vertexOffsetsOffset++] * 2;
                const x = vertexBuffer[offset];
                const y = vertexBuffer[offset + 1];
                const coordinate = new Point(x, y);
                geometries[geometryCounter++] = geometryFactory.createPoint(coordinate);
            } else {
                const offset = vertexOffsets[vertexOffsetsOffset++];
                const mortonCode = vertexBuffer[offset];
                const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
                const coordinate = new Point(vertex.x, vertex.y);
                geometries[geometryCounter++] = geometryFactory.createPoint(coordinate);
            }

            if (geometryOffsets) geometryOffsetsCounter++;
            if (partOffsets) partOffsetCounter++;
            if (ringOffsets) ringOffsetsCounter++;
        } else if (geometryType === GEOMETRY_TYPE.MULTIPOINT) {
            const numPoints = geometryOffsets[geometryOffsetsCounter] - geometryOffsets[geometryOffsetsCounter - 1];
            geometryOffsetsCounter++;
            const points: Point[] = new Array(numPoints);
            if (!vertexOffsets || vertexOffsets.length === 0) {
                for (let j = 0; j < numPoints; j++) {
                    const x = vertexBuffer[vertexBufferOffset++];
                    const y = vertexBuffer[vertexBufferOffset++];
                    points[j] = new Point(x, y);
                }
                geometries[geometryCounter++] = geometryFactory.createMultiPoint(points);
            } else {
                for (let j = 0; j < numPoints; j++) {
                    const offset = vertexOffsets[vertexOffsetsOffset++] * 2;
                    const x = vertexBuffer[offset];
                    const y = vertexBuffer[offset + 1];
                    points[j] = new Point(x, y);
                }
                geometries[geometryCounter++] = geometryFactory.createMultiPoint(points);
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
                vertices = getLineString(vertexBuffer, vertexBufferOffset, numVertices, false);
                vertexBufferOffset += numVertices * 2;
            } else {
                vertices =
                    geometryVector.vertexBufferType === VertexBufferType.VEC_2
                        ? decodeDictionaryEncodedLineString(
                              vertexBuffer,
                              vertexOffsets,
                              vertexOffsetsOffset,
                              numVertices,
                              false,
                          )
                        : decodeMortonDictionaryEncodedLineString(
                              vertexBuffer,
                              vertexOffsets,
                              vertexOffsetsOffset,
                              numVertices,
                              false,
                              mortonSettings,
                          );
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
                const shell = getLinearRing(vertexBuffer, vertexBufferOffset, numVertices);
                vertexBufferOffset += numVertices * 2;
                for (let j = 0; j < rings.length; j++) {
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    rings[j] = getLinearRing(vertexBuffer, vertexBufferOffset, numVertices);
                    vertexBufferOffset += numVertices * 2;
                }
                geometries[geometryCounter++] = geometryFactory.createPolygon(shell, rings);
            } else {
                const shell =
                    geometryVector.vertexBufferType === VertexBufferType.VEC_2
                        ? decodeDictionaryEncodedLinearRing(
                              vertexBuffer,
                              vertexOffsets,
                              vertexOffsetsOffset,
                              numVertices,
                          )
                        : decodeMortonDictionaryEncodedLinearRing(
                              vertexBuffer,
                              vertexOffsets,
                              vertexOffsetsOffset,
                              numVertices,
                              geometryFactory,
                              mortonSettings,
                          );
                vertexOffsetsOffset += numVertices;
                for (let j = 0; j < rings.length; j++) {
                    numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                    ringOffsetsCounter++;
                    rings[j] =
                        geometryVector.vertexBufferType === VertexBufferType.VEC_2
                            ? decodeDictionaryEncodedLinearRing(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                              )
                            : decodeMortonDictionaryEncodedLinearRing(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                                  geometryFactory,
                                  mortonSettings,
                              );
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

                    lineStrings[j] = getLineString(vertexBuffer, vertexBufferOffset, numVertices, false);
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

                    const vertices =
                        geometryVector.vertexBufferType === VertexBufferType.VEC_2
                            ? decodeDictionaryEncodedLineString(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                                  false,
                              )
                            : decodeMortonDictionaryEncodedLineString(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                                  false,
                                  mortonSettings,
                              );
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
                    const shell = getLinearRing(vertexBuffer, vertexBufferOffset, numVertices);
                    vertexBufferOffset += numVertices * 2;
                    for (let k = 0; k < rings.length; k++) {
                        const numRingVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        rings[k] = getLinearRing(vertexBuffer, vertexBufferOffset, numRingVertices);
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
                    const shell =
                        geometryVector.vertexBufferType === VertexBufferType.VEC_2
                            ? decodeDictionaryEncodedLinearRing(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                              )
                            : decodeMortonDictionaryEncodedLinearRing(
                                  vertexBuffer,
                                  vertexOffsets,
                                  vertexOffsetsOffset,
                                  numVertices,
                                  geometryFactory,
                                  mortonSettings,
                              );
                    vertexOffsetsOffset += numVertices;
                    for (let k = 0; k < rings.length; k++) {
                        numVertices = ringOffsets[ringOffsetsCounter] - ringOffsets[ringOffsetsCounter - 1];
                        ringOffsetsCounter++;
                        rings[k] =
                            geometryVector.vertexBufferType === VertexBufferType.VEC_2
                                ? decodeDictionaryEncodedLinearRing(
                                      vertexBuffer,
                                      vertexOffsets,
                                      vertexOffsetsOffset,
                                      numVertices,
                                  )
                                : decodeMortonDictionaryEncodedLinearRing(
                                      vertexBuffer,
                                      vertexOffsets,
                                      vertexOffsetsOffset,
                                      numVertices,
                                      geometryFactory,
                                      mortonSettings,
                                  );
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
 * For mixed-type vectors, this falls back to decoding all geometries.
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

    if (!geometryVector.containsSingleGeometryType()) {
        return convertGeometryVector(geometryVector)[index];
    }

    const geometryType = geometryVector.geometryType(0);
    const vertexBuffer = geometryVector.vertexBuffer;
    const vertexOffsets = geometryVector.vertexOffsets;
    const mortonSettings = geometryVector.mortonSettings;
    const topologyVector = geometryVector.topologyVector;
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    const ringOffsets = topologyVector.ringOffsets;

    switch (geometryType) {
        case GEOMETRY_TYPE.POINT: {
            if (!vertexOffsets || vertexOffsets.length === 0) {
                const vertexBufferOffset = index * 2;
                const x = vertexBuffer[vertexBufferOffset];
                const y = vertexBuffer[vertexBufferOffset + 1];
                return [[new Point(x, y)]];
            }

            if (geometryVector.vertexBufferType === VertexBufferType.VEC_2) {
                const vertexBufferOffset = vertexOffsets[index] * 2;
                const x = vertexBuffer[vertexBufferOffset];
                const y = vertexBuffer[vertexBufferOffset + 1];
                return [[new Point(x, y)]];
            }

            if (!mortonSettings) {
                throw new Error("Morton settings are missing for a morton-encoded geometry vector.");
            }

            const mortonCodeOffset = vertexOffsets[index];
            const mortonCode = vertexBuffer[mortonCodeOffset];
            const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
            return [[new Point(vertex.x, vertex.y)]];
        }
        case GEOMETRY_TYPE.MULTIPOINT: {
            if (!geometryOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const start = geometryOffsets[index];
            const end = geometryOffsets[index + 1];
            const numPoints = end - start;
            const points: Point[] = new Array(numPoints);
            if (!vertexOffsets || vertexOffsets.length === 0) {
                for (let i = 0; i < numPoints; i++) {
                    const vertexBufferOffset = (start + i) * 2;
                    const x = vertexBuffer[vertexBufferOffset];
                    const y = vertexBuffer[vertexBufferOffset + 1];
                    points[i] = new Point(x, y);
                }
            } else if (geometryVector.vertexBufferType === VertexBufferType.VEC_2) {
                for (let i = 0; i < numPoints; i++) {
                    const vertexBufferOffset = vertexOffsets[start + i] * 2;
                    const x = vertexBuffer[vertexBufferOffset];
                    const y = vertexBuffer[vertexBufferOffset + 1];
                    points[i] = new Point(x, y);
                }
            } else {
                if (!mortonSettings) {
                    throw new Error("Morton settings are missing for a morton-encoded geometry vector.");
                }
                for (let i = 0; i < numPoints; i++) {
                    const mortonCodeOffset = vertexOffsets[start + i];
                    const mortonCode = vertexBuffer[mortonCodeOffset];
                    const vertex = decodeZOrderCurve(mortonCode, mortonSettings.numBits, mortonSettings.coordinateShift);
                    points[i] = new Point(vertex.x, vertex.y);
                }
            }
            return points.map((point) => [point]);
        }
        case GEOMETRY_TYPE.LINESTRING: {
            if (!partOffsets) {
                return convertGeometryVector(geometryVector)[index];
            }
            const start = partOffsets[index];
            const end = partOffsets[index + 1];
            const numVertices = end - start;

            if (!vertexOffsets || vertexOffsets.length === 0) {
                return [getLineString(vertexBuffer, start * 2, numVertices, false)];
            }

            return [
                geometryVector.vertexBufferType === VertexBufferType.VEC_2
                    ? decodeDictionaryEncodedLineString(vertexBuffer, vertexOffsets, start, numVertices, false)
                    : decodeMortonDictionaryEncodedLineString(
                          vertexBuffer,
                          vertexOffsets,
                          start,
                          numVertices,
                          false,
                          mortonSettings,
                      ),
            ];
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
                if (!vertexOffsets || vertexOffsets.length === 0) {
                    lineStrings[lineIndex] = getLineString(vertexBuffer, start * 2, numVertices, false);
                } else {
                    lineStrings[lineIndex] =
                        geometryVector.vertexBufferType === VertexBufferType.VEC_2
                            ? decodeDictionaryEncodedLineString(vertexBuffer, vertexOffsets, start, numVertices, false)
                            : decodeMortonDictionaryEncodedLineString(
                                  vertexBuffer,
                                  vertexOffsets,
                                  start,
                                  numVertices,
                                  false,
                                  mortonSettings,
                              );
                }
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
                if (!vertexOffsets || vertexOffsets.length === 0) {
                    rings[ringIndex] = getLinearRing(vertexBuffer, start * 2, numVertices);
                } else {
                    rings[ringIndex] =
                        geometryVector.vertexBufferType === VertexBufferType.VEC_2
                            ? decodeDictionaryEncodedLinearRing(vertexBuffer, vertexOffsets, start, numVertices)
                            : decodeMortonDictionaryEncodedLineString(
                                  vertexBuffer,
                                  vertexOffsets,
                                  start,
                                  numVertices,
                                  true,
                                  mortonSettings,
                              );
                }
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
                    if (!vertexOffsets || vertexOffsets.length === 0) {
                        allRings.push(getLinearRing(vertexBuffer, start * 2, numVertices));
                    } else {
                        allRings.push(
                            geometryVector.vertexBufferType === VertexBufferType.VEC_2
                                ? decodeDictionaryEncodedLinearRing(vertexBuffer, vertexOffsets, start, numVertices)
                                : decodeMortonDictionaryEncodedLineString(
                                      vertexBuffer,
                                      vertexOffsets,
                                      start,
                                      numVertices,
                                      true,
                                      mortonSettings,
                                  ),
                        );
                    }
                }
            }
            return allRings;
        }
        default:
            return convertGeometryVector(geometryVector)[index];
    }
}

function getLinearRing(vertexBuffer: Int32Array, startIndex: number, numVertices: number): Point[] {
    return getLineString(vertexBuffer, startIndex, numVertices, true);
}

function decodeDictionaryEncodedLinearRing(
    vertexBuffer: Int32Array,
    vertexOffsets: Int32Array,
    vertexOffset: number,
    numVertices: number,
): Point[] {
    return decodeDictionaryEncodedLineString(vertexBuffer, vertexOffsets, vertexOffset, numVertices, true);
}

function decodeMortonDictionaryEncodedLinearRing(
    vertexBuffer: Int32Array,
    vertexOffsets: Int32Array,
    vertexOffset: number,
    numVertices: number,
    geometryFactory: MvtGeometryFactory,
    mortonSettings: MortonSettings,
): Point[] {
    return decodeMortonDictionaryEncodedLineString(
        vertexBuffer,
        vertexOffsets,
        vertexOffset,
        numVertices,
        true,
        mortonSettings,
    );
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
