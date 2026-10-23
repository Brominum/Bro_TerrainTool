# WRP format (editable, `8WVR`)
All numbers are little-endian. Status: **verified** = checked with `bro_range.wrp` (the decode uses all 6242413 bytes, and the writer gives the same bytes).
| Offset | Size | Type | Content | Status |
| --- | --- | --- | --- | --- |
| 0 | 4 | char[4] | `8WVR` | verified |
| 4 | 4 | uint32 | Texture layer grid X (16 in bro_range) | verified |
| 8 | 4 | uint32 | Texture layer grid Y (16) | verified |
| 12 | 4 | uint32 | Terrain grid X (1024) | verified |
| 16 | 4 | uint32 | Terrain grid Y (1024) | verified |
| 20 | 4 | float32 | Texture layer size in meters (64.0) | verified |
| 24 | 4 x X x Y | float32 | Heights. Row 0 is the south row. Equal to the ASC flipped (largest difference 7.5e-9). | verified |
| after | 2 x layer X x layer Y | uint16 | Material index of each texture layer cell (256 values in bro_range, range 1 to 25) | verified: row 0 is the south row, x changes fastest. The tile in each name agrees with the cell position for all 256 cells. |
| after | 4 | uint32 | Material count (26 in bro_range) | verified |
| after | each material | see below | Material names | verified |
| after | each object, to the end of the file | see below | Object list (22462 records in bro_range) | verified |
Material record:
| Size | Type | Content | Status |
| --- | --- | --- | --- |
| 4 | uint32 | Length of the name | verified |
| n | chars | RVMAT path, for example `bromine\bro_range\data\layers\P_000-000_L01_L02_L03_L04_N.rvmat`. No zero at the end. | verified |
| 4 | uint32 | Only if the name is not empty. Always 0 in bro_range. Meaning unknown. | verified |
Material 0 has an empty name. Materials 1 to 25 are the tile RVMAT files.
Object record:
| Size | Type | Content | Status |
| --- | --- | --- | --- |
| 48 | float32[12] | Transform matrix 4 x 3: aside, up, dir, position. The position is (x, z, y): x and y in world meters without the TB offset of 200000, z is the elevation above sea level. | verified for position; rotation order assumed |
| 4 | uint32 | Object ID. It counts from 0. | verified |
| 4 | uint32 | Length of the model path | verified |
| n | chars | Model path (P3D), for example `a3\plants_f\tree\t_ficusb2s_f.p3d` | verified |
The last record is an end marker: all 12 matrix values are NaN, the ID is 21228356, and the model path is empty. The writer keeps it as it is.
## Open items
- Rule that TB uses to give the material numbers.
- Rotation order of the transform matrix. The samples have only yaw.
- Meaning of the uint32 after each material name, and of the ID in the end marker.
