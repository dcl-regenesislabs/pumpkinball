#!/usr/bin/env python3
"""
Gives a GLB's materials a glow of their own colour (glTF "emissiveFactor"), without opening Blender:

    python3 scripts/set-emission.py assets/models/pumpkin.glb 0.1

- Materials with a plain base colour glow in that colour, at the given strength (0.1 = 10% of the colour).
- Materials with a base colour TEXTURE (and no emissive texture) glow in that texture's colours: the base texture is also used
  as the emissive texture, so the glow follows the painted colours instead of lifting everything to grey.
- Materials that already have an emissive texture keep it; their factor is set to the strength.
Re-exporting from Blender resets this, so run it again afterwards (or set Emission in Blender instead).
Higher strength = brighter glow: 0.1 is subtle, 0.3 is clearly self-lit, 1.0 is fully glowing.
"""
import json
import struct
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path, strength = Path(sys.argv[1]), float(sys.argv[2])

    data = path.read_bytes()
    magic, version, _ = struct.unpack('<4sII', data[:12])
    if magic != b'glTF':
        sys.exit('Not a GLB file')
    json_len, json_type = struct.unpack('<II', data[12:20])
    doc = json.loads(data[20:20 + json_len])
    rest = data[20 + json_len:]  # the BIN chunk(s), untouched

    for m in doc['materials']:
        pbr = m.get('pbrMetallicRoughness', {})
        base_tex = pbr.get('baseColorTexture')
        if m.get('emissiveTexture'):
            m['emissiveFactor'] = [strength] * 3
        elif base_tex:
            m['emissiveTexture'] = {'index': base_tex['index']}
            m['emissiveFactor'] = [strength] * 3
        else:
            base = pbr.get('baseColorFactor', [1, 1, 1, 1])
            m['emissiveFactor'] = [round(c * strength, 4) for c in base[:3]]
        print(f"  {m.get('name')}: emissiveFactor {m['emissiveFactor']}")

    payload = json.dumps(doc, separators=(',', ':')).encode()
    payload += b' ' * (-len(payload) % 4)  # JSON chunk must be 4-byte aligned (padded with spaces)
    out = struct.pack('<4sII', b'glTF', version, 20 + len(payload) + len(rest))
    out += struct.pack('<II', len(payload), json_type) + payload + rest
    path.write_bytes(out)
    print(f'{path.name} updated ({len(out)} bytes)')


if __name__ == '__main__':
    main()
