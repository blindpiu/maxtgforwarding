const { encode, decode, ExtensionCodec } = require("@msgpack/msgpack");
const lz4 = require("lz4js");

const PROTOCOL_VERSION = 10;
const HEADER_LENGTH = 10;
const MAX_BODY_LENGTH = 0xffffff;
const MAX_DECODED_LENGTH = 64 * 1024 * 1024;
const extensionCodec = new ExtensionCodec();
const msgpackOptions = { extensionCodec, useBigInt64: true };

// MAX's extension type 1 contains another MessagePack value.
extensionCodec.register({
    type: 1,
    decode: (data) => {
        const value = decode(data, msgpackOptions);
        if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
        return value;
    }
});

function normalizeIntegers(value) {
    if (typeof value === "bigint") {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : value.toString();
    }
    if (Array.isArray(value)) return value.map(normalizeIntegers);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        for (const key of Object.keys(value)) value[key] = normalizeIntegers(value[key]);
    }
    return value;
}

// Check raw LZ4 bounds before calling lz4js, whose block decoder assumes valid input.
// The header's compression byte is a size hint, not an exact decoded length.
function decodedBlockLength(body) {
    let offset = 0;
    let length = 0;
    const extendedLength = (initial) => {
        let result = initial;
        if (initial === 15) {
            let part;
            do {
                if (offset >= body.length) throw new Error("Truncated LZ4 length");
                part = body[offset++];
                result += part;
            } while (part === 255);
        }
        return result;
    };
    while (offset < body.length) {
        const token = body[offset++];
        const literals = extendedLength(token >>> 4);
        if (offset + literals > body.length) throw new Error("Truncated LZ4 literals");
        offset += literals;
        length += literals;
        if (length > MAX_DECODED_LENGTH) throw new Error("LZ4 body too large");
        if (offset === body.length) return length;
        if (offset + 2 > body.length) throw new Error("Truncated LZ4 offset");
        const distance = body.readUInt16LE(offset);
        offset += 2;
        if (!distance || distance > length) throw new Error("Invalid LZ4 offset");
        length += extendedLength(token & 15) + 4;
        if (length > MAX_DECODED_LENGTH) throw new Error("LZ4 body too large");
    }
    throw new Error("Truncated LZ4 block");
}

function encodePacket({ cmd = 0, seq, opcode, payload }) {
    let body = payload == null ? Buffer.alloc(0) : Buffer.from(encode(payload, msgpackOptions));
    if (body.length > MAX_DECODED_LENGTH) throw new Error("MAX payload too large");
    let compression = 0;
    if (body.length > 32) {
        const compressed = Buffer.alloc(lz4.compressBound(body.length));
        const length = lz4.compressBlock(body, compressed, 0, body.length, new Uint32Array(65536));
        if (length > 0 && length < body.length) {
            compression = Math.min(255, Math.ceil(body.length / length));
            body = compressed.subarray(0, length);
        }
    }
    if (body.length > MAX_BODY_LENGTH) throw new Error("MAX packet too large");
    const header = Buffer.alloc(HEADER_LENGTH);
    header[0] = PROTOCOL_VERSION;
    header[1] = cmd;
    header.writeUInt16BE(seq & 0xffff, 2);
    header.writeUInt16BE(opcode, 4);
    header[6] = compression;
    header.writeUIntBE(body.length, 7, 3);
    return Buffer.concat([header, body]);
}

function decodePackets(data) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!raw.length) throw new Error("Empty MAX frame");
    const packets = [];
    let offset = 0;
    while (offset < raw.length) {
        if (raw.length - offset < HEADER_LENGTH) throw new Error("Short MAX header");
        const header = raw.subarray(offset, offset + HEADER_LENGTH);
        if (header[0] !== PROTOCOL_VERSION) throw new Error(`Unsupported MAX protocol: ${header[0]}`);
        const length = header.readUIntBE(7, 3);
        offset += HEADER_LENGTH;
        if (offset + length > raw.length) throw new Error("Truncated MAX body");
        let body = raw.subarray(offset, offset + length);
        offset += length;
        if (header[6] && length) {
            const decoded = Buffer.alloc(decodedBlockLength(body));
            lz4.decompressBlock(body, decoded, 0, body.length, 0);
            body = decoded;
        }
        packets.push({
            ver: header[0], cmd: header[1], seq: header.readUInt16BE(2),
            opcode: header.readUInt16BE(4),
            payload: body.length ? normalizeIntegers(decode(body, msgpackOptions)) : null
        });
    }
    return packets;
}

// Accept decimal IDs without rounding them through Number first.
function integerId(value, name) {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "bigint" || (typeof value === "string" && /^-?\d+$/.test(value))) {
        const integer = BigInt(value);
        if (integer >= -(1n << 63n) && integer < (1n << 64n)) return integer;
    }
    throw new Error(`${name} must be an exact 64-bit integer`);
}

module.exports = { encodePacket, decodePackets, integerId };
