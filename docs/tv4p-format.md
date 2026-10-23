# Terrain Builder project format (ALB1)
Verified with the bro_msi project (`bro_msi.tv4p`, `default.tv4l`, `residential.tv4s`). All numbers are little-endian.
## Container
| Part | Content |
| --- | --- |
| Header | `ALB1`, uint32 1, uint32 21 (version), uint32 0 |
| Field names | uint16, byte, uint32 count, then for each name: uint16 ID, uint16 length, characters |
| Class names | same layout as the field names |
| Root object | uint16 class ID, uint32 object ID, then fields to the end of the file |
Field: uint16 name ID, byte type, value.
| Type | Value |
| --- | --- |
| 0x01 | 1 character |
| 0x05 | int32 |
| 0x06, 0x07 | uint32 |
| 0x09 | bool (1 byte) |
| 0x0A | float32 |
| 0x0B | string: uint16 length, characters |
| 0x0C | list: uint32 size (bytes after the size), uint32 count, fields. Some lists hold other data (the object tree of a layer). |
| 0x0D | object: uint32 size (bytes after the size), uint16 class ID, uint32 object ID, fields |
| 0x0E | reference: uint16 class ID, uint32 object ID |
| 0x0F | pair: two fields (`key`, `data`) without a size |
| 0x13 | null (no value) |
| 0x14 | float64 |
| 0x15 | float64 array: byte count, values |
## Project (.tv4p)
| Path | Content |
| --- | --- |
| `mname` | Project name |
| `objManager.mapFrame.mframe.item` | Map frame (class SMapFrame): `mpos` = x min, y min, x max, y max with the TB offset, `size`, `cacheterrain` |
| `...item.config` | Map frame settings (class SMapFrameConfiguration): `wrpdirexport`, `wrpfilecfg` (layers.cfg), `gridX` (texture layer size), `texcell` (tile px), `texoverlap`, `imageryResolution` (m/px), `satGridCellSize`, `texgridfile` |
| `world.mcontents.mcontents` | Imported files (class CWorldContent): `filename`, `type` (0 heightmap, 1 satellite, 2 mask), `mid`, `viewdouble` |
The files `<name>_<mid>.v4d` and `<name>.Cache\block_<mid>.cache` are TB copies of the imported files. They are not read.
## Open items
- Layer (`.tv4l`): the field `tree` holds the objects in a format that is not decoded. The bro_msi layer has `objectCount` 0 and no model names. A project with objects is necessary to decode it.
- Shapes (`.tv4s`): the container decodes. The shape fields are not used yet (milestone M8).
