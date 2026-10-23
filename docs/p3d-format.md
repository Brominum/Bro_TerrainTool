# P3D format (MLOD and ODOL)
All numbers are little-endian. **Verified** = checked with sample files. **Assumed** = not checked.
## MLOD (verified with Bro_MSWR_Doorway.p3d, 4 LODs)
| Part | Content |
| --- | --- |
| Header | `MLOD`, uint32 version (257), uint32 LOD count |
| LOD header | `P3DM`, uint32 0x1C, uint32 0x100, uint32 points, normals, faces, flags |
| Points | 3 float + uint32 flags each |
| Normals | 3 float each |
| Faces | uint32 corner count (3 or 4), 4 x (uint32 point, uint32 normal, float u, float v), uint32 flags, texture (asciiz), material (asciiz) |
| Tags | `TAGG`, then (byte active, asciiz name, uint32 size, data) until `#EndOfFile#`. Names without `#` are named selections. `#UVSet#`: uint32 set index, then float u and v for each face corner in face order (verified with IndustrialShed_01_F, sets 0 and 1). |
| End | float resolution |
Corner order: clockwise seen from the front (Direct3D). The stored normals agree with this order (verified, 100% of the faces).
## ODOL (version 73 verified with 6 vanilla models, 69 LODs; version 75 verified with the doorway, 4 LODs)
| Part | Content | Status |
| --- | --- | --- |
| Header | `ODOL`, uint32 version, uint32 app ID, 8 bytes (version 75 only, meaning unknown), asciiz muzzle flash, uint32 LOD count, float resolution for each LOD | verified (73, 75) |
| Model info, animations | Not read | - |
| LOD table | uint32 start offset for each LOD, then uint32 end offset for each LOD. The LODs are stored in reverse order (LOD 0 is last). | verified |
The tool finds the LOD table as the only place after the header where the 2 x n values give n ranges that start after the table, end inside the file, and do not overlap. The LOD data always comes after the table. Without the "after the table" rule, Barracks_01_camo_F gives a second place (4 bytes after the real table).
### LOD (version 73)
| Part | Content | Status |
| --- | --- | --- |
| Proxies | uint32 count, each: asciiz model, 12 float matrix, 4 int32 | verified (count) |
| Skeleton tables | uint32 count + int32 values; uint32 count, each uint32 count + int32 values | verified |
| Vertex count | uint32 | verified |
| Bounds | float face area, int32 or hints, int32 and hints, 3 float min, 3 float max, 3 float center, float radius | verified (min and max agree with the positions) |
| Textures | uint32 count, asciiz each | verified |
| Materials | uint32 count, each: asciiz name, uint32 version (11), 24 float colors, float specular power, 4 uint32 shader values, asciiz surface (version 6+), 2 uint32 render flags, uint32 stages, uint32 uv transforms (version 7+), stages (uint32 filter, asciiz texture, uint32 stage ID, byte env map), uv transforms (uint32 source, 12 float), one more stage (version 10+) | verified |
| Point and vertex tables | 2 compressed uint32 arrays | verified |
| Faces | uint32 count, uint32 allocation size, uint16 (0), each face: byte corners, uint32 vertex index for each corner | verified |
| Sections | uint32 count, each 46 bytes when material index is not -1: int32 start, int32 end (in allocation units: 4 + 4 x corners for each face), 3 int32, int16 texture index, uint32 special, int32 material index (-1: asciiz surface follows), uint32 stage count, float for each stage, uint32 | verified |
| Named selections | uint32 count, each: asciiz name, compressed uint32 faces, int32, byte sectional, compressed int32 sections, compressed uint32 vertices, compressed byte weights | verified |
| Properties | uint32 count, 2 asciiz each | verified |
| Frames | uint32 count, each: float time, uint32 count, 3 float each | verified (count 0 only) |
| Colors and flags | uint32 color top, uint32 color, uint32 special, byte simple bone flag | verified |
| Rest size | uint32. The rest ends 1 byte before the LOD end. | verified |
| Clip flags | condensed uint32 array | verified |
| UV set 0 | 4 float (min u, min v, max u, max v), condensed array of 2 int16. Value = min + (raw + 32767) / 65534 x (max - min). | verified range; v direction assumed |
| More UV sets | uint32 UV set count, then (count - 1) more UV sets. The reader uses set 1 for the mask of multimaterials. | verified (count) |
| Positions | compressed array of 3 float | verified |
| Normals | condensed array of uint32: 3 signed 10-bit values, scale -1/511 | verified |
| Rest | Not read (tangents, bone references) | - |
Arrays:
- **Compressed array:** uint32 count, then if count x size is not 0: byte flag (0 = raw data, else LZO1X), then the data. LZO data has no stored length: it ends when the output is complete.
- **Condensed array:** uint32 count, byte fill flag. Fill flag 1: one element for all. Fill flag 0: the data as in a compressed array.

Positions: the binarizer moves the model so that the center of its bounding box is at the origin. The doorway has the same size in MLOD and ODOL (3.0 x 2.8 x 0.27 m), and the same textures and triangle count.
Corner order and normals: ODOL stores both in the opposite direction to MLOD. The reader reverses the corners, so that both formats give the same mesh. Verified visually with FuelStation_02_workshop_F.
## Open items
- ODOL version 74: not checked. The reader tries 0, 8 and 4 extra header bytes.
- The v direction of the ODOL UVs is not checked with a texture.
- Faces without a texture use their material (RVMAT). The viewer reads the material: a multimaterial (pixel shader `Multi`) blends stages 0 to 3 with the mask in stage 4 and the macro color in stage 9. Mask: black selects layer 0, red layer 1, green layer 2, blue layer 3 (found with IndustrialShed_01_F in the viewer).
- Binarized RVMAT (`\0raP`): the reader follows the community description. It is not checked with a sample file.
