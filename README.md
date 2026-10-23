# Terrain Tool
Offline Arma 3 terrain tool for Windows 11. It replaces Terrain Builder step by step. See the design doc and the build brief.
## Status
| Part | Status |
| --- | --- |
| `crates/core` | Rust library: config parser, `layers.cfg`, layer RVMAT, tile RVMAT, ASC, WRP, tile pipeline, PAA, P3D (MLOD and ODOL 69 to 75), RVMAT (text and binarized), object database, TB project (ALB1), layer mask (painter) |
| `wrpdump` | Task A (M0): prints a WRP, exports the heights as ASC, does a round trip |
| `tilegen` | Task B (T1): writes the `S_`, `M_` tiles and the `P_*.rvmat` files |
| `apps/desktop` | M1: Tauri app with a 3D viewer for the ASC, the satellite image, and the WRP objects. M2: model browser, preview, WRP objects with real models. M3: object text import and export, place, select, gizmos, undo, layers. M4: mask painter and mask PNG export. M5: object fill from mask layers. M6: satellite painting and satellite PNG export. Project file (save and load all work). M7: heightmap editing and ASC export. M8: shapes, splines, scatter brush, SHP import and export. M9: export for the game (tiles, tile RVMAT files, WRP, roads.shp). M10: speed test (bench), progress and Cancel, ribbon with a property panel, light and dark theme, viewport (time of day, shadows, fog), new map and TER import |
## Requirements
- Windows 10 or 11 (the installer installs WebView2 when it is missing).
- The work drive P: must be mounted (Arma 3 Tools: "Mount the Project Drive"). The game paths of models and textures start at the root of P:. The tool shows a message at the start when P: is missing.
- The game data extracted to `P:\a3` (Arma 3 Tools: "Extract Game Data"). At the first start, the tool adds `P:\a3` to the model folders. Add your own mod folders (on P:) in Models, Model folders.
- For the game: the Arma 3 Tools (Binarize, ImageToPAA) and your PBO tool.
## Build from source
1. Install Rust. Download `rustup-init.exe` from https://rustup.rs and run it. Accept the default settings.
2. If the installer asks for the Visual Studio C++ Build Tools, install them. Select the workload "Desktop development with C++".
3. Close the terminal. Open a new terminal (PowerShell).
4. Make sure that Rust is installed: `cargo --version`. The terminal must show a version number.
5. Go to the project folder: `cd K:\Bro_TerrainTool`.
6. Run the tests: `cargo test --release`. All tests must pass. A test without its sample files shows `SKIPPED`.
7. Build the tools: `cargo build --release`.
8. The tools are in `K:\Bro_TerrainTool\target\release`: `wrpdump.exe` and `tilegen.exe`.
## Use wrpdump
- Show the content: `target\release\wrpdump.exe tests\fixtures\bro_range\bro_range.wrp`
- Export the heights: add `--asc out.asc`. Options: `--xll 200000`, `--yll 0`, `--decimals 2`.
- Compare with an ASC: add `--compare-asc tests\fixtures\bro_range\height_3.asc`. The largest difference must be less than 0.0001.
- Round trip: add `--write copy.wrp`. The tool writes the file again and compares the bytes.
- Show bytes: add `--hex <offset>`.
## Use tilegen
1. Copy `tests\fixtures\bro_msi\project.example.json` to a project folder. Rename it to `project.json`.
2. Set the values. Paths are relative to the folder of `project.json`. The source satellite and mask can be PNG or 24-bit BMP.
3. Set `searchRoots` to the folders that contain the layer RVMAT paths of `layers.cfg`, for example `"P:\\"`.
4. Check the settings: `target\release\tilegen.exe project.json --check`. Read the layer table and the warnings.
5. If the `diffuse` or `repeat` value is wrong, add `"diffuse": 0.7` or `"repeat": 10` to `project.json`.
6. Write the files: `target\release\tilegen.exe project.json --wrp <map.wrp> --wrp-out <new.wrp>`.
7. Use `<new.wrp>` for the map. It refers to the new RVMAT files. A WRP from TB refers to the TB RVMAT names, which are different.
8. Run `All_Pal2PacE.ps1` on the output folder to make the PAA files.
## Build and run the desktop app
1. Install Node.js LTS from https://nodejs.org. Accept the default settings.
2. Close the terminal. Open a new terminal (PowerShell).
3. Make sure that Node.js is installed: `node --version`. The terminal must show a version number.
4. Go to the app folder: `cd K:\Bro_TerrainTool\apps\desktop`.
5. Install the packages: `npm install`. Do this one time, and again after `package.json` changes.
6. Start the app in development mode: `npm run tauri dev`. The first start compiles for some minutes.
7. To make an installer, run `npm run tauri build`. The installer is in `K:\Bro_TerrainTool\target\release\bundle\nsis`.
## Ribbon
The ribbon at the top has one tab for each step of the work, from left to right: Heightmap & imagery, Objects, Shapes, Imagery, Export, and Viewport (Ctrl+1 to Ctrl+6). Each tab has groups of large buttons; the tooltip gives more help and the key. The browser on the left holds the lists to pick from: Models and Layers (Objects tab), Shapes and Models (Shapes tab), and the mask layers (Imagery tab). The property panel on the right shows the settings of the tab, of the selected item, or of the active tool (brush settings, new map, object fill, shape properties). The two buttons at the top right hide them. A click on a model opens a small preview window at the bottom left of the 3D view; ✕ closes it. The ground switch at the top left of the 3D view shows the satellite image, the mask, or the mask over the satellite image. The sun and moon button switches between the dark and the light theme. The tool keeps these settings for the next start.
## Use the viewer
1. Heightmap & imagery tab: click "Import DEM" and select the heightmap (ASC, or a Terragen TER file; the TER corner is 200000, 0). Or click "New map", set the grid, the cell size, and the corner in the property panel, and click "Make the map" for a flat map.
2. Heightmap & imagery tab: click "Satellite" and select the satellite image (PNG or BMP). The viewer reduces large images to 4096 px.
3. Or click "Open WRP" and select an editable WRP (`8WVR`). The tool shows the terrain and the objects of the WRP. The WRP has no TB offset, so the coordinates start at 0.
4. Or click "Open TV4P" and select a Terrain Builder project. The tool loads the imported ASC heightmap and satellite image of the project, and the objects of the exported WRP (`<WRP export folder>\<project name>.wrp`). The objects in the TB layers are not read yet.
5. Click in the view. Hold the right mouse button to look around. Use W, A, S, D to move, Q and Z to move up and down, and Shift to move fast. Turn the mouse wheel to change the speed.
6. The status bar shows the TB coordinates and the height under the cursor.
7. Models (property panel of the Objects and Shapes tabs): click "Add folder" and select one or more model folders (for example `P:\`). The tool scans them now and each time the tool starts. ✕ removes a folder. "Rescan" scans the folders again, for example after you add models. Search a model name and click it to see it in the preview. Drag to turn the preview, and turn the mouse wheel to zoom.
8. Layers (left side): click a layer name to make it the active layer. New objects go into the active layer. Double-click a name (or click "Rename") to rename the layer. "New" adds `New Layer <n>`. ▲ and ▼ move the active layer in the list. "Delete" deletes the active layer and its objects (the last layer cannot be deleted). Ctrl+Z gives a deleted layer back.
9. After the scan, "Open WRP" shows each object with its model and textures. Without a scan, each object is a 2 m box. A model that does not load shows as a red box. The status line shows the first error. A model without a visual LOD (for example a clutter cutter) shows nothing.
10. "Draw distance ×" (Objects tab, View group) multiplies the distance at which the objects show. The distance grows with the model size. Use a higher value to see objects from far away (higher values are slower). The tool keeps the value for the next start.
10. Test without files: start `npm run dev` and open `http://localhost:1420/?demo=4096` in a browser. This shows a synthetic 4096 x 4096 terrain.
## Paint the mask (Imagery tab)
1. Open the mask in the Heightmap & imagery tab ("Mask"). Then click the Imagery tab (Ctrl+4). The 2D painter shows. "3D view" shows the terrain with the mask and the satellite image.
2. Click "Open mask". Select `layers.cfg`, then the source mask (PNG or 24-bit BMP). If a TB project is open, the tool uses the files of the project.
3. If the mask has pixels that are not a palette color of `layers.cfg`, the tool shows the number. These pixels get the nearest palette color, as in `tilegen`.
4. Click a layer in the "Mask layers" list. Then select a tool:
   - Brush: paint the layer. Radius is in mask pixels (keys `[` and `]`). With hardness or opacity below 1, the edge is dithered. Each pixel keeps an exact palette color.
   - Erase: paint the pixels of the imported mask again.
   - Fill: fill the connected area of one color.
   - Polygon: click the points, then double-click or press Enter. Backspace removes the last point. Escape cancels.
   - Lasso: drag around an area.
5. Right or middle mouse button: pan. Wheel: zoom. Ctrl+Z and Ctrl+Y: undo and redo (each stroke, fill, or polygon is one step).
6. "Overlay" sets the opacity of the mask over the satellite image. "Mask in 3D" shows the mask on the terrain in the 3D view.
7. Click "Mask" under "PNG export" to write one RGB PNG with the palette colors. Use this PNG as the mask in the `tilegen` project file.
8. "Save" keeps the mask in the project file. "PNG export" writes the PNG for `tilegen`.
9. Speed and memory test with a 16384 x 16384 mask: `cargo test --release -- --ignored --nocapture`.
## Save and open the work (project file)
1. Click "Save" (Ctrl+S) or "Save as" (Ctrl+Shift+S). Select a name, for example `oregon.ttproj`.
2. The tool writes `oregon.ttproj` and the folder `oregon_data` next to it: `mask.png`, `satellite.png`, `heights.bin`, `source.asc` (a copy of the source heightmap), `objects.bin`, and `objects_raw.txt`. Keep the file and the folder together.
3. A save writes an image again only when it changed after the last save. Each file goes to a temporary file first, then the tool renames it.
4. The window title shows `*` when there are changes that are not saved. The tool asks before it closes, or before it opens another project, when there are such changes.
5. Every 5 minutes, the tool writes an autosave: `oregon.autosave.ttproj` and `oregon.autosave_data`. Your own project file does not change. The autosave starts after the first save. To use an autosave, open `oregon.autosave.ttproj` with "Open project".
6. Click "Open project" to load everything again: the heightmap, the satellite image, the mask (the project keeps the path of `layers.cfg`; if the file is not there, the tool asks for it), the object layers, the fills, and the model folders.
7. The undo list is not saved. After a project opens, erase in the mask painter restores the mask of the project, not the first import.
## Edit the heightmap
1. Open a heightmap (ASC, WRP, TB project, or project file). In the Heightmap & imagery tab (Ctrl+1), click a brush in the Sculpt group. The property panel shows its settings. Click the brush again to stop. A yellow ring shows the brush on the terrain.
2. Tools:
   - Raise and Lower: strength is the height in meters for each dab at the centre.
   - Smooth: strength 0 to 1.
   - Flatten: Ctrl+click on the terrain picks the height, or type it. Strength 0 to 1.
   - Plane: Ctrl+click two points. The terrain then flattens to the slope between them. Strength 0 to 1.
   - Noise: strength is the height in meters for each dab. "Size" is the size of the noise.
   - Stamp: click "Load stamp" and select a PNG or BMP (white is high). "Size" is the width in meters, "Height" the height of a white pixel. A click puts the stamp. "Raise only" raises the terrain to the stamp and never lowers it.
3. "Hardness" is the part of the radius with full strength. The rest falls smoothly to 0.
4. "Objects follow the terrain" (on by default): after each stroke, the objects in the changed area keep their height above the terrain.
5. Ctrl+Z and Ctrl+Y undo and redo a stroke, together with the objects that moved.
6. Click "Export ASC" to write the heightmap. The header, the cell size, the origin, and NODATA are the same as the source. Rows that did not change keep their original text, so an export without edits is byte-identical to the source. "Decimals" sets the decimal places of the changed rows (empty: as in the source).
7. Speed test with 4096 x 4096 cells: `cargo test --release -- --ignored --nocapture`.
## Shapes, splines, and roads
1. Click the Shapes tab (Ctrl+3). The property panel shows the shapes, the SHP import and export, and RoadsLib.cfg.
2. Click "New line", "New polygon", or "New point", then click on the terrain to add points. Enter or a double-click ends the shape. Backspace removes the last point, Escape ends it.
3. Drag a point to move it. Click a line to select its shape. Ctrl+click adds a point at the end of the selected shape. Delete removes the selected point (the red one). Ctrl+Z and Ctrl+Y undo and redo each change.
4. The panel shows the selected shape: name, group (the SHP export writes one file for each group), "Smooth curve", "Closed loop", and the properties (DBF fields). For a road of RoadsLib.cfg, set the group to `roads` and add the property `ID` with the road type.
5. Spline objects: select a line, select a model in the model panel, then check "Objects along the line". Presets: Fence (spacing = model length, along the line, tilted with the terrain), Runway lights (two rows, 23 m to each side, 30 m apart), Runway line (1 m apart). The objects go into the active layer, and the tool makes them again after each change of the line.
6. Actions:
   - Polygon: "Scatter (fill recipe)" fills the polygon with the recipe and the rules of the Object fill section (Objects tab). "Paint mask inside" paints the selected layer of the Imagery tab. "Flatten inside" flattens to a height (empty: the mean height), with a feather.
   - Line: "Paint mask along" (width and feather), "Cut / fill road" (road width, feather, smooth along: the centre line height is the mean over this distance).
   - The mask actions undo with Ctrl+Z in the Imagery tab. The terrain actions undo with Ctrl+Z in the 3D view; "Objects follow the terrain" of the brush settings applies.
7. "Export SHP": select a folder. The tool writes `<group>.shp` (with SHX, DBF, CPG) for each group, in TB coordinates (with the map offset). A group with more than one shape type gives `<group>_line.shp` and so on. Smooth curves are written as their points (about 2 m apart). A smooth road (a line with an `ID`) is written as its control points, because TB makes the curve itself.
8. "Import SHP": select SHP files. Each file becomes a group. Multi-part shapes become one shape for each part.
9. The project file keeps the shapes and the path of the RoadsLib.cfg.
10. Roads: click "RoadsLib.cfg" and select the file (the import of SHP files also looks for `RoadsLib.cfg` next to them). A line with the property `ID` shows as that road type: a band of the road width on the terrain, with the road texture (or the map color when the texture is not in the model folders). The property `ORDER` sets the layering: 0 is on top. New lines and imported roads are smooth curves, as in TB.
11. F moves the camera to the selected shape (in the Shapes tab) or to the selected objects.
12. A road has an end piece of one road width at each end, with the end texture of the road type (`mainTerTex`). The length of the end piece is an assumption. Compare it with the road in the game.
13. When a road is selected, "Cut / fill road" uses the width of its road type.
## Scatter brush
1. In the Objects tab (Ctrl+2), add the models to the recipe of the Object fill section and set the density, spacing, scale, and rules.
2. Click "Scatter brush". A green ring shows the brush; set its radius in meters.
3. Paint: each dab adds objects until the circle has the density of the recipe. The spacing, slope, height, and water rules apply. Shift+paint removes the objects of the recipe models under the brush.
4. The objects go into the active layer. Each stroke is one undo step. Click "Scatter brush" again to select objects again.
## Use the satellite painter
1. Click "Open satellite" and select the satellite image (PNG or 24-bit BMP). It must have the same size as the mask. A TB project opens its satellite image too.
2. In the Imagery tab, click "Satellite" in the Paint group. The tools now change the satellite image. The mask paint target selects the mask tools again.
3. Tools:
   - Color: paint the color of the color field. Ctrl+click in the image picks the color under the cursor.
   - Clone: Alt+click sets the source point. Then paint: the brush copies from the source with the same offset. The offset stays for the next strokes until the next Alt+click.
   - Smooth: blur the image under the brush. Each pass blurs more.
   - Texture: click "Load texture" and select a PNG, BMP, or PAA (for example a `_co.paa` ground texture). "Repeat px" is the number of satellite pixels for one repeat of the texture.
4. Radius, hardness, and opacity work as in the mask painter, but the edge blends the colors. One stroke never goes above its opacity (smooth adds up).
5. Ctrl+Z and Ctrl+Y undo and redo in the paint target. The "Overlay" slider sets the mask opacity over the image (0 hides the mask).
6. "3D view" of the Imagery tab shows the painted image on the terrain.
7. Click "Satellite" under "PNG export" to write one 8-bit RGB PNG. Use it as the satellite image in the `tilegen` project file.
8. "Save" keeps the image in the project file. "PNG export" writes the PNG for `tilegen`.
9. Speed and memory test with a 16384 x 16384 image: `cargo test --release -- --ignored --nocapture`.
## Use the object fill
1. Open the heightmap (ASC, WRP, or TB project). Open the mask in the Heightmap & imagery tab. Then click the Objects tab (Ctrl+2).
2. Scan the model folders. Click a model in the model panel (Ctrl+click adds one more, Shift+click selects a range), then click "Add" in the "Object fill" panel. In the recipe list, Ctrl+click and Shift+click select models to remove together. Placement uses the last model that you clicked. Set the weight of each model: a model with weight 2 is used two times as often as a model with weight 1.
3. Select one or more mask layers. The tool places objects only on these layers.
4. Set the density (objects for each hectare), the spacing, the scale range, and the rules (inset, feather, clumps, slope, height, water, existing objects).
5. "Tilt to terrain" sets pitch and roll from the slope. This is not verified against TB yet.
6. Select "Add to new layer" (the tool makes the layer `New Layer <n>`) or "Add to currently selected layer". Click "Preview". The 3D view shows a yellow point for each object. Click "Commit" to put the objects into the layer. If the fill can make more than 2 million objects, the tool asks you first.
7. The same seed gives the same result. Click "New" to get a different result.
8. Each fill shows as a row below its layer. ✕ deletes the fill and its objects. Other objects in the layer stay. Ctrl+Z gives the fill back. Copied or pasted objects are not part of a fill.
9. "Save recipe" and "Load recipe" use a JSON file. The project file keeps the fills and their settings.
10. Speed test with 1 million objects: `cargo test --release -- --ignored --nocapture`.
## Export for the game
1. Open the heightmap, the mask (with its layers.cfg), and the satellite image. Or open a TB project (TV4P) and the mask. Scan the model folders (the WRP needs the game path of each model).
2. Click the Export tab (Ctrl+5). With a TB project, the settings come from the project: the WRP file `<WRP folder>\<name>.wrp`, the layers folder `<WRP folder>\data\layers`, the layers game path, the tile size, the overlap, and the texture layer size. The project file keeps the settings.
3. Check the settings. "Automatic tile size and lowest overlap" (on by default) takes the largest tile size with a fitting overlap (2048 px, the TB limit, first), then the lowest even overlap (2 px or more) at which each texture layer cell lies fully inside one tile. Each cell uses one tile RVMAT, so a cell must not cross the edge of its tile. Less overlap gives less edge dilation of the textures in the game. Clear it to type the tile size and the overlap yourself. "WRP file": an existing file is replaced. "Layers game path": the game path of the layers folder (for example `bromine\bro_msi\data\layers\`). The RVMAT files and the WRP use it.
4. "Satellite tiles": write the `S_` tiles. "Write roads.shp": write the lines with an `ID` property as `roads.shp` into the roads folder. "Convert tiles to PAA": run ImageToPAA.exe of the Arma 3 Tools for each tile. The PNG files stay.
5. Click "Export". The tool writes the `S_` and `M_` tiles and the `P_*.rvmat` files (the same files as `tilegen`), and the WRP with the edited heights, the RVMAT of each texture layer cell, and the objects of the shown layers. Hidden layers are not exported.
   - The dialog shows the objects outside the map (x or y below 0, or larger than the map size). Binarize stops on them. "Leave out the objects outside the map" (on by default) keeps them out of the WRP.
   - The dialog shows an error when the heightmap corner is not the corner of the TB map frame. TB requires the map frame at 200000, 0.
6. Binarize the WRP with the Arma 3 Tools (for example with pboProject), then test the terrain in the game.
## Viewport
1. Click the Viewport tab (Ctrl+6).
2. "Sunlight ×" sets the brightness of the sun (default 2; the sky light grows by half as much).
3. Time of day: Sunrise, Day, Sunset, Night, or the time slider. The sun moves from the east (morning) through the south to the west (evening). At night the moon gives a weak blue light.
4. "Shadows": shadows of the sun near the camera (terrain and objects). Turn them off when the view is slow.
5. Effects: "Ambient occlusion" (soft shadows in corners, under trees, at the foot of walls; it fades out from 250 to 600 m), "Bloom" (a small glow around bright parts), and "Filmic colors" (ACES tone mapping; turn it off to see the exact colors of the satellite image). Turn them off when the view is slow.
6. Fog, as in 3DEN: density (0 to 10 %), base altitude (m), and decay (0 to 10 %). Below the base altitude the fog has its full density. Above it, the density falls by the decay for each meter. Decay 0 gives the same fog at all altitudes.
7. The tool keeps these settings for the next start.
## Speed test and long jobs
1. Bench (Object fill panel): add models to the recipe, set the number (for example 500000), and click "Place". The tool puts that number of the recipe models at random positions on the whole map, in a new layer `Bench <n>`. The status line shows the time. Fly over the map and read the FPS in the status bar. ✕ on the fill row (or Ctrl+Z) removes the objects.
2. The fill, the export for the game, and the model scan show a progress bar in the top bar. "Cancel" stops the job. A cancelled fill or model scan changes nothing. A cancelled export writes no WRP, but some tiles can be written.
## Rules for the code
Tabs for indentation. No trailing spaces. Few blank lines. Comments on their own lines. Comments and docs in ASD-STE100.
