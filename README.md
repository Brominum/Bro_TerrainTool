# Terrain Tool

Offline terrain editor for Arma 3 on Windows. It replaces Terrain Builder for terrain editing and export.

## Requirements

- Windows 10 or 11.
- [Rust](https://rustup.rs) to build the project.
- [Node.js LTS](https://nodejs.org) to run the desktop app from source.
- Arma 3 Tools, with the project drive (`P:`) mounted and game data extracted to `P:\a3`.

## Build

Open PowerShell in the project folder.

Run the tests:

```powershell
cargo test --release
```

Build the tools:

```powershell
cargo build --release
```

The command-line tools are in `target\release`.

## Run the desktop app

From the `apps\desktop` folder, run:

```powershell
npm install
npm run tauri dev
```

To build a Windows installer:

```powershell
npm run tauri build
```

The installer is in `target\release\bundle\nsis`.

## Features

- **Terrain:** Import and edit heightmaps, or create a new map.
- **3D viewer:** View terrain, satellite imagery, and objects.
- **Objects:** Place, move, and scatter models. Fill areas using mask layers and placement rules.
- **Imagery:** Paint masks and satellite images.
- **Shapes and roads:** Create and edit shapes, splines, and roads. Import and export SHP files.
- **Projects:** Save and reopen your work, including terrain data, imagery, masks, objects, and settings.
- **Export:** Generate terrain tiles, RVMAT files, and a WRP for Arma 3.

## Command-line tools

### `wrpdump`

Inspect a WRP, export its heightmap to ASC, compare heightmaps, or test a WRP round trip.

Example:

```powershell
target\release\wrpdump.exe tests\fixtures\bro_range\bro_range.wrp --asc out.asc
```

### `tilegen`

Generate terrain tiles and RVMAT files from a project JSON file.

Check the project configuration:

```powershell
target\release\tilegen.exe project.json --check
```

Generate the files:

```powershell
target\release\tilegen.exe project.json --wrp map.wrp --wrp-out new.wrp
```

See `tests\fixtures\bro_msi\project.example.json` for an example configuration.

## Export to Arma 3

1. Open or create a terrain project.
2. Configure the heightmap, satellite image, mask, and model folders.
3. Use the Export tab to generate the terrain files.
4. Convert the required images to PAA using Arma 3 Tools.
5. Binarize the WRP and test the terrain in-game.

The work drive must be mounted, and the required game data and model paths must be available.

