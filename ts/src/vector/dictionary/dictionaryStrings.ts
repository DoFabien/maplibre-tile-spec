import { decodeString } from "../../decoding/decodingUtils";

/** The strings of the dictionaries already read, by their bytes, which the columns of a shared dictionary have in common. */
const dictionaries = new WeakMap<Uint8Array, string[]>();

/**
 * The entries of a dictionary, entry `i` being `offsets[i]` to `offsets[i + 1]` of `bytes`, read once for all the
 * columns that share them.
 */
export function dictionaryStrings(bytes: Uint8Array, offsets: Uint32Array): string[] {
    let strings = dictionaries.get(bytes);
    if (strings) return strings;
    strings = new Array<string>(offsets.length - 1);
    for (let entry = 0; entry < strings.length; entry++) {
        strings[entry] = decodeString(bytes, offsets[entry], offsets[entry + 1]);
    }
    dictionaries.set(bytes, strings);
    return strings;
}
