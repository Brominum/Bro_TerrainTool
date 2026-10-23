// Main window: the ribbon (tabs in the order of the work: Heightmap & imagery, Objects, Shapes, Imagery, Export, Viewport),
// the 3D view or the 2D mask view, the property panel on the right (it shows the settings of the tab or the tool), and the status bar.
// The project file saves all work.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { cancelJob, demoTerrain, newTerrain, heightExport, heightOffset, heightStampLoad, layerDetail, resetState, dirExists, loadAsc, loadProject, loadWrp, maskExport, maskOpen, maskRegion, parseAsc, parseDds, parseMesh, parseObjects, parsePicture, projectHeights, projectSave, projectSaved, readBytes, readText, satExport, satOpen, satRegion, satTexture, writeBytes, writeText, type MaskInfo, type Objects, type Project, type SatTool, type Terrain } from "./data";
import { dataDir, join, storeFromBytes, storeToBytes, type ProjectFile } from "./project";
import { HeightBrush, type TerrainTool } from "./heightbrush";
import { Editor } from "./editor";
import { ObjectStore, storeFromWrp } from "./store";
import { ddsTexture, meshGeometry, ModelLibrary } from "./models";
import { ModelPanel, savedRoots } from "./ModelPanel";
import { FillPanel, type Recipe } from "./FillPanel";
import { ShapeEditor } from "./shapeview";
import { ScatterBrush } from "./scatter";
import { ShapesPanel } from "./ShapesPanel";
import { defaultSettings, GameExport, type GameSettings } from "./GameExport";
import type { FillSettings } from "./data";
import { Viewer, type Cursor } from "./viewer";
import { MaskView, type MaskCursor, type MaskTool } from "./maskview";
import { Paint3D } from "./paint3d";
import { Btn, Group, Icon, NumInput, RBtn, STAGES, Tool, type Stage } from "./ui";
import { DEFAULT_ENV, PRESETS, type Environment } from "./env";

// Largest satellite texture side in pixels on the 3D terrain. The tool reduces larger images (mean of the pixels).
const SAT_MAX = 4096;
const NO_ADJUST = { hue: 0, saturation: 0, lightness: 0, brightness: 0, contrast: 0 };
// Largest side of the mask texture on the 3D terrain.
const MASK_3D_MAX = 4096;
const inTauri = "__TAURI_INTERNALS__" in window;
const SAT_HELP: Record<SatTool, string> = {
	color: "Paint a color. Ctrl+click picks the color under the cursor.",
	clone: "Alt+click sets the source. Then paint: the brush copies from the source with the same offset.",
	smooth: "Blur the image under the brush",
	texture: "Paint a repeated texture (PNG, BMP, or PAA)",
};
const TERRAIN_HELP: Record<TerrainTool, string> = {
	raise: "Raise the terrain. Strength: meters for each dab at the centre.",
	lower: "Lower the terrain. Strength: meters for each dab at the centre.",
	smooth: "Smooth the terrain. Strength: 0 to 1.",
	flatten: "Flatten to a height. Ctrl+click picks the height. Strength: 0 to 1.",
	plane: "Flatten to a slope. Ctrl+click two points, then paint. Strength: 0 to 1.",
	noise: "Add noise. Strength: meters for each dab.",
	stamp: "Click to put a height image (PNG or BMP) on the terrain.",
};
// Autosave interval: 5 minutes.
const AUTOSAVE_MS = 5 * 60 * 1000;
const TERRAIN_ICON: Record<TerrainTool, string> = { raise: "arrow-up-line", lower: "arrow-down-line", smooth: "blur-off-line", flatten: "subtract-line", plane: "contrast-2-line", noise: "pulse-line", stamp: "hammer-line" };
const MASK_ICON: Record<MaskTool, string> = { brush: "brush-line", erase: "eraser-line", fill: "paint-line", polygon: "shape-line", lasso: "pen-nib-line" };
const SAT_ICON: Record<SatTool, string> = { color: "palette-line", clone: "file-copy-line", smooth: "drop-line", texture: "image-line" };
// Settings of this PC (not of the project).
const pref = (k: string, d: string) => {
	try {
		return localStorage.getItem(`terrainTool.${k}`) ?? d;
	} catch {
		return d;
	}
};
const setPref = (k: string, v: string) => {
	try {
		localStorage.setItem(`terrainTool.${k}`, v);
	} catch {
		// The setting is not kept.
	}
};
const TOOL_HELP: Record<MaskTool, string> = {
	brush: "Paint the selected layer",
	erase: "Paint the pixels of the imported mask again",
	fill: "Fill the connected area of one color with the selected layer",
	polygon: "Click the points, then double-click or press Enter. The polygon gets the selected layer.",
	lasso: "Drag around an area. The area gets the selected layer.",
};

export function App() {
	const canvas = useRef<HTMLCanvasElement>(null);
	const viewer = useRef<Viewer>(null);
	const editor = useRef<Editor>(null);
	// Counter that makes React draw the editor state again.
	const [, setTick] = useState(0);
	const [relative, setRelative] = useState(true);
	const [terrain, setTerrain] = useState<Terrain>();
	const [cursor, setCursor] = useState<Cursor | null>(null);
	const [stats, setStats] = useState({ fps: 0, tris: 0, drawn: 0 });
	const [busy, setBusy] = useState("");
	const busyOrNo = !inTauri || !!busy;
	const [error, setError] = useState("");
	const [showObjects, setShowObjects] = useState(true);
	// Object draw distance in meters (10 to 10000), kept for the next start. All objects show up to it (a hard cut).
	const [drawDist, setDrawDist] = useState(() => Number(localStorage.getItem("terrainTool.drawDistance")) || 2500);
	const setDrawDistance = (v: number) => setDrawDist(Math.min(10000, Math.max(10, Math.round(v))));
	useEffect(() => {
		viewer.current?.setDrawDistance(drawDist);
		localStorage.setItem("terrainTool.drawDistance", String(drawDist));
	}, [drawDist]);
	const [library, setLibrary] = useState<ModelLibrary>();
	// Model in the preview of the model panel. The fill panel can add it to the recipe.
	const [shown, setShown] = useState<string>();
	// The selected models of the model panel (Shift or Ctrl+click), for the recipe.
	const [picked, setPicked] = useState<string[]>([]);
	// Layer with an open name field.
	const [renaming, setRenaming] = useState<number | null>(null);
	const maskCanvas = useRef<HTMLCanvasElement>(null);
	const maskView = useRef<MaskView>(null);
	const tbProject = useRef<Project>(null);
	const [view, setView] = useState<"3d" | "terrain" | "shapes" | "mask">("3d");
	const [stage, setStage] = useState<Stage>("terrain");
	// Imagery tab: the 2D painter, or the 3D view with the mask and satellite on the terrain.
	const [surface2d, setSurface2d] = useState(true);
	// Distance of "Clear objects" near the selected shapes (Shapes tab).
	const [clearDist, setClearDist] = useState(5);
	// F5 and Ctrl+R load the page again in WebView2, which closes the open map without a question. They do nothing in the tool.
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) e.preventDefault();
		};
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, []);
	// The tool needs the work drive P: (Arma 3 Tools: "Mount the Project Drive"): the game paths of models and textures start at its root.
	useEffect(() => {
		if (inTauri) dirExists("P:\\").then((ok) => ok || setError("The work drive P: is not mounted. Mount it with the Arma 3 Tools (Mount the Project Drive), then start the tool again. The game paths of models and textures need it."), () => {});
	}, []);
	// Height of the viewport panel and the status bar, so that the model preview stays above them.
	const belowView = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = belowView.current;
		if (!el) return;
		const set = () => document.documentElement.style.setProperty("--below-view", `${el.offsetHeight + ((el.nextElementSibling as HTMLElement | null)?.offsetHeight ?? 0)}px`);
		const ro = new ResizeObserver(set);
		ro.observe(el);
		if (el.nextElementSibling) ro.observe(el.nextElementSibling);
		return () => ro.disconnect();
	}, []);
	// The viewport panel at the bottom is open or folded (kept for the next start).
	const [vpOpen, setVpOpen] = useState(() => pref("vpOpen", "0") === "1");
	useEffect(() => setPref("vpOpen", vpOpen ? "1" : "0"), [vpOpen]);
	// The Imagery tab in the 3D view paints in 3D.
	useEffect(() => {
		if (paint3d.current) paint3d.current.enabled = stage === "imagery" && !surface2d;
	}, [stage, surface2d]);
	const [right, setRight] = useState(() => pref("rightPanel", "1") === "1");
	const [left, setLeft] = useState(() => pref("leftPanel", "1") === "1");
	// The page of the browser (left panel) in the Objects and Shapes tabs.
	const [objBrowse, setObjBrowse] = useState<"models" | "layers">("models");
	const [shapeBrowse, setShapeBrowse] = useState<"shapes" | "models">("shapes");
	const [theme, setTheme] = useState(() => pref("theme", "dark"));
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		setPref("theme", theme);
	}, [theme]);
	// Viewport: time of day, shadows, and fog. The tool keeps them for the next start.
	const [env, setEnv] = useState<Environment>(() => {
		try {
			// The tool always starts at 9:00. A setting from before 23 Oct 2026 (it has "filmic") had another sunlight scale, so its sunlight goes.
			const saved = JSON.parse(pref("viewport", "{}"));
			if ("filmic" in saved) {
				delete saved.filmic;
				delete saved.sun;
			}
			return { ...DEFAULT_ENV, ...saved, hour: DEFAULT_ENV.hour };
		} catch {
			return DEFAULT_ENV;
		}
	});
	useEffect(() => {
		viewer.current?.setEnvironment(env);
		setPref("viewport", JSON.stringify(env));
	}, [env]);
	// New map: square grid, cell size, the corner (TB needs 200000, 0), and the height.
	const [newMap, setNewMap] = useState({ cells: 4096, cell: 4, x: 200000, y: 0, height: 0 });
	const heights = useRef<HeightBrush>(null);
	const shapeEd = useRef<ShapeEditor>(null);
	const scatter = useRef<ScatterBrush>(null);
	const paint3d = useRef<Paint3D>(null);
	// The recipe of the fill panel (the panel sets the function).
	const recipe = useRef<() => Recipe>(() => ({ settings: {} as FillSettings, models: [], avoid: false }));
	const [lastTool, setLastTool] = useState<TerrainTool>("raise");
	// Decimals of the ASC export. Empty: as in the source.
	const [decimals, setDecimals] = useState("");
	// Project file: path, the change count at the last save and autosave, and changes outside the editor and the 2D view (opened files).
	const projectPath = useRef<string>(null);
	const [projectName, setProjectName] = useState<string>();
	const opened = useRef(0);
	const savedAt = useRef(0);
	const autosavedAt = useRef(0);
	const saving = useRef(false);
	// The open files that the project saves.
	const cfgPath = useRef<string>(null);
	// Layer of each palette color for the ground detail textures (255: no texture), or null without ground detail.
	const paletteLayer = useRef<Uint8Array | null>(null);
	const layerIds = (ids: Uint8Array) => {
		const p = paletteLayer.current!;
		return ids.map((v) => (v < p.length ? p[v] : 255));
	};
	const coreHeights = useRef(false);
	const [scanRequest, setScanRequest] = useState<string[]>();
	const changes = () => (editor.current?.version ?? 0) + (maskView.current?.version ?? 0) + opened.current;
	const [mask, setMask] = useState<MaskInfo>();
	// Settings of "Export for game" (null: not set yet, the dialog makes them from the TB project). The project file keeps them.
	const [game, setGame] = useState<GameSettings | null>(null);
	// Progress of a long job in the core (0 to 1). 1: no job.
	const [progress, setProgress] = useState(1);
	useEffect(() => {
		if (!inTauri) return;
		const off = listen<number>("progress", (e) => setProgress(e.payload));
		return () => void off.then((f) => f());
	}, []);
	const [maskCursor, setMaskCursor] = useState<MaskCursor | null>(null);
	// What the 3D terrain shows: the satellite image, the mask, or the mask over the satellite image (with the overlay opacity).
	const [ground, setGround] = useState<"sat" | "mask" | "both">("sat");
	const mask3d = ground !== "sat";
	useEffect(() => {
		const mv = new MaskView(maskCanvas.current!);
		maskView.current = mv;
		mv.onCursor = setMaskCursor;
		mv.onError = setError;
		mv.onKey = () => setTick((n) => n + 1);
		mv.onChange = () => setTick((n) => n + 1);
	}, []);
	useEffect(() => {
		const v = new Viewer(canvas.current!);
		viewer.current = v;
		v.setDrawDistance(drawDist);
		v.setEnvironment(env);
		v.onCursor = setCursor;
		v.onStats = (fps, tris, drawn) => setStats({ fps, tris, drawn });
		const ed = new Editor(v, canvas.current!);
		editor.current = ed;
		ed.onState = () => setTick((n) => n + 1);
		const hb = new HeightBrush(v, ed, canvas.current!);
		heights.current = hb;
		hb.onChange = () => setTick((n) => n + 1);
		hb.onError = setError;
		const se = new ShapeEditor(v, ed, canvas.current!);
		shapeEd.current = se;
		se.onChange = () => setTick((n) => n + 1);
		// F moves the camera to the selected shape (in the Shapes tab) or to the selected objects.
		canvas.current!.addEventListener("keydown", (e) => {
			if (e.code !== "KeyF" || e.ctrlKey || e.altKey || e.metaKey) return;
			if (!(se.enabled && se.focus())) ed.focus();
		});
		se.onError = setError;
		const mv = maskView.current!;
		paint3d.current = new Paint3D(v, mv, canvas.current!);
		// The 2D view and the 3D camera: meters for each image pixel, and row 0 of the image is the north edge.
		const metersPerPx = () => {
			const z = mv.size();
			return v.terrain && z ? (v.terrain.ncols * v.terrain.cell) / z.width : 0;
		};
		mv.onCamera = (p) => {
			const k = metersPerPx();
			if (k) v.teleport(p[0] * k, v.terrain!.nrows * v.terrain!.cell - p[1] * k);
		};
		mv.cameraPose = () => {
			const k = metersPerPx();
			if (!k) return null;
			const c = v.pose();
			return { x: c.x / k, y: (v.terrain!.nrows * v.terrain!.cell - c.y) / k, yaw: c.yaw };
		};
		// A change of the mask or the satellite image: load the changed part of the 3D drape again (only while the 3D view shows).
		mv.onPainted = (target, r) => {
			const z = target === "sat" ? mv.sat : mv.info;
			if (v.paused || !z) return;
			let l = 0;
			while (Math.max(z.width, z.height) >> l > (target === "sat" ? SAT_MAX : MASK_3D_MAX)) l++;
			const k = 2 ** l;
			const [x, y] = [Math.floor(r[0] / k), Math.floor(r[1] / k)];
			const [w, h] = [Math.ceil(r[2] / k) - x, Math.ceil(r[3] / k) - y];
			const rgba =
				target === "sat"
					? satRegion(l, x, y, w, h)
					: maskRegion(l, x, y, w, h).then((ids) => {
							if (paletteLayer.current) v.setDetailIds(w, h, layerIds(ids), x, y);
							return new Uint8Array(mv.rgba(ids).buffer);
						});
			rgba.then((p) => v.patchDrape(target, x, y, w, h, p), (e) => setError(String(e)));
		};
		const sb = new ScatterBrush(v, ed, canvas.current!, recipe);
		scatter.current = sb;
		sb.onChange = () => setTick((n) => n + 1);
		sb.onError = setError;
		// Test hook: ?demo=4096 loads a synthetic 4096 x 4096 terrain.
		const demo = new URLSearchParams(location.search).get("demo");
		if (demo) {
			const t = demoTerrain(Number(demo), 4);
			v.setTerrain(t);
			setTerrain(t);
		}
		// Test hook for scripts in a browser without Tauri.
		Object.assign(window, { terrainTool: { shapes: se, scatter: sb, heights: hb, maskView: maskView.current, viewer: v, parseAsc, parsePicture, parseObjects, setTerrain, editor: ed, ObjectStore, storeFromWrp, ModelLibrary, parseMesh, parseDds, meshGeometry, ddsTexture, THREE } });
	}, []);
	// A new model library: show all objects again with the models.
	useEffect(() => {
		if (library) editor.current!.setLibrary(library);
	}, [library]);
	const showObjects_ = async (o: Objects, name: string) => {
		const ed = editor.current!;
		await ed.setStore(storeFromWrp(o, name));
		const failed = viewer.current!.failed;
		if (failed.length) setError(`${failed.length} models did not load (red boxes). First: ${failed[0].name}: ${failed[0].error}`);
	};
	const importText = () =>
		run("Importing objects", [{ name: "Object text", extensions: ["txt"] }], async (p) => {
			const name = p.split(/[\\/]/).pop()!.replace(/\.txt$/i, "");
			const errors = await editor.current!.importText(await readText(p), name, relative);
			if (errors.length) setError(`${errors.length} lines not read. First: ${errors[0]}`);
		});
	const exportText = async (layer: number) => {
		const ed = editor.current!;
		const path = await save({ defaultPath: `${ed.store.layers[layer].name}.txt`, filters: [{ name: "Object text", extensions: ["txt"] }] });
		if (!path) return;
		try {
			await writeText(path, await ed.exportText([layer], relative));
		} catch (e) {
			setError(String(e));
		}
	};
	const run = async (label: string, filters: { name: string; extensions: string[] }[], job: (path: string) => Promise<void>) => {
		const path = await open({ multiple: false, directory: false, filters });
		if (typeof path !== "string") return;
		setBusy(label);
		setError("");
		try {
			await job(path);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	// A heightmap from the core (ASC, WRP, TB project, or project file).
	const useTerrain = (t: Terrain) => {
		viewer.current!.setTerrain(t);
		setTerrain(t);
		coreHeights.current = true;
		opened.current++;
	};
	// A Terragen file (.ter) has no map position. It gets the TB corner 200000, 0.
	const openAsc = () => run("Loading heightmap", [{ name: "Heightmap (ASC, Terragen)", extensions: ["asc", "ter"] }], async (p) => useTerrain(await loadAsc(p)));
	const createMap = async () => {
		if (terrain && !(await ask("Replace the open heightmap with a new flat map?", { title: "New map", kind: "warning" }))) return;
		setBusy("Making the map");
		setError("");
		try {
			const m = newMap;
			useTerrain(await newTerrain(m.cells, m.cells, m.cell, m.x, m.y, m.height));
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	const exportAsc = async () => {
		const path = await save({ defaultPath: "heightmap.asc", filters: [{ name: "ASC heightmap", extensions: ["asc"] }] });
		if (!path) return;
		setBusy("Writing ASC");
		try {
			await heightExport(path, decimals.trim() === "" ? null : Math.max(0, Math.min(9, Math.round(Number(decimals)))));
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	// Raise or lower the whole heightmap (for example a DEM that cannot go below 0 m). One undo step.
	const [offsetDh, setOffsetDh] = useState(0);
	const applyOffset = async () => {
		const hb = heights.current;
		if (!hb || !offsetDh) return;
		setBusy("Moving the heights");
		try {
			const base = hb.base();
			const r = await heightOffset(offsetDh);
			if (r) await hb.finish(r, base);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	const loadStamp = async () => {
		const p = await open({ title: "Select the stamp image", multiple: false, directory: false, filters: [{ name: "Height image", extensions: ["png", "bmp"] }] });
		if (typeof p !== "string") return;
		try {
			const [w, h] = await heightStampLoad(p);
			heights.current!.stamp.loaded = `${p.split(/[\\/]/).pop()} (${w} x ${h})`;
			setTick((n) => n + 1);
		} catch (e) {
			setError(String(e));
		}
	};
	// Write the project: the images (only the changed ones), the objects, then the project file.
	const writeProject = async (path: string) => {
		const dir = dataDir(path);
		const ed = editor.current!;
		const st = ed.store;
		await projectSave(dir);
		const { bin, raw } = storeToBytes(st);
		await writeBytes(join(dir, "objects.bin"), bin);
		await writeBytes(join(dir, "objects_raw.txt"), raw);
		const p: ProjectFile = {
			format: "terrain-tool-project",
			version: 1,
			files: { mask: !!mask, satellite: !!sat, heights: coreHeights.current },
			layersCfg: cfgPath.current ?? undefined,
			modelRoots: savedRoots(),
			models: st.models,
			layers: st.layers,
			order: st.order,
			fills: st.fills,
			shapes: st.shapes,
			roadsLib: shapeEd.current!.roadsPath || undefined,
			gameExport: game ?? undefined,
			activeLayer: ed.activeLayer,
			settings: { relative, ground, overlay: maskView.current!.overlay, decimals },
		};
		await writeBytes(path, new TextEncoder().encode(JSON.stringify(p, null, "\t")));
	};
	const saveProject = async (as: boolean) => {
		let path = projectPath.current;
		if (as || !path) {
			path = await save({ defaultPath: projectName ? `${projectName}.ttproj` : "terrain.ttproj", filters: [{ name: "Terrain Tool project", extensions: ["ttproj"] }] });
			if (!path) return;
		}
		if (saving.current) return;
		saving.current = true;
		setBusy("Saving project");
		setError("");
		try {
			const n = changes();
			await writeProject(path);
			projectPath.current = path;
			addRecent(path);
			setProjectName(path.split(/[\\/]/).pop()!.replace(/\.ttproj$/i, ""));
			savedAt.current = n;
		} catch (e) {
			setError(`The project is not saved: ${e}`);
		} finally {
			saving.current = false;
			setBusy("");
		}
	};
	// Ask before the work that is not saved is lost.
	// "New map": close everything and start again, as after a new start of the tool (the settings and the model folders stay).
	const startOver = async () => {
		const open = !!terrain || !!mask || !!sat || !!editor.current?.store.count || !!editor.current?.store.shapes.length;
		if (open) {
			const unsaved = changes() !== savedAt.current ? " Changes that are not saved are lost." : "";
			if (!(await ask(`Close the open map and start again?${unsaved}`, { title: "New map", kind: "warning" }))) return;
		}
		await resetState();
		location.reload();
	};
	const mayDiscard = async () => changes() === savedAt.current || (await ask("There are changes that are not saved. Continue without saving?", { title: "Terrain Tool", kind: "warning" }));
	// The 5 last opened or saved project files, newest first (kept for the next start).
	const [recent, setRecent] = useState<string[]>(() => {
		try {
			return JSON.parse(pref("recent", "[]"));
		} catch {
			return [];
		}
	});
	const addRecent = (path: string) => {
		const list = [path, ...recent.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 5);
		setRecent(list);
		setPref("recent", JSON.stringify(list));
	};
	// Open a project: the given file (recent list), else a file dialog.
	const openProjectFile = async (given?: string) => {
		if (!(await mayDiscard())) return;
		const path = given ?? (await open({ multiple: false, directory: false, filters: [{ name: "Terrain Tool project", extensions: ["ttproj"] }] }));
		if (typeof path !== "string") return;
		setBusy("Opening project");
		setError("");
		try {
			const p = JSON.parse(new TextDecoder().decode(await readBytes(path))) as ProjectFile;
			if (p.format !== "terrain-tool-project") throw `${path} is not a Terrain Tool project`;
			const dir = dataDir(path);
			if (p.files.heights) useTerrain(await projectHeights(dir));
			if (p.files.satellite) await loadSat(join(dir, "satellite.png"));
			if (p.files.mask) {
				let cfg = p.layersCfg;
				let info: MaskInfo | undefined;
				for (;;) {
					try {
						if (!cfg) throw "the project has no layers.cfg path";
						info = await maskOpen(join(dir, "mask.png"), cfg);
						break;
					} catch (e) {
						setError(`${e}. Select the layers.cfg of the project.`);
						const c = await open({ title: "Select layers.cfg", multiple: false, directory: false, filters: [{ name: "layers.cfg", extensions: ["cfg"] }] });
						if (typeof c !== "string") throw e;
						cfg = c;
					}
				}
				cfgPath.current = cfg;
				setMask(info);
				maskView.current!.setMask(info);
			}
			const store = storeFromBytes(p, await readBytes(join(dir, "objects.bin")), await readBytes(join(dir, "objects_raw.txt")));
			const ed = editor.current!;
			await ed.setStore(store);
			shapeEd.current!.selected = null;
			if (p.roadsLib) await shapeEd.current!.loadRoads(p.roadsLib).catch((e) => setError(`RoadsLib.cfg: ${e}`));
			shapeEd.current!.draw();
			ed.activeLayer = store.layers[p.activeLayer] && !store.layers[p.activeLayer].deleted ? p.activeLayer : (store.shown()[0] ?? 0);
			const set = p.settings ?? {};
			if (typeof set.relative === "boolean") setRelative(set.relative);
			if (typeof set.mask3d === "boolean") setGround(set.mask3d ? "both" : "sat");
			if (set.ground === "sat" || set.ground === "mask" || set.ground === "both") setGround(set.ground);
			if (typeof set.overlay === "number") maskView.current!.overlay = set.overlay;
			if (typeof set.decimals === "string") setDecimals(set.decimals);
			if (p.modelRoots?.length) setScanRequest(p.modelRoots);
			setGame(p.gameExport ? { ...defaultSettings(null), ...p.gameExport } : null);
			await projectSaved(dir);
			projectPath.current = path;
			setProjectName(path.split(/[\\/]/).pop()!.replace(/\.ttproj$/i, ""));
			savedAt.current = autosavedAt.current = changes();
			addRecent(path);
			goStage("objects");
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	// The newest functions for the timer, the keys, and the close question, which keep one function from the first render.
	const live = useRef({ saveProject, autosave: async () => {}, mayDiscard });
	live.current = {
		saveProject,
		mayDiscard,
		// Autosave to <name>.autosave.ttproj (the project file of the user stays as it is). Only after the first save, and only with new changes.
		autosave: async () => {
			const path = projectPath.current;
			const n = changes();
			if (!path || saving.current || n === savedAt.current || n === autosavedAt.current) return;
			saving.current = true;
			try {
				await writeProject(path.replace(/\.ttproj$/i, "") + ".autosave.ttproj");
				autosavedAt.current = n;
			} catch (e) {
				setError(`Autosave: ${e}`);
			} finally {
				saving.current = false;
			}
		},
	};
	useEffect(() => {
		if (!inTauri) return;
		const timer = setInterval(() => live.current.autosave(), AUTOSAVE_MS);
		const key = (e: KeyboardEvent) => {
			if (e.ctrlKey && e.code === "KeyS") {
				e.preventDefault();
				live.current.saveProject(e.shiftKey);
			}
		};
		window.addEventListener("keydown", key);
		const close = getCurrentWindow().onCloseRequested(async (e) => {
			if (!(await live.current.mayDiscard())) e.preventDefault();
		});
		return () => {
			clearInterval(timer);
			window.removeEventListener("keydown", key);
			close.then((f) => f());
		};
	}, []);
	// The window title shows the project name and * for changes that are not saved.
	const title = `${projectName ?? "Untitled"}${changes() !== savedAt.current ? " *" : ""} - Terrain Tool ${__APP_VERSION__}`;
	const lastTitle = useRef("");
	useEffect(() => {
		if (title === lastTitle.current) return;
		lastTitle.current = title;
		document.title = title;
		if (inTauri) getCurrentWindow().setTitle(title).catch(() => {});
	});
	// Size of the open satellite image.
	const [sat, setSat] = useState<{ width: number; height: number }>();
	const [texture, setTexture] = useState<{ path: string; size: number; info: string }>();
	// Show the satellite image of the core on the 3D terrain.
	const satTo3d = async (z = sat) => {
		if (!z) return;
		let l = 0;
		while (Math.max(z.width, z.height) >> l > SAT_MAX) l++;
		const [w, h] = [Math.ceil(z.width / 2 ** l), Math.ceil(z.height / 2 ** l)];
		viewer.current!.setSatellite({ width: w, height: h, rgba: await satRegion(l, 0, 0, w, h) });
	};
	const loadSat = async (path: string) => {
		const z = await satOpen(path);
		opened.current++;
		setSat(z);
		// The core forgets the texture of the old image.
		setTexture(undefined);
		maskView.current!.setSatellite(z);
		await satTo3d(z);
	};
	const openSat = () => run("Loading satellite image", [{ name: "Image", extensions: ["png", "bmp"] }], loadSat);
	const exportSat = async () => {
		const path = await save({ defaultPath: "satellite.png", filters: [{ name: "PNG", extensions: ["png"] }] });
		if (!path) return;
		setBusy("Writing satellite image");
		try {
			await satExport(path);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	// Color change of the whole satellite image: hue in degrees, the others in percent (-100 to 100).
	const [adj, setAdj] = useState(NO_ADJUST);
	const applyAdjust = async () => {
		setBusy("Changing the satellite image");
		try {
			await maskView.current!.adjustSat({ hue: adj.hue, saturation: adj.saturation / 100, lightness: adj.lightness / 100, brightness: adj.brightness / 100, contrast: adj.contrast / 100 });
		} finally {
			setBusy("");
		}
	};
	const loadTexture = async (path: string, size: number) => {
		try {
			const [w, h] = await satTexture(path, size);
			setTexture({ path, size, info: `${path.split(/[\\/]/).pop()} (${w} x ${h})` });
		} catch (e) {
			setError(String(e));
		}
	};
	const openTexture = async () => {
		const p = await open({ title: "Select the texture", multiple: false, directory: false, filters: [{ name: "Texture", extensions: ["png", "bmp", "paa"] }] });
		if (typeof p === "string") await loadTexture(p, texture?.size ?? 64);
	};
	// The mask needs layers.cfg for the palette. A TB project gives both files. If a file is missing or does not load, the user selects it.
	const openMask = async () => {
		const pick = async (title: string, name: string, extensions: string[]) => {
			const f = await open({ title, multiple: false, directory: false, filters: [{ name, extensions }] });
			return typeof f === "string" ? f : undefined;
		};
		const pickCfg = () => pick("Select layers.cfg", "layers.cfg", ["cfg"]);
		const pickMask = () => pick("Select the source mask", "Mask image", ["png", "bmp"]);
		let cfg = tbProject.current?.layersCfg || (await pickCfg());
		if (!cfg) return;
		let path = tbProject.current?.mask || (await pickMask());
		if (!path) return;
		setBusy("Loading mask");
		setError("");
		try {
			let info;
			for (;;) {
				try {
					info = await maskOpen(path, cfg);
					break;
				} catch (e) {
					const err = String(e);
					// The core starts each error with the path of the file that failed.
					const badCfg = err.startsWith(cfg);
					setError(`${err}. Select the ${badCfg ? "layers.cfg" : "mask"} file.`);
					const next = await (badCfg ? pickCfg() : pickMask());
					if (!next) return;
					if (badCfg) cfg = next;
					else path = next;
				}
			}
			setMask(info);
			maskView.current!.setMask(info);
			cfgPath.current = cfg;
			opened.current++;
			const notes = [...info.warnings.map((w) => `layers.cfg: ${w}`)];
			if (info.inexact) notes.push(`${info.inexact} pixels were not an exact palette color. They got the nearest color.`);
			setError(notes.join(" "));
		} finally {
			setBusy("");
		}
	};
	const exportMask = async () => {
		const path = await save({ defaultPath: "mask.png", filters: [{ name: "PNG", extensions: ["png"] }] });
		if (!path) return;
		setBusy("Writing mask");
		try {
			await maskExport(path);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy("");
		}
	};
	// Show the mask on the 3D terrain. The tool reads it again each time, because the mask can change in the 2D view.
	// The mask texels also give the layers of the ground detail textures.
	const update3d = async (on: boolean) => {
		const mv = maskView.current!;
		if (!mask) {
			viewer.current!.setMaskOverlay(null, 0);
			return;
		}
		let l = 0;
		while (Math.max(mask.width, mask.height) >> l > MASK_3D_MAX) l++;
		const [w, h] = [Math.ceil(mask.width / 2 ** l), Math.ceil(mask.height / 2 ** l)];
		const ids = await maskRegion(l, 0, 0, w, h);
		if (paletteLayer.current) viewer.current!.setDetailIds(w, h, layerIds(ids));
		if (!on) {
			viewer.current!.setMaskOverlay(null, 0);
			return;
		}
		viewer.current!.setMaskOverlay({ width: w, height: h, rgba: new Uint8Array(mv.rgba(ids).buffer) }, ground === "mask" ? 1 : mv.overlay);
	};
	// Ground detail textures: the layer RVMAT files of layers.cfg give the _co textures (found in the model folders) and the repeat.
	// The texture covers (texture layer size / repeat) meters, with the diffuse and repeat of the first layer (as the game export).
	const layerSize = (game ?? defaultSettings(tbProject.current)).layerSize || 64;
	useEffect(() => {
		const v = viewer.current;
		if (!v) return;
		paletteLayer.current = null;
		v.setDetail(null);
		v.setClutter(null);
		const cfg = cfgPath.current;
		if (!mask || !library || !cfg) return;
		(async () => {
			const d = await layerDetail(cfg);
			const textures = await Promise.all(
				d.co.map(async (co, i) => {
					const t = co && i < 10 ? await library.texture(co) : null;
					return typeof t === "string" ? null : t;
				}),
			);
			paletteLayer.current = Uint8Array.from(d.palette, (l) => (textures[l] ? l : 255));
			const mid = await library.texture(d.mid);
			if (typeof mid === "string") d.missing.push(`mid detail: ${d.mid} (${mid})`);
			v.setDetail({ textures, scale: d.repeat / layerSize, diffuse: d.diffuse, mid: typeof mid === "string" ? null : mid });
			v.setClutter(d.clutter, library);
			await update3d(mask3d);
			if (d.missing.length) setError(`Ground detail without: ${d.missing.join(", ")}`);
		})().catch((e) => setError(String(e)));
	}, [mask, library, layerSize]);
	// A new choice shows at once in the 3D view (the 2D painter updates the 3D view when it closes).
	useEffect(() => {
		if (maskView.current) update3d(mask3d).catch((e) => setError(String(e)));
	}, [ground, mask]);
	// Go to a tab. Heightmap tab: the terrain brushes when one is selected. Only the Objects tab gives the left mouse button to the object editor.
	const goStage = (s: Stage, flat = surface2d, brush = heights.current?.tool ?? null) => {
		setStage(s);
		showView(s === "terrain" && brush ? "terrain" : s === "shapes" ? "shapes" : s === "imagery" && flat ? "mask" : "3d", s === "objects", brush);
	};
	// Select a terrain brush, or none (a second click on the brush).
	const pickBrush = (t: TerrainTool | null) => {
		if (t) setLastTool(t);
		goStage("terrain", surface2d, t);
	};
	const showView = (v: "3d" | "terrain" | "shapes" | "mask", objects = true, brush: TerrainTool | null = lastTool) => {
		if (view === "mask" && v !== "mask") Promise.all([update3d(mask3d), satTo3d()]).catch((e) => setError(String(e)));
		setView(v);
		viewer.current!.paused = v === "mask";
		heights.current!.setTool(v === "terrain" ? brush : null);
		if (v !== "3d" || !objects) scatter.current!.setEnabled(false);
		shapeEd.current!.setEnabled(v === "shapes");
		// Only the object view (without the scatter brush) gives the left mouse button to the object editor.
		editor.current!.enabled = v === "3d" && objects && !scatter.current!.enabled;
		if (v === "mask") requestAnimationFrame(() => maskView.current!.redraw());
	};
	const openWrp = () =>
		run("Loading WRP", [{ name: "WRP", extensions: ["wrp"] }], async (p) => {
			const { terrain: t, objects: o } = await loadWrp(p);
			useTerrain(t);
			await showObjects_(o, p.split(/[\\/]/).pop()!);
		});
	// TB project: the heightmap and the satellite image from the project, and the objects from the exported WRP.
	// shortcut: the objects in the TB layers (.tv4l) are not read yet. They come from the exported WRP.
	const openTv4p = () =>
		run("Loading TB project", [{ name: "Terrain Builder project", extensions: ["tv4p"] }], async (p) => {
			const project = await loadProject(p);
			tbProject.current = project;
			if (!project.heightmap) throw `the project ${project.name} has no imported ASC heightmap`;
			useTerrain(await loadAsc(project.heightmap));
			if (project.satellite) await loadSat(project.satellite);
			if (!project.wrp) {
				setError(`No objects: ${project.wrpFolder}\\${project.name}.wrp does not exist`);
				return;
			}
			const { objects: o } = await loadWrp(project.wrp);
			await showObjects_(o, `${project.name}.wrp`);
		});
	const ed = editor.current;
	const st = ed?.store;
	const mv = maskView.current;
	const setMv = (change: Partial<Pick<MaskView, "tool" | "color" | "radius" | "hardness" | "opacity" | "overlay" | "target" | "satTool" | "rgb" | "polyErase">>) => {
		Object.assign(mv!, change);
		mv!.redraw();
		setTick((n) => n + 1);
	};
	const pickLayer = (i: number) => {
		ed!.activeLayer = i;
		setTick((n) => n + 1);
	};
	// Layer changes that are not in the undo list still count as changes for the project file.
	const layerEdit = () => {
		ed!.version++;
		setTick((n) => n + 1);
	};
	const rename = (i: number, name: string) => {
		if (name.trim() && name.trim() !== st!.layers[i].name) {
			st!.layers[i].name = name.trim();
			layerEdit();
		}
		setRenaming(null);
	};
	const layerChange = (i: number, change: { visible?: boolean; locked?: boolean }) => {
		Object.assign(st!.layers[i], change);
		layerEdit();
		// Hidden and locked objects cannot stay selected.
		ed!.select([...ed!.selection].filter((id) => st!.editable(id)));
	};
	// Ctrl+1 to Ctrl+5 select the tabs. The first tab works without a map.
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			const n = /^Digit([1-5])$/.exec(e.code);
			if (!n || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
			const s = STAGES[Number(n[1]) - 1].id;
			if (s !== "terrain" && !terrain) return;
			e.preventDefault();
			if (s === "export" && !game) setGame(defaultSettings(tbProject.current));
			goStage(s);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	});
	useEffect(() => goStage("terrain", true, null), []);
	const hb = heights.current;
	const setHb = (change: Partial<HeightBrush>) => {
		Object.assign(hb!, change);
		setTick((n) => n + 1);
	};
	const sb = scatter.current;
	const num = (value: number, set: (v: number) => void, step = 1, min?: number) => <NumInput value={value} onChange={set} step={step} min={min} />;
	// Terrain stage: the brush settings in the left panel.
	const terrainPanel = hb && (
		<>
			<b>Brush: {hb.tool ? hb.tool[0].toUpperCase() + hb.tool.slice(1) : "none"}</b>
			{hb.tool && <div className="muted">{TERRAIN_HELP[hb.tool]}</div>}
			{hb.tool !== "stamp" && (
				<>
					<label className="field-row" title="Brush radius in meters">Radius m {num(hb.radius, (v) => setHb({ radius: Math.max(1, v) }), 5, 1)}</label>
					<label className="field-row" title={hb.tool ? TERRAIN_HELP[hb.tool] : ""}>Strength {num(hb.strength, (v) => setHb({ strength: Math.max(0, v) }), 0.05, 0)}</label>
					<label className="field-row" title="Part of the radius with full strength. The rest falls smoothly to 0.">Hardness <input type="range" min={0} max={1} step={0.05} value={hb.hardness} onChange={(e) => setHb({ hardness: Number(e.target.value) })} /></label>
				</>
			)}
			{hb.tool === "flatten" && <label className="field-row" title="Ctrl+click on the terrain picks the height">Height m {num(hb.flatten, (v) => setHb({ flatten: v }), 0.5)}</label>}
			{hb.tool === "plane" && <div className="muted">{hb.plane.length === 6 ? `Plane: ${hb.plane[2].toFixed(1)} m to ${hb.plane[5].toFixed(1)} m` : hb.plane.length === 3 ? "Ctrl+click the second point" : "Ctrl+click the first point"}</div>}
			{hb.tool === "noise" && <label className="field-row" title="Size of the noise in meters">Size m {num(hb.noiseSize, (v) => setHb({ noiseSize: Math.max(1, v) }), 5, 1)}</label>}
			{hb.tool === "stamp" && (
				<>
					<Btn icon="folder-open-line" onClick={loadStamp} title={hb.stamp.loaded || "Load a PNG or BMP height image (white is high)"}>{hb.stamp.loaded ? hb.stamp.loaded.split(/[\\/]/).pop() : "Load stamp"}</Btn>
					<label className="field-row" title="The stamp covers this many meters">Size m {num(hb.stamp.size, (v) => setHb({ stamp: { ...hb.stamp, size: Math.max(1, v) } }), 10, 1)}</label>
					<label className="field-row" title="Height in meters of a white pixel">Height m {num(hb.stamp.height, (v) => setHb({ stamp: { ...hb.stamp, height: v } }))}</label>
					<label title="Off: add the stamp to the terrain. On: raise the terrain to the stamp (measured from the height at the click point), never lower it."><input type="checkbox" checked={hb.stamp.max} onChange={(e) => setHb({ stamp: { ...hb.stamp, max: e.target.checked } })} />Raise only</label>
				</>
			)}
			<label title="Objects keep their height above the terrain when the terrain under them changes"><input type="checkbox" checked={hb.follow} onChange={(e) => setHb({ follow: e.target.checked })} />Objects follow the terrain</label>
			<b className="sub">ASC export</b>
			<label className="field-row" title="Decimal places of the changed rows. Empty: as in the source ASC. Rows without a change keep their original text.">Decimals <input type="number" min={0} max={9} placeholder="auto" value={decimals} onChange={(e) => setDecimals(e.target.value)} /></label>
			<Btn icon="file-download-line" disabled={!inTauri || !!busy || !coreHeights.current} onClick={exportAsc} title="Write the heightmap as an ASC with the header of the source">Export ASC</Btn>
		</>
	);
	// Imagery tab: the mask layers and the brush settings.
	// Imagery tab browser: the mask layers (the paint color of the mask brush).
	const maskBrowser = mv && (
		<>
			<b>Mask layers</b>
			{!mask && <div className="muted">Open a mask in the Heightmap & imagery tab.</div>}
			<div className="list mask-list">
				{mask?.colors.map((c, i) => (
					<div key={i} className={`row${mv.color === i ? " active" : ""}`} onClick={() => setMv({ color: i, tool: mv.tool === "erase" ? "brush" : mv.tool })} title={`Color ${c.join(", ")}`}>
						<span className="swatch" style={{ background: `rgb(${c.join(",")})` }} />
						<span className="name">{mask.names[i]}</span>
					</div>
				))}
			</div>
		</>
	);
	const surfacePanel = mv && (
		<>
			<b>Brush</b>
			{mv.target === "sat" && mv.satTool === "color" && (
				<label className="field-row" title="Brush color. Ctrl+click in the image picks a color.">Color <input type="color" value={`#${mv.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`} onChange={(e) => setMv({ rgb: [1, 3, 5].map((i) => parseInt(e.target.value.slice(i, i + 2), 16)) })} /></label>
			)}
			{mv.target === "sat" && sat && (
				<>
					<b className="sub">Whole image</b>
					<div className="muted">Brightness and contrast, then hue, saturation, and lightness, on all pixels. One undo step.</div>
					<label className="field-row" title="Turn all colors around the color wheel, -180 to 180 degrees">Hue ° <NumInput value={adj.hue} onChange={(v) => setAdj({ ...adj, hue: Math.max(-180, Math.min(180, v)) })} step={5} min={-180} max={180} /></label>
					{(["saturation", "lightness", "brightness", "contrast"] as const).map((k) => (
						<label key={k} className="field-row" title={`-100 to 100 %. 0: no change.`}>{k[0].toUpperCase() + k.slice(1)} % <NumInput value={adj[k]} onChange={(v) => setAdj({ ...adj, [k]: Math.max(-100, Math.min(100, v)) })} step={5} min={-100} max={100} /></label>
					))}
					<div className="row wrap">
						<Btn icon="contrast-drop-2-line" disabled={!!busy || Object.values(adj).every((v) => v === 0)} onClick={applyAdjust} title="Change the whole satellite image (Ctrl+Z gives it back)">Apply</Btn>
						<Btn icon="refresh-line" onClick={() => setAdj(NO_ADJUST)} title="Set all values to 0">Reset values</Btn>
					</div>
				</>
			)}
			{mv.target === "sat" && mv.satTool === "texture" && (
				<>
					<Btn icon="folder-open-line" disabled={!sat} onClick={openTexture} title={texture?.info ?? "Load a PNG, BMP, or PAA texture"}>{texture ? texture.path.split(/[\\/]/).pop() : "Load texture"}</Btn>
					<label className="field-row" title="One repeat of the texture covers this many pixels of the satellite image">Repeat px <input type="number" min={1} step={8} value={texture?.size ?? 64} onChange={(e) => texture && loadTexture(texture.path, Math.max(1, Math.round(Number(e.target.value) || 1)))} /></label>
				</>
			)}
			{mv.target === "mask" && (mv.tool === "polygon" || mv.tool === "lasso") && (
				<label title="On: the polygon or the lasso restores the imported mask inside the shape (the same as the eraser). Off: it paints the selected layer."><input type="checkbox" checked={mv.polyErase} onChange={(e) => setMv({ polyErase: e.target.checked })} />Erase inside</label>
			)}
			<label className="field-row" title="Brush radius in pixels. Keys [ and ].">Radius px <input type="number" min={0.5} step={1} value={Number(mv.radius.toFixed(1))} onChange={(e) => setMv({ radius: Math.max(0.5, Number(e.target.value) || 0.5) })} /></label>
			<label className="field-row" title="Part of the radius with full opacity. Mask: below 1, the edge is dithered, and each pixel keeps an exact palette color. Satellite: the edge blends.">Hardness <input type="range" min={0} max={1} step={0.05} value={mv.hardness} onChange={(e) => setMv({ hardness: Number(e.target.value) })} /></label>
			<label className="field-row" title="Mask: below 1, the brush sets only some pixels (dithered). Satellite: the strength of the blend. One stroke never goes above this value, except smooth.">Opacity <input type="range" min={0.05} max={1} step={0.05} value={mv.opacity} onChange={(e) => setMv({ opacity: Number(e.target.value) })} /></label>
			<b className="sub">View</b>
			<label className="field-row" title="Opacity of the mask over the satellite image">Mask overlay <input type="range" min={0} max={1} step={0.05} value={mv.overlay} onChange={(e) => setMv({ overlay: Number(e.target.value) })} /></label>
			<div className="muted">The ground switch at the top left of the 3D view selects the satellite image, the mask, or both.</div>
			<b className="sub">PNG export</b>
			<div className="row wrap">
				<Btn icon="file-download-line" disabled={!mask || !!busy} onClick={exportMask} title="Write the mask as one RGB PNG with the palette colors">Mask</Btn>
				<Btn icon="file-download-line" disabled={!sat || !!busy} onClick={exportSat} title="Write the satellite image as one 8-bit RGB PNG">Satellite</Btn>
			</div>
		</>
	);
	// Object list of the open layers: each model once, with the object IDs, sorted by name.
	const [openLayers, setOpenLayers] = useState<Set<number>>(new Set());
	const flip = <T,>(set: Set<T>, k: T) => {
		const n = new Set(set);
		if (!n.delete(k)) n.add(k);
		return n;
	};
	const layerModels = useMemo(() => {
		const out = new Map<number, [string, number[]][]>();
		if (!st || !openLayers.size) return out;
		const by = new Map<number, Map<number, number[]>>();
		for (const l of openLayers) by.set(l, new Map());
		for (const id of st.ids()) {
			const m = by.get(st.layer[id]);
			if (!m) continue;
			const k = st.model[id];
			(m.get(k) ?? m.set(k, []).get(k)!).push(id);
		}
		for (const [l, m] of by) out.set(l, [...m].map(([k, ids]): [string, number[]] => [st.models[k], ids]).sort((a, b) => a[0].localeCompare(b[0])));
		return out;
	}, [st, openLayers, ed?.version, st?.count]);
	const objectsPanel = st && ed && (
		<>
			<b>Layers</b>
			{st.shown().flatMap((i) => {
				const l = st.layers[i];
				return [
					<div key={i} className={`row${ed.activeLayer === i ? " active" : ""}`}>
						<button className="icon" title={openLayers.has(i) ? "Hide the model list" : "Show the models of the layer with their object counts"} onClick={() => setOpenLayers(flip(openLayers, i))}><Icon name={openLayers.has(i) ? "arrow-down-s-line" : "arrow-right-s-line"} /></button>
						<button className="icon" title={l.visible ? "Visible (click to hide)" : "Hidden (click to show)"} onClick={() => layerChange(i, { visible: !l.visible })}><Icon name={l.visible ? "eye-line" : "eye-off-line"} /></button>
						<button className="icon" title={l.locked ? "Locked (click to unlock)" : "Not locked (click to lock)"} onClick={() => layerChange(i, { locked: !l.locked })}><Icon name={l.locked ? "lock-line" : "lock-unlock-line"} /></button>
						{renaming === i ? (
							<input className="name" autoFocus defaultValue={l.name} onBlur={(e) => rename(i, e.target.value)} onKeyDown={(e) => {
								if (e.key === "Enter") rename(i, e.currentTarget.value);
								if (e.key === "Escape") setRenaming(null);
							}} />
						) : (
							<span className="name" title="Click: make this the active layer (new objects go into it). Double-click: rename." onClick={() => pickLayer(i)} onDoubleClick={() => setRenaming(i)}>{l.name}</span>
						)}
						<button className="icon" disabled={!inTauri} onClick={() => exportText(i)} title="Export the layer as object text"><Icon name="file-download-line" /></button>
					</div>,
					...(layerModels.has(i) ? [
						<div key={`m${i}`} className="model-scroll">
							{layerModels.get(i)!.map(([name, ids]) => (
								<div key={name} className="row model-row" title="Click: select all objects of this model in the layer" onClick={() => ed.select(ids)}>
									<span className="name">{name}</span>
									<span className="muted">({ids.length.toLocaleString()})</span>
								</div>
							))}
						</div>,
					] : []),
					...st.fills.flatMap((f, k) => (f.layer === i && !f.deleted && f.shape === undefined ? [
						<div key={`f${k}`} className="row fill-row">
							<span className="name" title="Objects of this fill">{f.name}</span>
							<button className="icon" onClick={() => ed.deleteFill(k)} title="Delete this fill and its objects. Other objects in the layer stay. Ctrl+Z gives them back."><Icon name="close-line" /></button>
						</div>,
					] : [])),
				];
			})}
			<div className="row wrap">
				<Tool icon="add-line" onClick={() => (pickLayer(st.addLayer(st.newLayerName())), layerEdit())} title="New layer" />
				<Tool icon="arrow-up-s-line" onClick={() => (st.move(ed.activeLayer, -1), layerEdit())} title="Move the active layer up" />
				<Tool icon="arrow-down-s-line" onClick={() => (st.move(ed.activeLayer, 1), layerEdit())} title="Move the active layer down" />
				<Tool icon="edit-line" onClick={() => setRenaming(ed.activeLayer)} title="Rename the active layer (or double-click its name)" />
				<Tool icon="delete-bin-line" disabled={st.shown().length < 2} onClick={() => ed.deleteLayer(ed.activeLayer)} title="Delete the active layer and its objects. Ctrl+Z gives them back." />
			</div>
		</>
	);
	const m = newMap;
	// Lowest and highest height (NODATA -9999 is not counted).
	const heightRange = useMemo(() => {
		if (!terrain) return null;
		let [lo, hi] = [Infinity, -Infinity];
		for (const h of terrain.heights) {
			if (h === -9999) continue;
			if (h < lo) lo = h;
			if (h > hi) hi = h;
		}
		return lo <= hi ? [lo, hi] : null;
	}, [terrain, ed?.version]);
	const projectPanel = (
		<>
			<b>New map</b>
			<div className="muted">A flat terrain. TB needs the map corner at 200000, 0.</div>
			<label className="field-row" title="Cells on each side (the map is square)">Grid cells {num(m.cells, (v) => setNewMap({ ...m, cells: Math.max(2, Math.round(v)) }), 256, 2)}</label>
			<label className="field-row" title="Size of one cell in meters">Cell size m {num(m.cell, (v) => setNewMap({ ...m, cell: Math.max(0.01, v) }), 0.5)}</label>
			<label className="field-row" title="Easting of the south-west corner (TB: 200000)">Corner X {num(m.x, (v) => setNewMap({ ...m, x: v }), 1000)}</label>
			<label className="field-row" title="Northing of the south-west corner (TB: 0)">Corner Y {num(m.y, (v) => setNewMap({ ...m, y: v }), 1000)}</label>
			<label className="field-row" title="Height of the flat terrain in meters">Height m {num(m.height, (v) => setNewMap({ ...m, height: v }))}</label>
			<div className="muted">Map size {(m.cells * m.cell).toLocaleString()} m</div>
			<Btn icon="file-add-line" disabled={!inTauri || !!busy} onClick={createMap}>Make the map</Btn>
			<b className="sub">Import</b>
			<Btn icon="landscape-line" disabled={!inTauri || !!busy} onClick={openAsc} title="Read a heightmap: ESRI ASCII grid (.asc) or Terragen (.ter, corner 200000, 0)">Import DEM (ASC, TER)</Btn>
			<Btn icon="folder-open-line" disabled={!inTauri || !!busy} onClick={openTv4p} title="Read a TB project: its heightmap, satellite image, and the objects of its exported WRP">Open TB project (TV4P)</Btn>
			<Btn icon="map-2-line" disabled={!inTauri || !!busy} onClick={openWrp} title="Read an editable WRP: the heights and the objects">Open WRP</Btn>
			{!!recent.length && <>
				<b className="sub">Recent projects</b>
				{recent.map((p) => (
					<Btn key={p} icon="history-line" disabled={busyOrNo} onClick={() => openProjectFile(p)} title={p}>{p.split(/[\\/]/).pop()}</Btn>
				))}
			</>}
			<b className="sub">Open map</b>
			<div className="muted">
				{terrain ? `Grid ${terrain.ncols} x ${terrain.nrows}, cell ${terrain.cell} m, size ${terrain.ncols * terrain.cell} m, corner ${terrain.xll}, ${terrain.yll}` : "No heightmap"}
				<br />
				{mask ? `Mask ${mask.width} x ${mask.height} px` : "No mask"}, {sat ? `satellite ${sat.width} x ${sat.height} px` : "no satellite"}
				<br />
				{st?.count ? `${st.count.toLocaleString()} objects in ${st.shown().length} layers` : "No objects"}
			</div>
			<b className="sub">Height offset</b>
			<div className="muted">{heightRange ? `Lowest ${heightRange[0].toFixed(2)} m, highest ${heightRange[1].toFixed(2)} m. Sea level is 0 m.` : "No heightmap"}</div>
			<label className="field-row" title="Meters to add to all heights. A negative value lowers the terrain.">Offset m {num(offsetDh, setOffsetDh, 1)}</label>
			<Btn icon="arrow-up-down-line" disabled={!inTauri || !!busy || !terrain || !offsetDh} onClick={applyOffset} title="Raise or lower the whole heightmap. This is one undo step. The objects follow when 'Objects follow the terrain' is on (brush settings).">Apply offset</Btn>
		</>
	);
	// Viewport settings: the panel at the bottom, in all tabs. It folds.
	const viewportGroups = (
		<>
			<Group label="Time of day">
				{PRESETS.map((p) => (
					<RBtn key={p.name} icon={p.icon} label={p.name} on={env.hour === p.hour} onClick={() => envSet({ hour: p.hour })} title={`${p.name}: ${String(Math.floor(p.hour)).padStart(2, "0")}:${String(Math.round((p.hour % 1) * 60)).padStart(2, "0")}`} />
				))}
				<div className="rcol">
					<label title="Hour of the day">Time {String(Math.floor(env.hour)).padStart(2, "0")}:{String(Math.round((env.hour % 1) * 60)).padStart(2, "0")}</label>
					<input type="range" min={0} max={24} step={0.25} value={env.hour} onChange={(e) => envSet({ hour: Number(e.target.value) })} />
				</div>
			</Group>
			<Group label="Camera">
				<RBtn icon="fullscreen-line" label="Reset" disabled={!terrain} onClick={() => viewer.current!.resetCamera()} title="Show the whole map (Home)" />
				<RBtn icon="map-2-line" label="Top-down" on={!!viewer.current?.ortho} onClick={() => (viewer.current!.setOrtho(!viewer.current!.ortho), setTick((n) => n + 1))} title="Orthographic view from above, with the heading of the 3D camera. W A S D or right drag: pan. Wheel: zoom. Click again for the normal view." />
			</Group>
			<Group label="Objects">
				<div className="rcol">
					<label title="Object draw distance in meters (10 to 10000). All objects show up to this distance, none after it. Higher values are slower.">Draw distance m <NumInput value={drawDist} onChange={setDrawDistance} step={100} min={10} max={10000} /></label>
					<input type="range" min={10} max={10000} step={10} value={drawDist} onChange={(e) => setDrawDistance(Number(e.target.value))} />
				</div>
			</Group>
			<Group label="Light">
				<RBtn icon="contrast-2-line" label="Shadows" on={env.shadows} onClick={() => envSet({ shadows: !env.shadows })} title="Shadows of the sun (or moon) near the camera. Off is faster." />
				<div className="rcol">
					<label title="Brightness of the sunlight (the sky light grows by half as much). Default 1.">Sunlight × {env.sun.toFixed(2)}</label>
					<input type="range" min={0.25} max={4} step={0.05} value={env.sun} onChange={(e) => envSet({ sun: Number(e.target.value) })} />
				</div>
			</Group>
			<Group label="Effects">
				<div className="rcol">
					<label title="Soft shadows in corners, under trees, and at the foot of walls (screen space, GTAO). Costs some FPS."><input type="checkbox" checked={env.ao} onChange={(e) => envSet({ ao: e.target.checked })} />Ambient occlusion</label>
					<label title="A small glow around bright parts of the view"><input type="checkbox" checked={env.bloom} onChange={(e) => envSet({ bloom: e.target.checked })} />Bloom</label>
				</div>
			</Group>
			<Group label="Ground detail">
				<div className="rcol">
					<label title="The ground textures of layers.cfg near the camera (from the mask), the satellite image further away. Needs the mask and the layer RVMAT files in the model folders."><input type="checkbox" checked={env.detail} onChange={(e) => envSet({ detail: e.target.checked })} />Show</label>
					<label title="The ground detail textures are full up to this distance (meters), then fade to the satellite image">From m <NumInput value={env.detailStart} onChange={(v) => envSet({ detailStart: Math.max(0, v) })} step={5} min={0} /></label>
					<label title="The ground detail textures are gone at this distance (meters)">To m <NumInput value={env.detailEnd} onChange={(v) => envSet({ detailEnd: Math.max(1, v) })} step={5} min={1} /></label>
					<label title="The clutter of the ground layers (CfgSurfaces and CfgSurfaceCharacters in the map config.cpp) shows to this distance (meters). 0: no clutter.">Clutter to m <NumInput value={env.clutterEnd} onChange={(v) => envSet({ clutterEnd: Math.max(0, Math.min(200, v)) })} step={10} min={0} /></label>
				</div>
			</Group>
			<Group label="Fog (as in 3DEN)">
				<div className="rcol">
					<label title="Fog density, 0 to 10 %">Density {env.fogDensity.toFixed(1)} % <input type="range" min={0} max={10} step={0.1} value={env.fogDensity} onChange={(e) => envSet({ fogDensity: Number(e.target.value) })} /></label>
					<label title="The fog decay starts at this altitude in meters (can be below 0, as in Arma 3). Below it, the fog has its full density.">Base altitude m {num(env.fogBase, (v) => envSet({ fogBase: v }), 10)}</label>
					<label title="Decay, 0 to 1 %: how fast the fog becomes thinner for each meter above the base altitude. 0: the same density at all altitudes.">Decay {env.fogDecay.toFixed(3)} % <input type="range" min={0} max={1} step={0.005} value={env.fogDecay} onChange={(e) => envSet({ fogDecay: Number(e.target.value) })} /></label>
				</div>
				<RBtn icon="refresh-line" label="Reset" onClick={() => setEnv(DEFAULT_ENV)} title="9:00, shadows and effects on, sunlight × 1, no fog" />
			</Group>
		</>
	);
	// The P3D name of the selected objects (one name when they all have the same model).
	const selectedModel = () => {
		const names = new Set<string>();
		for (const id of ed!.selection) {
			names.add(st!.models[st!.model[id]]);
			if (names.size > 1) return "several models";
		}
		return [...names][0] ?? "";
	};
	const stageHelp: Record<Stage, string> = {
		terrain: hb?.tool ? "Left mouse: paint the terrain. Ctrl+click: pick a height (flatten) or a plane point. Click the brush again to stop. Right mouse: look. W A S D: move." : "Make a new map or import a DEM, then open the satellite image and the mask. Right mouse: look. W A S D: move. Ctrl+1 to Ctrl+5: tabs. Home: show the whole map.",
		objects: "Left mouse: select (drag: box, Shift: add, Ctrl: toggle). 1 2 3: move, rotate, scale. X or Space: world or local. F: go to the selection. Right mouse: look. W A S D: move.",
		shapes: shapeEd.current?.drawing !== null && shapeEd.current?.drawing !== undefined ? "Click to add points. Enter or double-click ends the shape. Backspace removes the last point." : "Drag a point to move it. Ctrl+click adds a point to the selected shape. Delete removes the selected point. F: go to the selected shape.",
		imagery: surface2d ? "Left mouse: tool. Right drag: pan. Middle click or drag: move the 3D camera there (the yellow arrow). Wheel: zoom. [ ]: radius. Polygon: click points, double-click or Enter. Satellite: Ctrl+click picks a color, Alt+click sets the clone source." : "Left mouse: brush or fill on the terrain (to see mask changes, set the ground switch to Mask or Both). Ctrl+click picks a color, Alt+click sets the clone source. Right mouse: look. W A S D: move.",
		export: "Check the settings, then click Export.",
	};
	const se = shapeEd.current;
	// The property panel shows only when the tab or the tool has settings.
	const hasProps = stage === "terrain" || stage === "objects" || stage === "shapes" || stage === "imagery";
	// The browser (left panel) holds the lists to pick from: models, layers, shapes, mask layers.
	const hasBrowser = stage === "objects" || stage === "shapes" || stage === "imagery";
	const showModels = (stage === "objects" && objBrowse === "models") || (stage === "shapes" && shapeBrowse === "models");
	const envSet = (c: Partial<Environment>) => setEnv({ ...env, ...c });
	return (
		<div className="app">
			<div className="top">
				<span className="title" title={projectPath.current ?? "Not saved"}>{projectName ?? "Untitled"}{changes() !== savedAt.current ? " *" : ""}</span>
				<Tool icon="folder-open-line" disabled={busyOrNo} onClick={() => openProjectFile()} title="Open a Terrain Tool project (.ttproj)" />
				<details className="recent">
					<summary title="Open one of the last 5 projects"><Icon name="history-line" /></summary>
					<div className="menu">
						{recent.length ? recent.map((p) => (
							<button key={p} disabled={busyOrNo} title={p} onClick={(e) => ((e.currentTarget.closest("details") as HTMLDetailsElement).open = false, openProjectFile(p))}>{p.split(/[\\/]/).pop()}</button>
						)) : <div className="muted">No recent projects</div>}
					</div>
				</details>
				<Tool icon="save-3-line" disabled={busyOrNo} onClick={() => saveProject(false)} title="Save the project (Ctrl+S)" />
				<Tool icon="file-copy-2-line" disabled={busyOrNo} onClick={() => saveProject(true)} title="Save the project as a new file (Ctrl+Shift+S)" />
				<nav className="tabs">
					{STAGES.map((s, i) => (
						<button key={s.id} className={`tab${stage === s.id ? " on" : ""}`} disabled={s.id !== "terrain" && !terrain} onClick={() => (s.id === "export" && !game && setGame(defaultSettings(tbProject.current)), goStage(s.id))} title={`${s.help} (Ctrl+${i + 1})`}>
							<Icon name={s.icon} /> {s.name}
						</button>
					))}
				</nav>
				<span className="spacer" />
				<span className="busy">{busy && `${busy}...`}</span>
				{progress < 1 && (
					<span className="progress">
						<progress value={progress} max={1} />
						<Btn icon="stop-circle-line" onClick={() => cancelJob()} title="Stop the job. A cancelled fill or model scan changes nothing. A cancelled export writes no WRP (some tiles can be written).">Cancel</Btn>
					</span>
				)}
				<Tool icon={theme === "dark" ? "sun-line" : "moon-line"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "Light theme" : "Dark theme"} />
				<Tool icon="layout-left-line" on={left} disabled={!hasBrowser} onClick={() => (setLeft(!left), setPref("leftPanel", left ? "0" : "1"))} title={left ? "Hide the browser (left panel)" : "Show the browser (left panel)"} />
				<Tool icon="layout-right-line" on={right} disabled={!hasProps} onClick={() => (setRight(!right), setPref("rightPanel", right ? "0" : "1"))} title={right ? "Hide the property panel" : "Show the property panel"} />
			</div>
			<div className="ribbon">
				{stage === "terrain" && <>
					<Group label="Map">
						<RBtn icon="file-add-line" label="New map" disabled={!!busy || !inTauri} onClick={startOver} title="Close the open map and start again (asks first when a map is open). Then set the grid, the cell size, and the corner in the property panel, and click 'Make the map'." />
						<RBtn icon="landscape-line" label="Import DEM" disabled={busyOrNo} onClick={openAsc} title="Read a heightmap: ESRI ASCII grid (.asc) or Terragen (.ter, corner 200000, 0)" />
						<RBtn icon="folder-open-line" label="TB project" disabled={busyOrNo} onClick={openTv4p} title="Read a TB project (TV4P): its heightmap, satellite image, and the objects of its exported WRP" />
						<RBtn icon="map-2-line" label="Open WRP" disabled={busyOrNo} onClick={openWrp} title="Read an editable WRP: the heights and the objects" />
					</Group>
					<Group label="Imagery">
						<RBtn icon="image-add-line" label="Satellite" disabled={busyOrNo || !terrain} onClick={openSat} title="Open the satellite image (PNG or BMP)" />
						<RBtn icon="stack-line" label="Mask" disabled={busyOrNo || !terrain} onClick={openMask} title="Open layers.cfg and the source mask (from the TB project, if one is open)" />
					</Group>
					{hb && <Group label="Sculpt">
						{(["raise", "lower", "smooth", "flatten", "plane", "noise", "stamp"] as TerrainTool[]).map((t) => (
							<RBtn key={t} icon={TERRAIN_ICON[t]} label={t[0].toUpperCase() + t.slice(1)} on={hb.tool === t} disabled={!terrain} onClick={() => pickBrush(hb.tool === t ? null : t)} title={`${TERRAIN_HELP[t]} Click again to stop.`} />
						))}
					</Group>}
					<Group label="Edit">
						<RBtn icon="arrow-go-back-line" label="Undo" disabled={!ed?.canUndo} onClick={() => ed!.undo()} title="Undo (Ctrl+Z, objects and terrain)" />
						<RBtn icon="arrow-go-forward-line" label="Redo" disabled={!ed?.canRedo} onClick={() => ed!.redo()} title="Redo (Ctrl+Y)" />
					</Group>
					<Group label="Heightmap">
						<RBtn icon="drop-line" label="Sea level" on={env.sea} onClick={() => envSet({ sea: !env.sea })} title="Show the sea at 0 m (the sea level of Arma 3). The height offset is in the property panel when no brush is selected." />
						<RBtn icon="file-download-line" label="Export ASC" disabled={busyOrNo || !coreHeights.current} onClick={exportAsc} title="Write the heightmap as an ASC with the header of the source (decimals: see the property panel)" />
					</Group>
				</>}
				{stage === "objects" && ed && <>
					<Group label="Import">
						<RBtn icon="file-upload-line" label="Object text" disabled={busyOrNo || !terrain} onClick={importText} title="Import object text (TB layer export)" />
						<div className="rcol">
							<label title="Z of the object text: relative (above the terrain)"><input type="radio" checked={relative} onChange={() => setRelative(true)} />Relative z</label>
							<label title="Z of the object text: absolute (above sea level)"><input type="radio" checked={!relative} onChange={() => setRelative(false)} />Absolute z</label>
						</div>
					</Group>
					<Group label="Transform">
						{(["translate", "rotate", "scale"] as const).map((md, i) => (
							<RBtn key={md} icon={["drag-move-2-line", "clockwise-line", "expand-diagonal-line"][i]} label={["Move", "Rotate", "Scale"][i]} on={ed.mode === md} onClick={() => ed.setMode(md)} title={`${["Move", "Rotate", "Scale"][i]} (key ${i + 1})`} />
						))}
						<RBtn icon="global-line" label="World" on={ed.space === "world"} onClick={() => ed.setSpace("world")} title="World axes: east, up, north (key X or Space)" />
						<RBtn icon="focus-3-line" label="Local" on={ed.space === "local"} onClick={() => ed.setSpace("local")} title="Local axes: the axes of the last selected object (key X or Space)" />
					</Group>
					<Group label="Snap">
						<div className="rcol">
							<label title="Grid snap for move, in meters. 0 is off."><Icon name="grid-line" /> Grid {num(ed.gridSnap, (v) => ed.setSnap(Math.max(0, v), ed.rotateSnap, ed.snapGround), 0.5, 0)}</label>
							<label title="Rotate in steps of 15 degrees"><input type="checkbox" checked={ed.rotateSnap} onChange={() => ed.setSnap(ed.gridSnap, !ed.rotateSnap, ed.snapGround)} />15° snap</label>
							<label title="Objects stay on the ground when they move"><input type="checkbox" checked={ed.snapGround} onChange={() => ed.setSnap(ed.gridSnap, ed.rotateSnap, !ed.snapGround)} />Snap to ground</label>
						</div>
					</Group>
					<Group label="Edit">
						<RBtn icon="arrow-go-back-line" label="Undo" disabled={!ed.canUndo} onClick={() => ed.undo()} title="Undo (Ctrl+Z)" />
						<RBtn icon="arrow-go-forward-line" label="Redo" disabled={!ed.canRedo} onClick={() => ed.redo()} title="Redo (Ctrl+Y)" />
						<RBtn icon="delete-bin-line" label="Delete" disabled={!ed.selection.size} onClick={() => ed.deleteSelection()} title="Delete the selection (Delete)" />
						<RBtn icon="focus-2-line" label="Go to" disabled={!ed.selection.size} onClick={() => ed.focus()} title="Move the camera to the selection (F)" />
					</Group>
					<Group label="Scatter">
						<RBtn icon="brush-line" label="Scatter brush" on={!!sb?.enabled} disabled={!terrain} onClick={() => {
							sb!.setEnabled(!sb!.enabled);
							ed.enabled = !sb!.enabled;
							setTick((n) => n + 1);
						}} title="Paint objects with the recipe of the Object fill section (property panel). Shift+paint removes them." />
						{sb?.enabled && <div className="rcol"><label title="Scatter brush radius in meters">Radius m {num(sb.radius, (v) => {
							sb.radius = Math.max(1, v);
							setTick((n) => n + 1);
						}, 5, 1)}</label></div>}
					</Group>
					<Group label="View">
						<RBtn icon={showObjects ? "eye-line" : "eye-off-line"} label="Objects" on={showObjects} onClick={() => {
							setShowObjects(!showObjects);
							viewer.current!.objectsVisible = !showObjects;
						}} title={showObjects ? "Hide the objects" : "Show the objects"} />
					</Group>
				</>}
				{stage === "shapes" && se && <>
					<Group label="Draw">
						{(["line", "polygon", "point"] as const).map((k) => (
							<RBtn key={k} icon={{ line: "route-line", polygon: "shape-line", point: "map-pin-line" }[k]} label={`New ${k}`} on={se.drawing !== null && se.shape(se.drawing)?.kind === k} disabled={!terrain} onClick={() => (se.start(k), setTick((n) => n + 1), canvas.current!.focus())} title="Click on the terrain to add points. Enter or double-click ends the shape." />
						))}
					</Group>
					<Group label="Selected shapes">
						<RBtn icon="eraser-line" label="Clear objects" disabled={!se.selectedShapes().length} onClick={() => setError(`${se.clearNear(clearDist)} objects deleted near ${se.selectedShapes().length} shape(s).`)} title="Delete the objects near the selected shapes (list selection and the selected shape; visible layers that are not locked; one undo step): within the distance of a line, of a road edge (half the road width is added), of a point, or of a polygon edge, and inside polygons." />
						<div className="rcol">
							<label title="Distance in meters from the line, the road edge, the point, or the polygon edge">Distance m <NumInput value={clearDist} onChange={(v) => setClearDist(Math.max(0, v))} step={1} min={0} /></label>
						</div>
					</Group>
					<Group label="Erase objects">
						{(["polygon", "lasso"] as const).map((k) => (
							<RBtn key={k} icon={k === "polygon" ? "shape-line" : "pen-nib-line"} label={k === "polygon" ? "Polygon" : "Lasso"} on={se.erase === k} disabled={!terrain} onClick={() => (se.setErase(se.erase === k ? null : k), canvas.current!.focus())} title={`Delete the objects inside the area (visible layers that are not locked; one undo step). ${k === "polygon" ? "Click the points; Enter or double-click ends the area." : "Drag on the terrain."} Escape cancels the area. Click again to stop.`} />
						))}
					</Group>
					<Group label="Edit">
						<RBtn icon="arrow-go-back-line" label="Undo" disabled={!ed?.canUndo} onClick={() => ed!.undo()} title="Undo (Ctrl+Z)" />
						<RBtn icon="arrow-go-forward-line" label="Redo" disabled={!ed?.canRedo} onClick={() => ed!.redo()} title="Redo (Ctrl+Y)" />
						<RBtn icon="focus-2-line" label="Go to" disabled={se.selected === null} onClick={() => se.focus()} title="Move the camera to the selected shape (F)" />
					</Group>
					<Group label="Files">
						<div className="rcol muted">SHP import, SHP export, and RoadsLib.cfg are in the browser (left panel, Shapes page).</div>
					</Group>
				</>}
				{stage === "imagery" && mv && <>
					<Group label="View">
						<RBtn icon="layout-grid-line" label="2D painter" on={surface2d} onClick={() => (setSurface2d(true), goStage("imagery", true))} title="Paint in the 2D view" />
						<RBtn icon="landscape-line" label="3D view" on={!surface2d} onClick={() => (setSurface2d(false), goStage("imagery", false))} title="Paint on the 3D terrain: the brushes and the fill (the polygon and the lasso are only in the 2D painter)" />
					</Group>
					<>
						<Group label="Paint">
							<RBtn icon="stack-line" label="Mask" on={mv.target === "mask"} disabled={!mask} onClick={() => setMv({ target: "mask" })} title="Paint the mask" />
							<RBtn icon="image-line" label="Satellite" on={mv.target === "sat"} disabled={!sat} onClick={() => setMv({ target: "sat" })} title="Paint the satellite image" />
						</Group>
						<Group label="Tools">
							{mv.target === "mask" && (["brush", "erase", "fill", "polygon", "lasso"] as MaskTool[]).map((t) => (
								<RBtn key={t} icon={MASK_ICON[t]} label={t[0].toUpperCase() + t.slice(1)} disabled={!mask || (!surface2d && (t === "polygon" || t === "lasso"))} on={mv.tool === t} onClick={() => setMv({ tool: t })} title={TOOL_HELP[t]} />
							))}
							{mv.target === "sat" && (["color", "clone", "smooth", "texture"] as SatTool[]).map((t) => (
								<RBtn key={t} icon={SAT_ICON[t]} label={t[0].toUpperCase() + t.slice(1)} disabled={!sat} on={mv.satTool === t} onClick={() => setMv({ satTool: t })} title={SAT_HELP[t]} />
							))}
						</Group>
						<Group label="Edit">
							<RBtn icon="arrow-go-back-line" label="Undo" disabled={!mask && !sat} onClick={() => mv.undo(false)} title="Undo in the paint target (Ctrl+Z)" />
							<RBtn icon="arrow-go-forward-line" label="Redo" disabled={!mask && !sat} onClick={() => mv.undo(true)} title="Redo in the paint target (Ctrl+Y)" />
						</Group>
					</>
					<Group label="PNG export">
						<RBtn icon="file-download-line" label="Mask" disabled={!mask || !!busy} onClick={exportMask} title="Write the mask as one RGB PNG with the palette colors" />
						<RBtn icon="file-download-line" label="Satellite" disabled={!sat || !!busy} onClick={exportSat} title="Write the satellite image as one 8-bit RGB PNG" />
					</Group>
				</>}
				{stage === "export" && <Group label="Export for game"><div className="rcol muted">The settings are on the page below. The project file keeps them.</div></Group>}
				<span className="spacer" />
				<span className="error">{error}</span>
			</div>
			<div className="main" style={{ gridTemplateColumns: `${left && hasBrowser ? "270px" : "0"} 1fr ${right && hasProps ? "320px" : "0"}` }}>
				{/* Browser: the lists to pick from. The panels keep their state while other tabs show. */}
				{/* Each part has its own grid column: a hidden panel (display none) takes no grid cell, so the view would move into its column. */}
				<div className="side browser" style={{ display: left && hasBrowser ? "flex" : "none", gridColumn: 1 }}>
					{stage === "objects" && <div className="pages">
						<button className={objBrowse === "models" ? "on" : ""} onClick={() => setObjBrowse("models")}><Icon name="box-3-line" /> Models</button>
						<button className={objBrowse === "layers" ? "on" : ""} onClick={() => setObjBrowse("layers")}><Icon name="stack-line" /> Layers</button>
					</div>}
					{stage === "shapes" && <div className="pages">
						<button className={shapeBrowse === "shapes" ? "on" : ""} onClick={() => setShapeBrowse("shapes")}><Icon name="route-line" /> Shapes</button>
						<button className={shapeBrowse === "models" ? "on" : ""} onClick={() => setShapeBrowse("models")}><Icon name="box-3-line" /> Models</button>
					</div>}
					<div className="page" style={{ display: showModels ? "flex" : "none" }}>
						<ModelPanel enabled={inTauri} onLibrary={setLibrary} onShow={setShown} onPick={setPicked} scanRequest={scanRequest} placing={ed?.placing ?? null} onPlace={(md) => {
							if (md && stage !== "objects") goStage("objects");
							ed!.startPlace(md);
							canvas.current!.focus();
						}} />
					</div>
					<div className="panel layers page" style={{ display: stage === "objects" && objBrowse === "layers" ? "flex" : "none" }}>{objectsPanel}</div>
					<div className="panel layers page" style={{ display: stage === "shapes" && shapeBrowse === "shapes" ? "flex" : "none" }}>{ed && se && hb && mv && <ShapesPanel part="list" se={se} ed={ed} hb={hb} mv={mv} mask={mask} terrain={terrain} shown={shown} recipe={recipe} onError={setError} onBusy={setBusy} onMask={() => mask3d && update3d(true).catch((e) => setError(String(e)))} />}</div>
					{stage === "imagery" && <div className="panel layers page">{maskBrowser}</div>}
				</div>
				<div className="viewbox" style={{ gridColumn: 2 }}>
					<canvas ref={canvas} className="view" />
					<canvas ref={maskCanvas} className="view overlay" tabIndex={0} style={{ display: view === "mask" ? "block" : "none" }} />
					{view !== "mask" && stage !== "export" && terrain && (
						<div className="ground" role="radiogroup" aria-label="Ground texture of the 3D view">
							{([["sat", "image-line", "Satellite", "The satellite image (or the height colors without one)"], ["mask", "stack-line", "Mask", "The mask colors"], ["both", "contrast-drop-2-line", "Both", "The mask over the satellite image, with the mask overlay opacity of the Imagery tab"]] as const).map(([k, icon, label, help]) => (
								<button key={k} role="radio" aria-checked={ground === k} className={ground === k ? "on" : ""} disabled={k !== "sat" && !mask} onClick={() => setGround(k)} title={k === "sat" ? help : mask ? help : "Open a mask first"}>
									<Icon name={icon} /> {label}
								</button>
							))}
						</div>
					)}
					{stage === "export" && game && ed && shapeEd.current && <GameExport settings={game} onChange={setGame} store={ed.store} shapes={shapeEd.current.shapes} terrain={terrain} layersCfg={cfgPath.current} searchRoots={savedRoots()} mask={mask} hasSat={!!sat} frame={tbProject.current?.mapFrame} />}
				</div>
				{/* Properties: the settings of the tab, the selected item, or the active tool. */}
				<div className="side props" style={{ display: right && hasProps ? "flex" : "none", gridColumn: 3 }}>
					{stage === "terrain" && <div className="panel layers">{hb?.tool ? terrainPanel : projectPanel}</div>}
					{stage === "imagery" && <div className="panel layers">{surfacePanel}</div>}
					<div className="panel layers" style={{ display: stage === "shapes" ? "flex" : "none" }}>{ed && se && hb && mv && <ShapesPanel part="props" se={se} ed={ed} hb={hb} mv={mv} mask={mask} terrain={terrain} shown={shown} recipe={recipe} onError={setError} onBusy={setBusy} onMask={() => mask3d && update3d(true).catch((e) => setError(String(e)))} />}</div>
					<div className="panel layers" style={{ display: stage === "objects" ? "flex" : "none" }}>
						<b>Object fill and scatter brush</b>
						{ed && <FillPanel ed={ed} viewer={viewer.current!} mask={mask} shown={shown} picked={picked} onError={setError} onDone={() => setTick((n) => n + 1)} recipe={recipe} />}
					</div>
				</div>
			</div>
			<div className="vpanel" ref={belowView}>
				<button className="vhead" onClick={() => setVpOpen(!vpOpen)} title="Show or hide the viewport settings (time of day, camera, light, effects, fog)">
					<Icon name={vpOpen ? "arrow-down-s-line" : "arrow-up-s-line"} /> Viewport
				</button>
				{vpOpen && <div className="ribbon">{viewportGroups}</div>}
			</div>
			<div className="status">
				<div className="status-info">{view === "mask" ? <>
					<span>{mask ? `Mask ${mask.width} x ${mask.height} px` : "No mask"}{sat ? `, satellite ${sat.width} x ${sat.height} px` : ", no satellite"}</span>
					<span>{maskCursor && mask ? `Pixel ${maskCursor.x}, ${maskCursor.y}  ${maskCursor.color >= 0 ? mask.names[maskCursor.color] : ""}` : ""}</span>
				</> : <>
					<span>{terrain ? `Grid ${terrain.ncols} x ${terrain.nrows}, cell ${terrain.cell} m, size ${terrain.ncols * terrain.cell} m` : "No heightmap"}</span>
					<span>{cursor && terrain ? `X ${(cursor.x + terrain.xll).toFixed(2)}  Y ${(cursor.y + terrain.yll).toFixed(2)}  Z ${cursor.h.toFixed(2)}` : ""}</span>
					<span>{st?.count ? `${stats.drawn} of ${st.count} objects drawn, ${ed!.selection.size} selected` : ""}</span>
					{!!ed?.selection.size && <span className="model-name" title="Model (P3D) of the selected objects">{selectedModel()}</span>}
					<span>{`${stats.fps.toFixed(0)} FPS, ${(stats.tris / 1e6).toFixed(2)} M triangles`}</span>
				</>}</div>
				<span className="help" title={stageHelp[stage]}>{stageHelp[stage]}</span>
			</div>
		</div>
	);
}
