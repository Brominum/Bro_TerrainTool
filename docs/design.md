# Arma 3 Terrain Companion: Design Doc

Version 0.14 (23 Oct 2026). Personal tool. Offline. Windows only. Written in ASD-STE100.

## 1. Goal

Build a standalone tool that replaces Terrain Builder (TB) as much as possible. The tool uses vanilla Arma 3 formats. It does eight jobs.

1. Show the terrain and the objects in 3D in real time.
2. Place and edit objects with gizmos, splines, and scatter brushes.
3. Fill areas of the map with objects. The areas come from selected mask colors.
4. Edit the heightmap.
5. Paint the layer mask and the satellite image.
6. Export Arma 3-ready files: WRP, ASC, PNG, BMP, SHP, and object text.
7. Make the source folder of the map mod (config.cpp and the folder structure), ready for the PBO tools (from M12).
8. Generate roads between points, and later villages, with vanilla assets (from M13).

**Non-goals**

- Pack PBO files. The Arma 3 Tools do this.
- Binarize the WRP file. The Arma 3 Tools do this (confirmed by the user).
- Sync with a running Arma 3 game (possible later).
- Public release.

## 2. Stack

- Default stack: a Rust core and a TypeScript UI. The tool does not have to be web based. It is a Windows 11 desktop tool. Claude Opus may propose a different stack in writing before it starts.
- Build: Vite.
- 3D: Three.js (WebGL 2).
- UI: React with a small state store (Zustand).
- Shell: Tauri. The shell reads the Arma 3 folders and writes the export files.
- Rust core (multi-thread): PBO reading, ODOL and MLOD parsing, PAA decoding, config.bin reading, image tile storage, PNG and BMP encoding, shapefile writing.
- Web Workers: terrain meshing and the spatial index.
- Image data lives in tiles on disk. The GPU holds only the visible tiles.
- Tests: Vitest and Rust unit tests with golden files.

## 3. Inputs

| Input | Format | Use |
| --- | --- | --- |
| Heightmap | ASC only | Terrain mesh and edit base |
| Satellite image | PNG | Painting base. Same size as the mask. No color rules. |
| Mask image | PNG (TB palette mask, RGB) | Layer mask edit base |
| layers.cfg | Text config | Layer names, colors, RVMAT paths |
| Layer RVMATs and textures | RVMAT, PAA | Texture paths and values for the tile RVMAT files |
| Game data | PBO files and config.bin | Class list, models, textures |
| Models | P3D (MLOD and ODOL version 75) | Object models |
| Template library | TML | Optional. Gives collections and defaults. Three samples are decoded. |
| Earlier objects | TB object text | Re-import |
| Shapes | SHP | Import of roads, forests, areas |
| Sample WRP files | WRP | Format study and tests |
| Project file | JSON and a tile folder | Save and load all state |

Mapframe settings example. The values come from the sample map (bro\_range). The user sets all of them at project setup:

```json
{
	"terrain": { "gridSize": 1024, "cellSize": 1, "sizeMeters": 1024 },
	"originOffset": [0, 0],
	"imagery": { "width": 2048, "height": 2048, "metersPerPixel": 0.5 },
	"tiles": { "size": 2048, "overlapPx": 512, "exportSatellite": true, "exportMask": true },
	"textureLayerSizeMeters": 64,
	"gamePaths": ["C:/Program Files (x86)/Steam/steamapps/common/Arma 3"]
}
```

The user gives the satellite and mask as whole images. Both images must have the same size. The tool splits them into tiles from these settings. The user can change every value. The tool recalculates the tiles after each change. The pixel size must equal the terrain size divided by the image size.

**Mapframe panel (from the TB screenshot of bro\_msi)**

- Samplers: grid 2048 x 2048, cell size 1 m, terrain size 2048 m. Source images 2048 x 2048 px at 1 m/px. Tiles 2048 x 2048 px with a desired overlap of 512 px. Texture layer 64 m.
- TB shows values that it calculates. The tool must show them too: actual overlap (512 px), overlapped area (43.75%), tiles in row (2), landgrid (32), wanted and final sat grid (1536 cells), and satellite segment (24 px).
- Overlapped area = 1 - (step / tile size)^2 = 1 - (1536 / 2048)^2 = 43.75%. Verified.
- Tiles in row = ceil(2048 / 1536) = 2. This matches the tile formula on a second map. Verified.
- Final sat grid (1536) = tile px - overlap px. Verified.
- Landgrid 32 is probably the number of 64 m layer cells in a row (2048 / 64). Not confirmed.
- TB shows a warning when the terrain size does not divide evenly. Text: "Edge tiles may be partially covered." The tool must show the same warning.
- The meaning of the satellite segment (24 px) is unknown. The user has not said if it matters for the output.

**Target map (the real project)**

- Terrain 16384 m with 4 m cells (4096 x 4096 grid). Satellite and mask images 16384 x 16384 px at 1 m/px.
- Tiles of 2048 px with an overlap of 512 px. Tiles for each axis = ceil(16384 / 1536) = 11. So each image has 11 x 11 = 121 tiles.
- Texture layers of 64 m give 256 x 256 = 65536 layer cells.
- The ASC has about 16.7 million values. Each image has about 268 million pixels.

## 4. Coordinates

- Arma 3: X is east. Y is north. Z is up. The origin is at the bottom-left of the world.
- Three.js: Y is up.
- Mapping: Arma X is Three X. Arma Z is Three Y. Arma Y is Three negative Z.
- Store all data in Arma units. Convert only in the render layer.
- TB X values have an offset. The sample ASC has xllcorner 200000, and the sample object text has x values near 207000. The offset is a project setting. Its default is the xllcorner of the ASC.
- Yaw, pitch, and roll use degrees. Check the exact rotation order against a TB sample before you write the math.

## 5. Object pipeline

1. Build an index of all PBO files in the game paths and mod paths. **Decision (23 Oct 2026):** not needed. The vanilla data is extracted to `P:\a3` with the Arma 3 Tools, and the tool scans it as loose files.
2. Scan the project roots for loose P3D files (for example the P: drive). Build one universal object database. The key is the file name without the extension, in lower case. Store the relative path, the source (loose file or PBO), and the model bounds.
3. The user can place any P3D from the database. A template library is not needed. If two folders have the same file name, show a warning and let the user pick. The TB object text has only the name.
4. Read the class list from config.bin (CfgVehicles) for display names and categories. This is optional.
5. Import TML files as collections with default values. See "TML libraries" below.
6. Parse the highest-detail visual LOD of each P3D. Read only the header and bounds when the user browses. Parse the full model when it is shown.
7. Load the diffuse PAA texture. Ignore RVMAT files in version 1.
8. Cache the parsed models on disk in a fast binary format.
9. If a model fails to parse, show a red bounding box with a label. The tool must not crash.

Arma 3 P3D files are usually binarized (ODOL). Some mod files are editable (MLOD). The parser must handle both. ODOL is the largest technical risk.

Use Three.js compressed textures (DXT1 and DXT5). The PAA decoder must also handle LZO-compressed mip levels. Verified with the samples: bro\_dirt\_co.paa is DXT1 (type 0x01FF), 2048 x 2048. bro\_dirt\_nopx.paa is DXT5 (0x05FF), 2048 x 2048, with LZO-compressed mips. Both have the tags AVGC, MAXC, and OFFS. The nopx file also has FLAG and SWIZ.

**P3D samples (Bro\_MSWR\_Doorway)**

- There are two files of one model: unbinarized (MLOD), 48977 bytes, and binarized (ODOL), 21447 bytes. Their names differ only in case. On Windows they cannot be in the same folder. Keep them in separate fixture folders.
- MLOD header: `MLOD`, version 257, 4 LODs. I parsed all four LODs with a short script (points, normals, faces, texture names, named selections). The file ends exactly after LOD 3.
- LOD 0 is the visual LOD (resolution 1.0): 314 points, 176 normals, 181 faces. Textures: `modshnew_brick_co.paa` and `wood_co.paa`, each with an RVMAT. Selections: `camo` and `door_1`.
- LOD 1 (resolution about 1e13) is probably the geometry LOD. It has `component01` to `component04`. LOD 2 (about 1e15) is probably the memory LOD. It has `snap_1`, `snap_2`, `door_1_axis`, and `door_1_trigger`. LOD 3 (about 3e15) is probably the roadway LOD. It has 6 points and 2 faces.
- ODOL header: `ODOL`, then version 75. The file has a string table: skeleton name `Bro_MSWR_Doorway_Skeleton`, selection names, texture and RVMAT paths, and procedural textures such as `#(argb,8,8,3)color(0.5,0.5,0.5,0.5,dt)`.
- Test idea: use the MLOD as the truth for the ODOL parser. Compare the bounding box, the texture list, and the selection names. The point counts can differ, because the binarizer splits vertices.
- Write the MLOD parser first. It is simple. Then write the ODOL version 75 parser.

**TML libraries (3 samples)**

- A TML file is XML. The root `Library` has the attributes `name`, `shape` (`elipse` or `rectangle`), `default_fill`, `default_outline`, and `tex`. Each `Template` has these fields: `Name`, `File`, `Date`, `Archive`, `Fill`, `Outline`, `Scale`, `Hash`, `ScaleRandMin` and `ScaleRandMax`, the same for `Yaw`, `Pitch`, and `Roll`, `TexLLU`, `TexLLV`, `TexURU`, `TexURV`, `BBRadius`, `BBHScale`, `AutoCenter`, `XShift`, `YShift`, `ZShift`, `Height`, `BoundingMin`, `BoundingMax`, `BoundingCenter` (with X, Y, and Z attributes), and `Placement`.
- The samples are `bushesdense` (3 templates), `exp_props_industrial` (7), and `Bro_Structures` (58). In all 68 templates, `Name` is the P3D file name without the extension (case ignored). There are no duplicate names. So the database key in the list above works.
- `File` is a path relative to the P: drive or the game data, for example `a3\plants_f\bush\b_ficusc1s_f.p3d` and `Bro_Structures\1Story_A\Bro_1story_A.p3d`.
- `Fill` and `Outline` are signed 32-bit integers (map colors, -1 is white).
- A template that TB has not used yet has `BBRadius` -1, `BBHScale` 1, and bounds of 999 and -999. TB calculates them at first use. The tool calculates the bounds from the model, so it can ignore these fields.
- The random ranges are 0 in all samples. The tool uses them as defaults for scatter recipes.
- `XShift`, `YShift`, and `ZShift` are not 0 in 4 templates of Bro\_Structures. `AutoCenter` is 1 in 13 of them. The effect of these fields on a placed object is not verified.
- `Archive` and `Placement` are empty in all samples.
- The tool reads TML. It can also write a TML, so that TB can use the same objects. This is optional.

## 6. Object placement

Data model:

```ts
interface PlacedObject {
	id: number;
	className: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	roll: number;
	scale: number;
	group: string;
}
```

**Features for version 1**

- Translate, rotate, and scale gizmos (Three.js TransformControls).
- Click select, box select, and multi-select.
- Snap to ground, grid snap, and align to surface normal.
- Copy, paste, and duplicate.
- Undo and redo with a command stack.
- Scatter brush: radius, density, random yaw, random scale, class weights, minimum spacing.
- Groups with visibility and lock.
- Search by class name and category.

**Splines**

- Use Catmull-Rom curves. The user edits the control points with the gizmo.
- Presets: Fence, Runway lights, Runway line.
- Parameters: model, spacing (fixed or model length), yaw offset, side offset, jitter, closed loop, conform to terrain.
- A spline stays editable. The tool regenerates its objects after each change.
- Save the spline in the project file. Export only the generated objects.

**Scale**

- Use one InstancedMesh for each model.
- Use a spatial grid and frustum culling.
- Use bounding boxes at long distance.
- Target: 500000 objects at 30 FPS. This is an assumption. Measure it.

## 7. Object export and import

One object for each line. The expected format is:

```
"t_juglansRegia_2s";207092.144;14561.414;182;0;0;0.94;0
```

- Verified with `Trees2_3_2.txt` (1342 lines). TB imports this file. It is from a different map.
- Fields, in this order: class name in double quotes, x, y, yaw, pitch, roll, scale, z. The separator is `;`.
- The line end is CRLF, also after the last line. There is no header and there are no spaces.
- X includes the map offset (the ASC xllcorner, 200000). Y has no offset. In the sample, x is 206824 to 209086 and y is 13665 to 15928.
- X and y have up to 3 decimals. The number of decimals is not fixed. Yaw is a whole number from 0 to 359. Scale has 2 decimals.
- Pitch, roll, and z are 0 in all 1342 lines. So the rotation order and the angle directions are not verified. The meaning of z depends on the import mode (see below).
- Class names keep their case, for example `T_Betula_pendula_3f` and `t_acer2s`. The sample has 5 classes.
- Round-trip test: import, export, and compare byte by byte, including CRLF.

**Relative and absolute z**

- On import, the user picks one of two modes with a radio button: Relative or Absolute. The default is Relative, like in TB.
- Relative: z is the height above the terrain at the x and y of the object. `Trees2_3_2.txt` has z = 0 and was made for a relative import (confirmed by the user).
- Absolute: z is the elevation in the world.
- The export has the same radio button. The default is Relative.
- The tool needs the heightmap to place relative objects. The heights can differ a little from the game (see the risk "Ground height").

## 8. Mask painter

**View**

- A top-down 2D map over the satellite image.
- The user can zoom, pan, and change the overlay opacity.

**Data**

- Store the mask in RGBA tiles of 512 x 512 pixels.
- Allocate a tile only when the user paints on it.
- A full 16384 x 16384 mask uses about 1 GiB. Keep only active tiles in memory. Move other tiles to a disk cache.
- Paint on the GPU with render targets.
- Undo stores the before-image of each touched tile for each stroke. Compress it. Set a memory limit.

**Tools**

- Hard and soft brush. Size, opacity, and hardness controls.
- Erase.
- Flood fill.
- Polygon and lasso fill.
- Auto mask from slope and height ranges. Include feather and a preview.
- Layer palette from layers.cfg. Show name and color for each layer.

**Output**

- One PNG file with the whole layer mask. Do not split it into layers or tiles. The map author does the final merge.
- The size equals the satellite size in the settings.
- Every pixel has one exact palette color from `class Legend` of layers.cfg. The sample source mask is RGB with no alpha.
- The tool writes no transparent PNG and no separate PNG for each layer. It does not import them.
- A soft brush makes blended edge colors. Use the hard brush as the default. Show a warning when the user chooses a soft brush.

## 9. Satellite imagery

The tool paints on a satellite image that the user imports. It does not generate a satellite image.

- Import: one PNG with the same size as the mask. There are no color rules.
- Brushes: color, clone, and smooth. A texture brush is optional.
- Paint in the 2D map first. Add 3D painting later.
- Use the same tile storage as the mask painter.
- Output: one 8-bit RGB PNG. The size equals the size of the input.

## 10. Heightmap editing

- Tools: raise, lower, smooth, flatten to a height, flatten to a plane, noise, and stamp.
- Spline tools: cut or fill the terrain along a spline. Use them for roads and runways.
- Store the heightmap as 32-bit floats in tiles. Undo works for each stroke.
- Update only the touched mesh chunks while the user paints.
- Export an ASC with the same cell size, origin, and NODATA value as the input.
- Let the user set the number of decimal places.

**ASC format (from height\_3.asc)**

- The header has 6 lines: `ncols 1024`, `nrows 1024`, `xllcorner 200000.000000`, `yllcorner 0.000000`, `cellsize 1.000000`, and `NODATA_value -9999`.
- After the header come `nrows` lines with `ncols` values each. The values have 2 decimals. The separator is one space. The line end is LF.
- Row 0 is the north row. The WRP stores row 0 as the south row.
- This ASC is the heightmap of bro\_range.wrp. Its range is -1.57 m to 101.09 m. The WRP heights are equal to the ASC flipped upside down. Verified: the largest difference is 0.
- The `xllcorner` of 200000 is the TB x offset. The writer must keep the header values of the input.
- The target map has 4096 x 4096 cells, which is about 16.7 million values.

## 11. Shapes and roads

- Shape types: polyline (road, fence line, runway), polygon (forest, field, flatten area), and point.
- Each shape has a type, a name, and properties (for example forest density).
- Polygon actions: scatter objects inside, paint a mask layer inside, flatten the terrain inside.
- Polyline actions: place objects along the line, paint a mask layer along the line (width and feather), shape the terrain along the line.
- Import and export SHP with DBF properties.
- The road method is an open decision (see section 16).

## 12. Mask-driven object fill

The tool fills areas with random objects. The areas come from mask colors. Example: put trees and bushes on every green part of the map.

- The user selects one or more mask colors. The user can set a color tolerance (0 to 255) and an alpha threshold.
- The user selects a recipe. A recipe is a weighted list of classes (trees, bushes, rocks).
- Recipe settings: density per hectare, minimum spacing, random yaw, random scale range, tilt to the surface normal (on or off), and a random seed.
- The tool places objects only on mask pixels that match the selected colors.
- Edge settings: inset from the color edge, edge feather (density falls near the edge), and clump noise for natural patterns.
- Exclusions: slope above a limit, height outside a range, water, roads, and near existing objects.
- Use Poisson-disk sampling for the spacing. Use a seeded random generator. The same seed gives the same result.
- Run the fill in tiles in a worker. Show a preview of instanced points before the user commits.
- Set an object count limit. Warn the user before the tool goes over it.
- Each fill makes a named group. The group stores the colors, recipe, and seed. The user can regenerate or delete the group after a mask change.
- Polygon shapes (section 11) use the same recipes.
- Target: place 1 million objects in 30 seconds. This is an assumption. Measure it.

## 13. WRP export

The tool writes the WRP file. The user does not need TB.

- Confirmed: TB writes an unbinarized WRP. The Arma 3 binarizer converts it to the final WRP.
- The tool writes the editable form first.
- Expected content: terrain grid and cell size, heights, per-cell surface indices (from the mask and layers.cfg), the object list (model path and transform), and the model path table. Verify the list against a TB-made sample.
- The WRP format is not officially documented. Use community documentation and open-source readers. Use TB-made samples for byte-level comparison.
- Method:
  1. Write a WRP reader. Show a sample WRP in the viewer.
  2. Write the WRP writer.
  3. Run a round-trip test: read, write, and compare.
  4. Run the final test: the binarizer accepts the file and the game loads the terrain.
- The tool also writes the satellite and mask tiles as PNG. A later step in the mod packing converts them to PAA. See "Tile export" below.

**Findings from the sample WRP (bro\_range.wrp, 6242413 bytes)**

I read the file. These facts are verified:

- The file starts with the 4 characters `8WVR`.
- Next are four 32-bit integers: 16, 16, 1024, 1024. They are the texture layer grid (16 x 16) and the terrain grid (1024 x 1024).
- Next is one 32-bit float: 64.0. This is the texture layer size in meters. 16 x 64 m = 1024 m, which matches the terrain.
- Next are 1024 x 1024 float heights, from byte 24 to byte 4194328. The range is -1.57 m to 101.09 m. Row 0 is the south row. The heights equal the sample ASC flipped upside down (verified, difference 0).
- After the heights come 16-bit values. They are probably a surface index grid. The exact size is not yet known.
- The file has a table of RVMAT paths. Names have the form `P_<a>-<b>_<L01>_<L02>_<L03>_<L04>_<L05>.rvmat`. `N` means that the slot is empty.
- The file has a table of model paths (P3D) and the object list. The sample has fences, walls, signs, and wrecks.

The object records and the 16-bit data are not yet decoded. M0 must decode them.

**Layer materials (RVMAT)**

- Each RVMAT supports up to 6 texture layers. bro\_range uses 5 (L01 to L05). bro\_msi uses 6 (L00 to L05).
- Stage0 is the satellite tile. Stage1 is the mask tile. Stage2 is a grey fallback color.
- Stages 3 to 12 are 5 pairs. One pair per layer slot: a normal map (`_nopx`) and a color map (`_co`). A slot with `N` has empty paths.
- Sample layers: L01 = dirt, L02 = asphalt, L03 = grass (custom mod texture), L04 = forest floor.
- Each tile needs one RVMAT for each combination of layers that it uses. The tool must find these combinations from the mask and layers.cfg, then write the files.
- TexGen3 (satellite) and TexGen4 (mask) use the world position. The scale is 0.0009765625 = 1/1024, which is 1 / tile size in meters. The offset is 0.125 for both axes.
- 0.125 equals half of the overlap: 256 px x 0.5 m = 128 m, divided by 1024 m. The V axis is flipped (negative scale, offset 1.125). The formula for a grid of tiles is in "Tile layout" below.
- TexGen1 and TexGen2 repeat the layer textures 5 times for each UV unit.
- `PixelShaderID` is `TerrainX`. `VertexShaderID` is `Terrain`.

**Tile export**

- Satellite tile name: `S_<xxx>_<yyy>_lco.png` (RGB, no alpha). Mask tile name: `M_<xxx>_<yyy>_lca.png` (RGBA). The numbers have 3 digits.
- Both tiles in the sample are 2048 x 2048 px.
- Tile size, overlap, and image size come from the mapframe settings. The tool cuts the whole image into tiles. Neighbor tiles share the overlap area.
- Tiles for each axis = `ceil(imageSize / (tileSize - overlap))`. This gives 2 for both samples, as TB shows. It is verified only for one image size.
- The tool must stream the tile cutting. It must not load the whole image.
- The mask tile in the sample uses 4 pure colors: blue (0,0,255), green (0,255,0), red (255,0,0), and black (0,0,0). Most pixels have alpha 255. About 3% have alpha 128. These are tile codes, not the author colors. See "Mask tile encoding" below.
- The RVMAT texture paths point to PNG names in lower case. The mod packing step converts the PNG files to PAA.
- The tool can also write the RVMAT files and the layer texture list. This removes one more TB step.

**Tile layout (verified with the 2 x 2 sample)**

I checked the four tiles and their RVMAT files. Definitions for the sample: T = tile size in meters = 1024. step = (tile px - overlap px) x m/px = 768. H = half overlap in meters = 128.

- Tile (tx, ty) uses the file name `S_<tx>_<ty>_lco.png`. Tile ty = 0 is the top (north) row.
- The tile grid starts at the top-left corner of the image. It has a border of H on the top and left sides.
- RVMAT UV transform, for world position (x, y) in meters: `u = (x - tx*step + H) / T` and `v = (T + H - ty*step - y) / T`.
- The RVMAT values match this formula for all four tiles: pos = (0.125, 1.125), (0.125, 0.375), (-0.625, 1.125), (-0.625, 0.375). The scale is 1/T on both axes. The V axis is flipped.
- `P_<tx>-<ty>_...` in the RVMAT name is the tile index. The question about this is closed.
- The satellite tiles are exact copies of the source image. The overlap areas are identical (difference 0).
- The sample mask border is one constant code, and it differs from tile to tile. The border of the satellite tiles has not been checked.

**Mask tile encoding (decoded from the bro\_msi sample)**

- The author draws a source (palette) mask. It uses the colors in `class Legend`, `class Colors` of layers.cfg. Example: `bro_wildfield` is (24, 186, 127).
- The mask tiles do not hold these colors. They hold codes. Each tile has up to 6 slots. A slot is one layer of that tile.
- The overlap areas of the mask tiles are not identical, because each tile has its own slot list. The tool must cut the source mask, then encode each tile.
- I compared the bro\_msi source mask with its four tiles. I used the same tile layout as for the satellite. A layer always gives the same code in a slot. At least 96% of the pixels of a layer agree. The slot codes are:

| Slot | Mask tile pixel (R, G, B, A) |
| --- | --- |
| 0 | (0, 0, 0, 255) |
| 1 | (255, 0, 0, 255) |
| 2 | (0, 255, 0, 255) |
| 3 | (0, 0, 255, 255) |
| 4 | (0, 0, 255, 128) |
| 5 | (0, 0, 255, 0) |

- The slot list of a tile is the order of the layer entries in the RVMAT name. Example: `P_000-000_L00_L03_L04_L02_L01_L05` means slot 0 = layer 0, slot 1 = layer 3, and so on. `L<n>` is the position of the layer in `class Layers` (counted from 0). `N` means that the layer is not in that area.
- A tile with fewer layers has fewer slots. Tile (1,1) in bro\_msi has 4 slots. A tile can have 6 layers at most. TB has a check box for this. It reports an error and the tile. The tool must have the same check, and it must list each tile that has too many layers.
- The slot order is not by area. I do not know the TB rule. Any fixed order should work if the mask tile and the RVMAT agree. The user tests the order in the game after the tool exists.
- About 2% of the pixels at layer borders have other codes. Example: green with alpha 128 next to a slot 4 area. These are probably blend or anti-alias codes. I did not decode them. Version 1 writes hard edges only.
- The border of a tile has one constant code. In bro\_range it is the most common layer of the tile. I did not check this for bro\_msi.
- The satellite tiles are plain crops. They need no encoding.

**layers.cfg (from the sample file)**

- `class Layers` lists 6 layer classes. Each has `texture` (empty in the sample) and `material` (a path to an RVMAT).
- `class Legend` has `picture` and `class Colors`. Each entry is a class name with one RGB color: `GdtGrassGreen[] = {{55, 51, 38}};`. This is the palette that the author uses in the source mask.
- The material RVMAT holds the layer textures (`_nopx` and `_co`). The tool reads them to build the tile RVMAT files.
- The sample has a name error: the layer is `GdtEnsoil`, but the color entry is `GdtSoil`. The parser must warn about unknown names.
- The first layers.cfg is for a different map than bro\_range. The second one (bro\_msi) matches its own tiles: 6 layers, 6 colors, and the same layer order as the RVMAT names.

**Second sample: bro\_msi**

- The RVMAT UV formula is correct for this map too. Tile size T = 2048 px x 1 m/px = 2048 m. The scale is 1/2048. The offsets are the same values as before: 0.125 and 1.125 or 0.375, and -0.625 for column 1.
- The RVMAT has up to 6 layer slots. Stages 3 to 14 are 6 pairs of `_nopx` and `_co` textures.
- The RVMAT values differ between the two maps: `diffuse` is 1.0 in bro\_range and 0.7 in bro\_msi. The layer texture repeat is 5 in bro\_range and 10 in bro\_msi. I checked all six layer RVMATs of bro\_msi. Diffuse and repeat: wildfield 0.7 and 10, asphalt 0.7 and 10, dirt 1.0 and 5, forest 1.0 and 10, grass\_green 0.7 and 10, marsh 0.7 and 10. Every tile RVMAT of bro\_msi has 0.7 and 10, also those without asphalt. Three rules fit: the first layer in layers.cfg, the lowest diffuse and highest repeat, or the most common value. The texture layer size (64 m in both maps) does not explain them. The tool must find the layer RVMATs by itself (see "Layer RVMAT lookup" below). It uses the first layer as the default rule, shows the values of all layers, and lets the user change the result.
- The tile RVMAT names use one file for each combination of layers that occurs in that tile. bro\_msi tile (0,0) has 36 files. A combination keeps the slot positions of the tile.
- The WRP refers to these RVMAT names.

**Layer RVMAT lookup**

- Every map has its own layers.cfg. The `material` paths point to different places. The tool must find the files itself.
- Search roots are project settings: the P: drive (for example `P:\`), the game folders, and the mod folders. A path such as `bromine\bro_msi\data\bro_dirt.rvmat` is relative to a root. Game paths such as `a3\...` are inside PBO files. Use the PBO index.
- Parse each RVMAT: `diffuse`, `PixelShaderID`, and for each stage the `texture` and the `uvTransform` (`aside`, `up`, `dir`). In the samples, stage 1 is the `_nopx` map and stage 2 is the `_co` map.
- The tile RVMAT uses the texture paths of the layer RVMATs. This matches the sample (for example `bro_dirt_nopx.paa`).
- Show a table in the UI: layer, RVMAT path, found or missing, diffuse, repeat. Warn when a file is missing, or when the values differ.
- Default rule: use `diffuse` and the repeat of the first layer. **Assumed:** TB does this. The user can choose another layer, or type the values. Test the result in the game.
- `bro_forest.rvmat` is different. Its `forcedDiffuse` is (0, 0, 0, 1), and the `dir` of its stages is (0, 0, 10). The tile RVMATs show no sign of these values. Version 1 ignores them.

**PNG to PAA**

- The user converts the tiles in a separate step. The script `All_Pal2PacE.ps1` runs Pal2PacE (Mikero) on each `layers\[snm]_*.png` file. It writes the `.paa` next to the PNG.
- The tool only has to write the `layers` folder. It must not convert. It uses the file names `S_<xxx>_<yyy>_lco.png` and `M_<xxx>_<yyy>_lca.png`.
- The RVMAT texture paths use a prefix, for example `bromine\bro_msi\data\layers\`. The tool needs this prefix as a project setting.

## 14. Export formats

| Output | Format | Notes |
| --- | --- | --- |
| Terrain | WRP | Editable form first. See section 13. |
| Heightmap | ASC | Same header as the input. |
| Satellite image | PNG | One file. Same size as the mask. |
| Mask image | PNG | One file. TB palette mask. No alpha. |
| Tiles | S and M PNG files and RVMAT files | In a `layers` folder. See section 13. |
| Objects | TB object text | See section 7. |
| Shapes | SHP, SHX, DBF | Fields depend on the shape type. |
| layers.cfg | Text config | Written after the user edits the layers. |
| Project | JSON and a tile folder | For this tool only. |

## 15. Milestones

| Step | Content | Acceptance test |
| --- | --- | --- |
| M0 | WRP format study: read a sample WRP | The tool prints the grid, heights, and object count of bro\_range.wrp. The heights equal the sample ASC, flipped. |
| T1 | Tile and RVMAT pipeline (task B in the build brief) | The tiles match the bro\_range and bro\_msi samples. |
| M1 | Terrain from ASC, satellite drape, fly camera | The terrain shows at the correct size. The heights match the ASC. |
| M2 | MLOD and ODOL parsers, PBO index, config.bin, PAA | The doorway model shows with its textures, from the MLOD and from the ODOL. |
| M3 | Select, gizmos, undo, object text import and export | The round trip of Trees2\_3\_2.txt is byte-identical. |
| M4 | Mask painter and PNG export | The PNG has the exact size and palette colors. Task B accepts it. |
| M5 | Mask-driven object fill | Green mask areas fill with trees. The same seed gives the same result. |
| M6 | Satellite painting | The user paints on an imported image. The PNG has the same size. |
| M7 | Heightmap editing and ASC export | A round trip without edits gives an identical ASC. |
| M8 | Scatter brush, splines, shapes, SHP export | A fence, a runway, and a forest polygon generate. QGIS opens the SHP. |
| M9 | WRP writer | The binarizer accepts the WRP. The game loads the terrain. |
| M10 | Speed and polish | The tool meets the object targets in sections 6 and 12. The target map (121 tiles) works. Done: 1 million trees at 70 to 80 FPS on the user's PC (RTX 5090). |
| M11 | Editor additions (section 18.1) | Remove by roads, draw distance and far boxes, mask and satellite painting in 3D. Tests in section 18.1. |
| M12 | Mod folder and config generator (section 18.2) | The generated bro_laguna folder packs with the user's PBO tool, and the map loads in the game with its names, surfaces, and clutter. |
| M13 | Road generator (section 18.3) | A road between two or more points follows the slope limits and goes around water. The game accepts the roads.shp. |
| M14 | Village generator (after M11 to M13 are accepted) | To be planned. |

## 16. Risks and open items

- **Scope.** The scope is large. Build in milestone order. Each milestone must work alone.
- **WRP writer.** The format is not officially documented. This is the largest technical risk. The heights are decoded. The 16-bit data and the object records are not. Mitigation: write a reader first (M0). Use TB-made samples. Compare byte by byte.
- **Tiles.** The tool writes the tiles and RVMAT files. The layout is verified with two 2 x 2 samples. The target map has 121 tiles for each image. No large map has been tested.
- **Road method.** Decided and done (M8, M9): `roads.shp` with an `ID` field and `RoadsLib.cfg`, in map coordinates.
- **ODOL parsing.** The format is complex. Samples exist (MLOD and ODOL version 75). Mitigation: parse the MLOD first. Use the MLOD as the truth for the ODOL parser. Use the bounding-box fallback.
- **TML format.** Three samples are decoded (section 5). The effect of AutoCenter and the shift fields is not verified. TML is optional.
- **Object rotation and z.** The samples have only yaw. Pitch and roll are always 0. The rotation order is not verified. The user tests it later (decision of 23 Oct 2026). Fences and walls on slopes need it.
- **layers.cfg colors.** The author colors are in class Legend, class Colors. See section 13.
- **Mask color match.** A soft brush makes blended edge colors. Use a tolerance and an alpha threshold. Use the hard brush as the default.
- **Fill speed.** A large forest can have millions of objects. Use tiles, a worker, a count limit, and a preview.
- **Shapefile content.** Confirm the geometry types, field names, and coordinate system that the next tool expects.
- **Large images.** The target images have about 268 million pixels each. Use tiles, a mip pyramid, and streaming encode and decode.
- **Ground height.** Arma 3 uses triangulated cells. Simple bilinear sampling can differ by a small amount. Check a few points in the game. The user tests this later, when the tool has more features (decision of 23 Oct 2026). It becomes important for the village generator (buildings on slopes).
- **Game assets.** Never copy Bohemia or mod assets into the project. Read them from the local install only.

**Open questions from the sample files**

1. Which rule does TB use for `diffuse` and the repeat: the first layer, the lowest diffuse and highest repeat, or the most common value? All three fit bro\_msi. A map where the first layer has other values would show the rule. If you know such a map, please say so.
2. To test in the game: hard edges at layer borders (version 1) against the blend codes that TB writes.
3. To test in the game: the slot order, and the rule for the border color of a tile.
4. Is it correct that the WRP stores the RVMAT combination of each 64 m layer cell? The 16-bit data in the WRP may be this. M0 must check it.

## 17. Rules for the coding LLM

- Use tabs. Do not use spaces for indentation.
- Do not leave trailing spaces.
- Use as few blank lines as possible.
- Put each comment on its own line. Do not put comments at the end of a code line unless it is necessary.
- Write comments and docs in ASD-STE100.
- Keep modules small. Parsers must not depend on the UI.
- Add a unit test for each parser with a real sample file.

## 18. Plans after M10 (v0.14)

Status on 23 Oct 2026: M0 to M10 are done. The code is in Git (`K:\Bro_TerrainTool`, tag `m10`).

**Decisions and changes of 23 Oct 2026**

- Fog: the decay range is 0 to 1 % (the useful part). The base altitude can be below 0 m, as in Arma 3.
- Heightmap: "Height offset" raises or lowers all heights (one undo step). The user corrects the sea level of World Machine DEMs with it. A sea plane at 0 m shows in the 3D view (switch "Sea level"). The TER offset question is closed.
- Foliage (faces with a `_ca` texture and a `TreeAdv` shader) uses normals that point out from the crown, the same normal on both sides of a card, and half the shadow strength. Road bands were black because their faces pointed down.
- Polygon and lasso can erase (restore the imported mask).
- Model front: assume the front of a model is its negative Y axis (model space). It is not always true. The village generator gets a table to correct it for each model.
- Not needed: the layer RVMAT table in the UI, TML import, the PBO index.

### 18.1 M11: editor additions

1. **Remove by roads.** Shapes tab, property panel. Select lines: the selected shape, or all lines with the property `ID` in a list (for example `1, 4, 6`), or all roads. Distance: half the road width (from RoadsLib.cfg) plus a margin in meters. The action deletes the objects whose center is inside the band, in the visible and unlocked layers only. One undo step. A preview shows the count first.
   - Test: a road of width 10 m and margin 2 m through a fill removes all objects within 7 m of the center line, and no others. Ctrl+Z restores them.
2. **Draw distance and far boxes.** Viewport tab, group "Performance": a slider for the object draw distance (moves from the Objects tab), and a switch "Boxes far away" with a distance. Past the distance, each object shows as a box with the size of its model and the mean color of its texture. The boxes use one instanced mesh.
   - Test: the bench with 3 million objects on the user's PC. The FPS with boxes is equal to or more than the FPS without boxes, at the same draw distance.
3. **Mask and satellite painting in 3D.** The Imagery tab tools also work in the 3D view: the brush ring on the terrain, the same Rust commands as the 2D painter, and the 3D drape updates only the changed area.
   - Test: a stroke in 3D changes the same pixels as the same stroke in 2D. Undo works in both views.

### 18.2 M12: mod folder and config generator

Reference: `P:\bromine\bro_laguna` (user's map). The PBO tool packs the folder `P:\<tag>\<map>\`. The generator writes the source files only. It does not pack and it does not convert to PAA.

Folder (from bro_laguna):

| Path | Source |
| --- | --- |
| `config.cpp` | Generated (see below) |
| `<map>.wrp` | Export tab (M9) |
| `data\Layers.cfg`, layer RVMATs | The project layers.cfg, written back (layers.cfg writer, section 14) |
| `data\layers\` | Export tab (M9) |
| `data\roads\roads.shp` (and shx, dbf, cpg), `roadslib.cfg` | Export tab (M9), RoadsLib path of the project |
| `icon_ca.paa`, `picturemap_ca.paa`, the picture shot, the preview video | Not generated. The config refers to them. The tool warns when a file is missing. |

`config.cpp` content:

- `CfgPatches` (class = map name, `requiredAddons` default `A3_Data_F_Decade_Loadorder`), `CfgWorldList`.
- `CfgWorlds`: the class chain of the parent world (default `Stratis`, as bro_laguna), then the map class with `worldName`, `mapSize`, `newRoadsShape`, `description`, `author`, `icon`, `pictureMap`, `pictureShot`, `previewVideo`, `latitude`, `longitude`, `mapZone`, `startDate`, `startTime`, `loadingTexts[]`, `class OutsideTerrain`, and `centerPosition[]`.
- `class Names` from the point shapes. A point shape has the properties `type` (`NameCity`, `NameVillage`, `NameLocal`, `NameMarine`, `Hill`, ...), `name`, `radiusA`, `radiusB`, `angle`.
- `class Clutter`, `CfgSurfaces`, and `CfgSurfaceCharacters`: one surface for each layer of layers.cfg. `files` is the name of the `_co` texture of the layer RVMAT without `_co.paa`, plus `*` (for example `gdt_strdirt*`). The surface values come from a preset (grass, dirt, forest, asphalt, rock, sand), or are copied from a vanilla surface class (the tool reads `P:\a3\map_*\config.cpp`). The clutter list of each layer is edited in the UI.
- Keep the user's work: the generator never overwrites a file without a preview. It keeps the old file as `.bak`. Parts that the tool does not know (for example the ACE values, the commented weather) stay in a "custom" text block that the user edits in the tool.

Tests:

- Golden test: the settings of bro_laguna give a config.cpp that has the same classes and values as the user's file (text order and comments can differ). The tool reads both with its config parser and compares the trees.
- In-game test (user): the generated folder packs, the map loads, the names show on the map, the clutter shows on each surface.

### 18.3 M13: road generator

- The user places points on the terrain (start, end, and waypoints between them) and selects a road type (RoadsLib).
- The core finds the path with A* on the heightmap grid, in the order of the points. Costs: length, slope (a hard limit for each road type, for example 12 % for a main road), turns (a smooth path), water (height below 0 m: not allowed, or a high cost for a bridge later), mask layers (a cost for each layer, for example forest), objects (large models are not allowed; trees are a small cost), and existing roads (a lower cost, so roads join).
- The path becomes a smooth road line: Douglas-Peucker, then control points with a minimum turn radius. The line has the `ID` of the road type. The existing tools do the rest (cut and fill, mask band, remove by roads).
- Step 2: "Connect points": a network between point shapes (for example villages), with a minimum spanning tree and the reuse of existing roads.
- Bridges and junction objects come later.
- Tests: on a test terrain with a hill and a lake, the road goes around the lake and stays under the slope limit at each point. The same input gives the same road. A 16 km road on the target map takes less than 5 seconds.

### 18.4 Open questions for the user

1. M12: the PBO tool (pboProject or Addon Builder). Does the folder need a `$PBOPREFIX$` file? (bro_laguna has none; the vanilla folders have `$PBOPREFIX$.txt`.)
2. M12: parent world class: always `Stratis`, or a choice (Altis, Malden, Enoch, Tanoa)?
3. M12: `bro_laguna\cacti\config.cpp` overrides the vanilla class `A3_Vegetation_F_Enoch` in CfgPatches. Is this on purpose? The generator does not write sub-addons.
4. M13: water: stop at water, or allow bridges later?
5. The order: M11, then M12, then M13, or the generators first?
