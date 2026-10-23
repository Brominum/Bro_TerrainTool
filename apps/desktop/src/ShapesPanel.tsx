// Shapes panel (property panel of the Shapes tab): the shape list, the selected shape (name, group, properties, spline), the shape actions,
// and SHP import and export. Positions are local meters; the SHP files use TB coordinates (local meters plus the map offset).
import { Icon } from "./ui";
import { useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { heightFlattenPolygon, heightRoad, maskBand, maskPolygon, shpRead, shpWrite, type MaskInfo, type ShpKind, type ShpShape, type Terrain } from "./data";
import type { Editor } from "./editor";
import { runFill, type Recipe } from "./FillPanel";
import type { HeightBrush } from "./heightbrush";
import type { MaskView } from "./maskview";
import type { ShapeEditor } from "./shapeview";
import { curve, newSpline, PRESETS, roadId, shpPoints, type Shape, type ShapeKind } from "./shapes";

const KIND_SHP: Record<ShapeKind, ShpKind> = { line: "line", polygon: "polygon", point: "point" };

interface Props {
	// "list": the shape list and the SHP files (browser). "props": the selected shape (property panel).
	part: "list" | "props";
	se: ShapeEditor;
	ed: Editor;
	hb: HeightBrush;
	mv: MaskView;
	mask?: MaskInfo;
	terrain?: Terrain;
	// The model in the preview of the model panel.
	shown?: string;
	recipe: { current: () => Recipe };
	onError: (e: string) => void;
	onBusy: (label: string) => void;
	// The mask changed (for the 3D overlay).
	onMask: () => void;
}

export function ShapesPanel({ part, se, ed, hb, mv, mask, terrain, shown, recipe, onError, onBusy, onMask }: Props) {
	const [, setTick] = useState(0);
	// Layer list: closed groups, the group being renamed, the last clicked shape (Shift+click range).
	const [closed, setClosed] = useState<Set<string>>(new Set());
	const [renaming, setRenaming] = useState<string | null>(null);
	const [lastPick, setLastPick] = useState<number | null>(null);
	// Imported shapes that are mostly outside the map: their ids, their box (x0, y0, x1, y1, local meters), and the proposed move.
	const [offMap, setOffMap] = useState<{ ids: number[]; box: number[]; dx: number; dy: number } | null>(null);
	// Road terrain: range from the centre (half the flat width), feather, smooth along, the grade limit and the cross slope (percent).
	const [act, setAct] = useState({ range: 4, feather: 6, smooth: 30, slope: 0, tilt: 0, flatten: "", maskWidth: 6, maskFeather: 2 });
	const s = se.shape(se.selected);
	// The list and the properties are two parts of this panel (left and right); the editor change makes both draw again.
	const redraw = () => (setTick((n) => n + 1), se.onChange?.());
	// A selected road gives half its road width to the range of the road terrain.
	const roadWidth = s && s.kind === "line" ? se.roads.get(roadId(s) ?? -1)?.width : undefined;
	useEffect(() => {
		if (roadWidth) setAct((a) => ({ ...a, range: roadWidth / 2 }));
	}, [s?.id, roadWidth]);
	// Change the selected shape as one undo step. `objects`: its spline objects change too.
	const change = (f: (s: Shape) => void, objects = true) => {
		if (!s) return;
		se.edit((all) => {
			f(all.find((x) => x.id === s.id)!);
			return objects ? [s.id] : [];
		});
	};
	// A text change (name, group, properties) without an undo step, so that each key is not a step. It counts as a change of the project.
	const text = (f: (s: Shape) => void) => {
		if (!s) return;
		f(s);
		ed.version++;
		se.draw();
		redraw();
	};
	const job = async (label: string, f: () => Promise<void>) => {
		onBusy(label);
		onError("");
		try {
			await f();
		} catch (e) {
			onError(String(e));
		} finally {
			onBusy("");
			redraw();
		}
	};
	const pts = (x: Shape) => curve(x, 2);
	// Local meters to mask pixels (row 0 is the north row).
	const toPx = (p: number[]) => {
		const [sx, sy] = [terrain!.ncols * terrain!.cell, terrain!.nrows * terrain!.cell];
		return [p[0] / (sx / mask!.width), (sy - p[1]) / (sy / mask!.height)];
	};
	const pxPerMeter = () => mask!.width / (terrain!.ncols * terrain!.cell);
	const paintMask = () =>
		job("Painting the mask", async () => {
			if (!mask || !terrain) throw "open a mask and a heightmap first";
			const p = pts(s!).map(toPx);
			const k = pxPerMeter();
			const r = s!.kind === "polygon" ? await maskPolygon(p, mv.color) : await maskBand(p, (act.maskWidth / 2) * k, act.maskFeather * k, mv.color, (Math.random() * 2 ** 32) >>> 0);
			if (r) {
				mv.maskChanged(r);
				onMask();
			}
		});
	const terrainAction = () =>
		job("Changing the terrain", async () => {
			const base = hb.base();
			const t = act.flatten.trim() === "" ? null : Number(act.flatten);
			// Lines: all selected lines (list selection and the selected shape), as one undo step.
			const lines = se.selectedShapes().filter((x) => x.kind === "line" && x.points.length > 1).map(pts);
			const r = s!.kind === "polygon" ? await heightFlattenPolygon(pts(s!), t, act.feather) : await heightRoad(lines, act.range * 2, act.feather, act.smooth, act.slope / 100, act.tilt / 100);
			if (r) await hb.finish(r, base);
		});
	const scatter = () =>
		job("Filling", async () => {
			const rc = recipe.current();
			if (!rc.models.length) throw "add models to the recipe in the Object fill panel first";
			const r = await runFill(ed, rc.settings, rc.avoid, pts(s!));
			if (!r) return;
			if (!ed.store.layers[ed.activeLayer] || ed.store.layers[ed.activeLayer].deleted) throw "select a layer first";
			await ed.applyFill(r, { name: `scatter: ${s!.name}`, layer: ed.activeLayer, settings: rc.settings, models: rc.models, avoid: rc.avoid });
		});
	// One file set for each group (and type, when a group has more than one type), in a folder.
	const exportShp = () =>
		job("Writing SHP", async () => {
			const dir = await open({ title: "Select the folder for the SHP files", directory: true, multiple: false });
			if (typeof dir !== "string") return;
			const [xll, yll] = [terrain?.xll ?? 0, terrain?.yll ?? 0];
			const sets = new Map<string, Shape[]>();
			for (const x of se.shapes) if (!x.deleted && x.points.length) (sets.get(`${x.group}\n${x.kind}`) ?? sets.set(`${x.group}\n${x.kind}`, []).get(`${x.group}\n${x.kind}`)!).push(x);
			const groups = new Map<string, number>();
			for (const k of sets.keys()) groups.set(k.split("\n")[0], (groups.get(k.split("\n")[0]) ?? 0) + 1);
			const written: string[] = [];
			for (const [k, list] of sets) {
				const [group, kind] = k.split("\n") as [string, ShapeKind];
				const name = (groups.get(group)! > 1 ? `${group}_${kind}` : group).replace(/[\\/:*?"<>|]/g, "_");
				const shapes: ShpShape[] = list.map((x) => ({ parts: [shpPoints(x, xll, yll)], props: x.props }));
				await shpWrite(`${dir}\\${name}.shp`, KIND_SHP[kind], shapes);
				written.push(`${name}.shp (${list.length})`);
			}
			onError(written.length ? `Written: ${written.join(", ")}` : "No shapes to write.");
		});
	const importShp = () =>
		job("Reading SHP", async () => {
			const files = await open({ title: "Select SHP files", multiple: true, directory: false, filters: [{ name: "Shapefile", extensions: ["shp"] }] });
			const list = Array.isArray(files) ? files : typeof files === "string" ? [files] : [];
			if (!list.length) return;
			const [xll, yll] = [terrain?.xll ?? 0, terrain?.yll ?? 0];
			const read = await Promise.all(list.map(async (f) => ({ f, r: await shpRead(f) })));
			// Without road types, look for a RoadsLib.cfg next to the SHP files.
			if (!se.roads.size) await se.loadRoads(list[0].replace(/[^\\/]*$/, "RoadsLib.cfg")).catch(() => {});
			const notes: string[] = [];
			const first = se.shapes.reduce((m, x) => Math.max(m, x.id), 0) + 1;
			await se.edit((all) => {
				let id = all.reduce((m, x) => Math.max(m, x.id), 0);
				for (const { f, r } of read) {
					// A file from TB has TB coordinates (with the map offset). A roads.shp of the game (for example from a packed map) has map coordinates (0 to the map size).
					const [w, h] = [(terrain?.ncols ?? 0) * (terrain?.cell ?? 0), (terrain?.nrows ?? 0) * (terrain?.cell ?? 0)];
					const all2 = r.shapes.flatMap((x) => x.parts.flat());
					const map = all2.length > 0 && all2.every((p) => p[0] >= -1 && p[0] <= w + 1 && p[1] >= -1 && p[1] <= h + 1) && (xll !== 0 || yll !== 0);
					const [ox, oy] = map ? [0, 0] : [xll, yll];
					notes.push(`${f.split(/[\\/]/).pop()}: ${map ? "map coordinates" : "TB coordinates"}`);
					const group = f.split(/[\\/]/).pop()!.replace(/\.shp$/i, "");
					const kind: ShapeKind = r.kind;
					r.shapes.forEach((x, i) => {
						// Each part of a multi-part shape becomes one shape.
						for (const part of x.parts) {
							if (part.length < (kind === "polygon" ? 3 : kind === "line" ? 2 : 1)) continue;
							const shape: Shape = { id: ++id, kind, name: `${group} ${i + 1}`, group, points: part.map((p) => [p[0] - ox, p[1] - oy]), props: x.props, smooth: false, closed: false };
							// A road (a line with an ID) is a smooth curve, as in TB.
							shape.smooth = kind === "line" && roadId(shape) !== undefined;
							all.push(shape);
						}
					});
				}
				return [];
			});
			onError(`Imported: ${notes.join(", ")}`);
			checkOffMap(se.shapes.filter((x) => x.id >= first && !x.deleted));
		});
	// When most points of the imported shapes are outside the map, propose a move: the center of their box to the map center, rounded
	// to whole kilometers (so that a grid of the source data stays on whole numbers).
	const checkOffMap = (list: Shape[]) => {
		if (!terrain || !list.length) return;
		const [w, h] = [terrain.ncols * terrain.cell, terrain.nrows * terrain.cell];
		const pts = list.flatMap((x) => x.points);
		const outside = pts.filter((p) => p[0] < 0 || p[1] < 0 || p[0] > w || p[1] > h).length;
		if (outside * 2 <= pts.length) return;
		// A loop, not Math.min(...): a spread of many points overflows the call stack.
		const box = pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
		const round = (v: number) => Math.round(v / 1000) * 1000;
		setOffMap({ ids: list.map((x) => x.id), box, dx: round(w / 2 - (box[0] + box[2]) / 2), dy: round(h / 2 - (box[1] + box[3]) / 2) });
	};
	const moveOffMap = () => {
		if (!offMap) return;
		const ids = new Set(offMap.ids);
		se.edit((all) => {
			for (const x of all) if (ids.has(x.id)) x.points = x.points.map((p) => [p[0] + offMap.dx, p[1] + offMap.dy]);
			return [...ids];
		});
		setOffMap(null);
	};
	const loadRoads = () =>
		job("Reading RoadsLib.cfg", async () => {
			const f = await open({ title: "Select RoadsLib.cfg", multiple: false, directory: false, filters: [{ name: "RoadsLib.cfg", extensions: ["cfg"] }] });
			if (typeof f !== "string") return;
			const w = await se.loadRoads(f);
			if (w.length) onError(w.join("\n"));
		});
	const live = se.shapes.filter((x) => !x.deleted);
	const groups = [...new Set(live.map((x) => x.group))];
	const flipSet = <T,>(set: Set<T>, k: T) => {
		const n = new Set(set);
		if (!n.delete(k)) n.add(k);
		return n;
	};
	const flipIn = <T,>(set: Set<T>, k: T) => {
		if (!set.delete(k)) set.add(k);
	};
	const rename = (from: string, to: string) => {
		setRenaming(null);
		se.renameGroup(from, to.trim());
		redraw();
	};
	const deleteGroup = async (g: string, items: Shape[]) => {
		if (!(await ask(`Delete the layer ${g} and its ${items.length} shapes? Ctrl+Z gives them back.`, { title: "Delete layer", kind: "warning" }))) return;
		se.removeMany(items.map((x) => x.id));
		if (se.activeGroup === g) se.activeGroup = null;
		redraw();
	};
	// Click: select one shape. Ctrl+click: add or remove. Shift+click: the range in the list from the last clicked shape.
	const pickShape = (x: Shape, e: { ctrlKey: boolean; shiftKey: boolean }) => {
		const flat = groups.flatMap((g) => (closed.has(g) ? [] : live.filter((y) => y.group === g).map((y) => y.id)));
		if (e.shiftKey && lastPick !== null && flat.includes(lastPick)) {
			const [a, b] = [flat.indexOf(lastPick), flat.indexOf(x.id)].sort((p, q) => p - q);
			for (const id of flat.slice(a, b + 1)) se.picked.add(id);
		} else if (e.ctrlKey) {
			flipIn(se.picked, x.id);
		} else {
			se.picked.clear();
			se.picked.add(x.id);
		}
		se.selected = x.id;
		se.point = null;
		setLastPick(x.id);
		se.draw();
		redraw();
	};
	const num = (v: number, set: (v: number) => void, step = 1, title = "") => <input type="number" step={step} value={v} title={title} onChange={(e) => set(Number(e.target.value) || 0)} />;
	return (
		<div className="shapes">
			{part === "list" && <>
			<b>Layers</b>
			<div className="list shape-list">
				{groups.flatMap((g) => {
					const items = live.filter((x) => x.group === g);
					const isOpen = !closed.has(g);
					const hidden = se.hidden.has(g);
					const locked = se.locked.has(g);
					return [
						<div key={`g:${g}`} className={`row${se.activeGroup === g ? " active" : ""}`}>
							<button className="icon" title={isOpen ? "Hide the shape list" : "Show the shapes"} onClick={() => setClosed(flipSet(closed, g))}><Icon name={isOpen ? "arrow-down-s-line" : "arrow-right-s-line"} /></button>
							<button className="icon" title={hidden ? "Hidden (click to show)" : "Visible (click to hide)"} onClick={() => (flipIn(se.hidden, g), se.draw(), redraw())}><Icon name={hidden ? "eye-off-line" : "eye-line"} /></button>
							<button className="icon" title={locked ? "Locked (click to unlock)" : "Not locked (click to lock)"} onClick={() => (flipIn(se.locked, g), redraw())}><Icon name={locked ? "lock-line" : "lock-unlock-line"} /></button>
							{renaming === g ? (
								<input className="name" autoFocus defaultValue={g} onBlur={(e) => rename(g, e.target.value)} onKeyDown={(e) => {
									if (e.key === "Enter") rename(g, e.currentTarget.value);
									if (e.key === "Escape") setRenaming(null);
								}} />
							) : (
								<span className="name" title="Click: make this the active layer (new shapes go into it; click again for the default). Double-click: rename." onClick={() => ((se.activeGroup = se.activeGroup === g ? null : g), redraw())} onDoubleClick={() => setRenaming(g)}>{g}</span>
							)}
							<span className="muted">({items.length})</span>
							<button className="icon" title="Delete the layer and all its shapes (Ctrl+Z gives them back)" onClick={() => deleteGroup(g, items)}><Icon name="delete-bin-line" /></button>
						</div>,
						...(isOpen
							? items.map((x) => (
									<div key={x.id} className={`row shape-row${x.id === se.selected || se.picked.has(x.id) ? " active" : ""}`} onClick={(e) => pickShape(x, e)} title="Click: select. Ctrl+click: add or remove. Shift+click: select the range.">
										<span className="name">{x.name}</span>
										<span className="muted">{x.kind}, {x.points.length} pt</span>
									</div>
								))
							: []),
					];
				})}
			</div>
			<div className="row wrap">
				<button disabled={!se.picked.size} onClick={() => (se.removeMany([...se.picked]), redraw())} title="Delete the selected shapes (Ctrl+Z gives them back)"><Icon name="delete-bin-line" /> Delete selected ({se.picked.size})</button>
			</div>
			{offMap && (
				<div className="offmap">
					<b>Imported shapes are off the map</b>
					<div className="muted">Box {offMap.box.map((v) => Math.round(v)).join(", ")} m (local). The map is 0 to {terrain ? terrain.ncols * terrain.cell : 0} m. Proposed move: the center of the box to the map center, in whole kilometers.</div>
					<label className="field-row">Move X m {num(offMap.dx, (v) => setOffMap({ ...offMap, dx: v }), 1000)}</label>
					<label className="field-row">Move Y m {num(offMap.dy, (v) => setOffMap({ ...offMap, dy: v }), 1000)}</label>
					<div className="row wrap">
						<button onClick={moveOffMap} title="Move the imported shapes (one undo step)"><Icon name="drag-move-line" /> Move</button>
						<button onClick={() => setOffMap(null)} title="Keep the shapes where they are">Keep</button>
					</div>
				</div>
			)}
			<div className="row wrap">
				<button disabled={!terrain} onClick={importShp} title="Read SHP files (TB coordinates). Each file becomes a group."><Icon name="file-upload-line" /> Import SHP</button>
				<button disabled={!se.shapes.some((x) => !x.deleted)} onClick={exportShp} title="Write one SHP set for each group, in TB coordinates. A group named roads gives roads.shp."><Icon name="file-download-line" /> Export SHP</button>
				<button onClick={loadRoads} title="Read the road types. A line with the property ID shows as that road; ORDER 0 is the top layer."><Icon name="road-map-line" /> RoadsLib.cfg</button>
			</div>
			{se.roadsPath && <div className="muted" title={se.roadsPath}>Roads: {se.roadsPath.split(/[\\/]/).pop()} ({se.roads.size} types)</div>}
			</>}
			{part === "props" && !s && <div className="muted">Select a shape in the list on the left, or draw one with the ribbon (New line, New polygon, New point).</div>}
			{part === "props" && s && (
				<>
					<label className="field-row">Name <input value={s.name} onChange={(e) => text((x) => (x.name = e.target.value))} /></label>
					<label className="field-row" title="The SHP export writes one file for each group">Group <input value={s.group} onChange={(e) => text((x) => (x.group = e.target.value))} /></label>
					{s.kind !== "point" && <label title="A smooth curve through the points"><input type="checkbox" checked={s.smooth} onChange={(e) => change((x) => (x.smooth = e.target.checked))} />Smooth curve</label>}
					{s.kind === "line" && <label><input type="checkbox" checked={s.closed} onChange={(e) => change((x) => (x.closed = e.target.checked))} />Closed loop</label>}
					<div className="muted">Properties (DBF fields, for example ID for roads):</div>
					{s.props.map(([k, v], i) => (
						<div key={i} className="row">
							<input className="key" value={k} onChange={(e) => text((x) => (x.props[i] = [e.target.value, x.props[i][1]]))} />
							<input className="name" value={v} onChange={(e) => text((x) => (x.props[i] = [x.props[i][0], e.target.value]))} />
							<button onClick={() => change((x) => x.props.splice(i, 1), false)}>✕</button>
						</div>
					))}
					<button onClick={() => change((x) => x.props.push([x.props.some((p) => p[0] === "ID") ? "name" : "ID", ""]), false)}><Icon name="add-line" /> Add property</button>
					{s.kind === "line" && (
						<>
							<label title="Objects along the line"><input type="checkbox" checked={!!s.spline} onChange={(e) => change((x) => (x.spline = e.target.checked ? newSpline("Fence", shown ?? "") : undefined))} />Objects along the line</label>
							{s.spline && (() => {
								const sp = s.spline;
								const set = (c: Partial<typeof sp>) => change((x) => Object.assign(x.spline!, c));
								return (
									<>
										<label className="field-row">Preset <select value={sp.preset} onChange={(e) => set({ preset: e.target.value, ...PRESETS[e.target.value] })}>{Object.keys(PRESETS).map((p) => <option key={p}>{p}</option>)}</select></label>
										<div className="row"><span className="name" title={sp.model}>{sp.model || "No model"}</span><button disabled={!shown || shown === sp.model} onClick={() => set({ model: shown })} title="Use the model of the preview in the model panel">Use {shown ?? "model"}</button></div>
										<label title="The spacing is the model length (fences, walls)"><input type="checkbox" checked={sp.useLength} onChange={(e) => set({ useLength: e.target.checked })} />Spacing = model length</label>
										{!sp.useLength && <label className="field-row">Spacing m {num(sp.spacing, (v) => set({ spacing: Math.max(0.1, v) }), 0.5)}</label>}
										<label className="field-row">Yaw offset ° {num(sp.yaw, (v) => set({ yaw: v }), 15)}</label>
										<label className="field-row" title="Distance from the line to the right side, in meters">Side offset m {num(sp.side, (v) => set({ side: v }), 0.5)}</label>
										<label title="A second row on the other side"><input type="checkbox" checked={sp.twoRows} onChange={(e) => set({ twoRows: e.target.checked })} />Two rows</label>
										<label className="field-row">Jitter m {num(sp.jitter, (v) => set({ jitter: Math.max(0, v) }), 0.1)}</label>
										<label title="The objects tilt with the terrain along the line"><input type="checkbox" checked={sp.conform} onChange={(e) => set({ conform: e.target.checked })} />Conform to terrain</label>
										<label className="field-row">Seed {num(sp.seed, (v) => set({ seed: Math.max(0, Math.round(v)) }))}</label>
									</>
								);
							})()}
						</>
					)}
					{s.kind !== "point" && (
						<>
							<b className="sub">Actions</b>
							{s.kind === "polygon" && <button onClick={scatter} title="Fill the polygon with the recipe and the rules of the Object fill panel (into the active layer)">Scatter (fill recipe)</button>}
							{s.kind === "line" && (
								<div className="row">
									<label className="field-row">Width m {num(act.maskWidth, (v) => setAct({ ...act, maskWidth: Math.max(0.5, v) }), 0.5)}</label>
									<label className="field-row">Feather {num(act.maskFeather, (v) => setAct({ ...act, maskFeather: Math.max(0, v) }), 0.5)}</label>
								</div>
							)}
							<button disabled={!mask} onClick={paintMask} title="Paint the selected mask layer of the Paint tab. Undo: Ctrl+Z in the Paint tab.">{s.kind === "polygon" ? "Paint mask inside" : "Paint mask along"}{mask ? `: ${mask.names[mv.color]}` : ""}</button>
							{s.kind === "polygon" ? (
								<label className="field-row" title="Empty: the mean height inside">Height m <input type="number" placeholder="mean" value={act.flatten} onChange={(e) => setAct({ ...act, flatten: e.target.value })} /></label>
							) : (
								<>
									<label className="field-row" title="Full change up to this distance from the centre line (half the road width; a road type gives it)">Range from centre m {num(act.range, (v) => setAct({ ...act, range: Math.max(0, v) }), 0.5)}</label>
									<label className="field-row" title="The height of the centre line is the mean over this distance">Smooth along m {num(act.smooth, (v) => setAct({ ...act, smooth: Math.max(0, v) }), 5)}</label>
									<label className="field-row" title="The steepest grade along the road in percent. 0: no limit.">Max slope % {num(act.slope, (v) => setAct({ ...act, slope: Math.max(0, v) }), 1)}</label>
									<label className="field-row" title="The cross slope that stays, in percent. 0: flat across the road. Higher values keep more of the terrain slope across the road.">Max tilt % {num(act.tilt, (v) => setAct({ ...act, tilt: Math.max(0, v) }), 1)}</label>
								</>
							)}
							<label className="field-row" title="The change falls to 0 across this distance">Feather m {num(act.feather, (v) => setAct({ ...act, feather: Math.max(0, v) }), 1)}</label>
							<button disabled={!terrain} onClick={terrainAction} title="Undo: Ctrl+Z in the 3D view">{s.kind === "polygon" ? "Flatten inside" : `Smooth terrain under ${se.selectedShapes().filter((x) => x.kind === "line").length} road(s)`}</button>
						</>
					)}
					<button onClick={() => (se.remove(s.id), redraw())} title="Delete the shape and its spline objects (Ctrl+Z gives them back)"><Icon name="delete-bin-line" /> Delete shape</button>
				</>
			)}
		</div>
	);
}
