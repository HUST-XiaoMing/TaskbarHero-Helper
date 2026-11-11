"""Read the game's Unity TextAssets and localization bundles with the standard library."""

import csv
import hashlib
import io
from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]


def read_table(blob, name, key, hashes, *, grouped=False):
    """TextAsset contains a length-prefixed UTF-8 name and a length-prefixed script."""
    name_bytes = name.encode("ascii")
    marker = struct.pack("<I", len(name_bytes)) + name_bytes
    search = 0
    candidates = []
    while (pos := blob.find(marker, search)) >= 0:
        search = pos + len(marker)
        header = (search + 3) & ~3
        if header + 4 > len(blob):
            continue
        size, = struct.unpack_from("<I", blob, header)
        start = header + 4
        if size < len(key) or size > len(blob) - start:
            continue
        payload = blob[start:start + size]
        if payload.removeprefix(b"\xef\xbb\xbf").startswith(key.encode("ascii") + b","):
            candidates.append(payload)
    if len(candidates) != 1:
        raise ValueError(f"Expected one valid {name} TextAsset; found {len(candidates)}.")
    payload, = candidates
    hashes[name] = hashlib.sha256(payload).hexdigest()
    result = {}
    for row in csv.DictReader(io.StringIO(payload.decode("utf-8-sig"))):
        row_key = row[key]
        if not row_key or (not grouped and row_key in result):
            raise ValueError(f"{name}: empty or duplicate key {row_key!r}")
        if grouped:
            result.setdefault(row_key, []).append(row)
        else:
            result[row_key] = row
    return result


def decompress_lz4(source, expected):
    """Decode an LZ4 block used by UnityFS. No dictionaries or external runtime."""
    result = bytearray()
    offset = 0

    def length(n):
        nonlocal offset
        if n == 15:
            while True:
                byte = source[offset]
                offset += 1
                n += byte
                if byte != 255:
                    break
        return n

    while offset < len(source):
        token = source[offset]
        offset += 1
        literals = length(token >> 4)
        end = offset + literals
        if end > len(source) or len(result) + literals > expected:
            raise ValueError("Invalid UnityFS LZ4 literal extent")
        result.extend(source[offset:end])
        offset = end
        if offset == len(source):
            break
        distance, = struct.unpack_from("<H", source, offset)
        offset += 2
        count = 4 + length(token & 15)
        if not distance or distance > len(result) or len(result) + count > expected:
            raise ValueError("Invalid UnityFS LZ4 match")
        match = result[-distance:]
        result.extend((match * ((count + distance - 1) // distance))[:count])
    if len(result) != expected:
        raise ValueError("Unexpected UnityFS block size")
    return bytes(result)


def unpack_blocks(bundle):
    """Inflate the payload of a UnityFS v8 localization bundle."""
    data = bundle.read_bytes()
    if not data.startswith(b"UnityFS\0") or struct.unpack_from(">I", data, 8)[0] != 8:
        raise ValueError("Unsupported localization bundle")
    pos = data.index(0, data.index(0, 12) + 1) + 1
    total, comp, raw, flags = struct.unpack_from(">QIII", data, pos)
    if total != len(data) or flags & 0x80:
        raise ValueError("Unsupported UnityFS metadata layout")
    pos = (pos + 20 + 15) & ~15

    def inflate(src, size, mode):
        if (mode & 63) in (2, 3):
            return decompress_lz4(src, size)
        if not mode & 63 and len(src) == size:
            return src
        raise ValueError("Unsupported UnityFS block compression")

    metadata = inflate(data[pos:pos+comp], raw, flags)
    pos += comp
    if flags & 0x200:
        pos = (pos + 15) & ~15
    count, = struct.unpack_from(">I", metadata, 16)
    blocks = []
    for i in range(count):
        size, compressed, kind = struct.unpack_from(">IIH", metadata, 20 + i * 10)
        blocks.append(inflate(data[pos:pos+compressed], size, kind))
        pos += compressed
    return b"".join(blocks)


def localization_files(data_dir):
    bundles = data_dir / "StreamingAssets" / "aa" / "StandaloneWindows64"
    shared = bundles / "localization-assets-shared_assets_all.bundle"
    zh = bundles / "localization-string-tables-chinese(simplified)(zh-hans)_assets_all.bundle"
    if not zh.is_file():
        zh = next(iter(sorted(bundles.glob("*-string-tables-*(zh-hans)_assets_all*.bundle"))), zh)
    return shared, zh


def source_stamps(game_dir, files):
    stamps = {}
    for path in files:
        key = path.relative_to(game_dir).as_posix()
        try:
            stat = path.stat()
        except FileNotFoundError:
            stamps[key] = None
        else:
            stamps[key] = {"size": stat.st_size, "mtimeNs": str(stat.st_mtime_ns)}
    return stamps


def string_lookup(shared_file, zh_file):
    try:
        shared = unpack_blocks(shared_file)
        zh = unpack_blocks(zh_file)
    except (FileNotFoundError, ValueError, IndexError, struct.error):
        # An installation without supported Chinese bundles can still supply numerical data.
        return lambda key: None
    cache = {}

    def lookup(key):
        if not key:
            return None
        if key not in cache:
            key_bytes = key.encode("utf-8")
            pos = shared.find(struct.pack("<I", len(key_bytes)) + key_bytes)
            result = None
            if pos >= 8 and pos % 4 == 0:
                entry_id = shared[pos-8:pos]
                # A StringTable entry stores the same 64-bit ID, then a Unity string.
                pos = zh.find(entry_id)
                while pos >= 0:
                    if pos % 4 == 0 and pos + 12 <= len(zh):
                        size, = struct.unpack_from("<I", zh, pos+8)
                        if 0 < size <= len(zh) - pos - 12:
                            try:
                                result = zh[pos+12:pos+12+size].decode("utf-8")
                            except UnicodeDecodeError:
                                pass
                            if result and "\0" not in result:
                                break
                            result = None
                    pos = zh.find(entry_id, pos+1)
            cache[key] = result
        return cache[key]

    return lookup
