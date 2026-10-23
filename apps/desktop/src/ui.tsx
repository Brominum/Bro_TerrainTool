// Small UI parts: Remix Icon icons (https://remixicon.com) and tool bar buttons.
import { useEffect, useState, type ReactNode } from "react";

export const Icon = ({ name }: { name: string }) => <i className={`ri-${name}`} aria-hidden="true" />;

// Tool bar button: the icon only. The tooltip gives the name and the key.
export function Tool({ icon, title, on, disabled, onClick }: { icon: string; title: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button className={`tool${on ? " on" : ""}`} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onClick={onClick}>
			<Icon name={icon} />
		</button>
	);
}

// Panel button: an icon and a text.
export function Btn({ icon, children, title, on, disabled, onClick }: { icon: string; children: ReactNode; title?: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button className={on ? "on" : ""} title={title} disabled={disabled} onClick={onClick}>
			<Icon name={icon} /> {children}
		</button>
	);
}

// A thin line between groups of tool bar buttons.
export const Sep = () => <span className="sep" />;

// Ribbon button: a large icon with its name below. The tooltip gives more help and the key.
export function RBtn({ icon, label, title, on, disabled, onClick }: { icon: string; label: string; title?: string; on?: boolean; disabled?: boolean; onClick: () => void }) {
	return (
		<button className={`rb${on ? " on" : ""}`} title={title ?? label} aria-pressed={on} disabled={disabled} onClick={onClick}>
			<Icon name={icon} />
			<span>{label}</span>
		</button>
	);
}

// A group of the ribbon with its name below.
export const Group = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="rgroup">
		<div className="ritems">{children}</div>
		<div className="rcap">{label}</div>
	</div>
);

// The ribbon tabs in the order of the work. Ctrl+1 to Ctrl+5 select them. The viewport settings are in a panel at the bottom.
export const STAGES = [
	{ id: "terrain", name: "Map data", icon: "landscape-line", help: "Map folder, new map, import of the heightmap, satellite image, and mask, heightmap brushes" },
	{ id: "objects", name: "Objects", icon: "tree-line", help: "Object import, placement, layers, object fill, and scatter brush" },
	{ id: "shapes", name: "Shapes", icon: "road-map-line", help: "Roads, shapes, splines, and SHP files" },
	{ id: "imagery", name: "Paint", icon: "paint-brush-line", help: "Paint the mask and the satellite image" },
	{ id: "export", name: "Export", icon: "upload-2-line", help: "Tiles, RVMAT files, WRP, and roads.shp for the game" },
] as const;
export type Stage = (typeof STAGES)[number]["id"];

// A number field that keeps the text while the user types (for example "-" or "1."). It sends only valid numbers.
export function NumInput({ value, onChange, step, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
	const [text, setText] = useState(String(value));
	useEffect(() => {
		if (Number(text) !== value) setText(String(value));
	}, [value]);
	return (
		<input
			type="number"
			step={step}
			min={min}
			max={max}
			value={text}
			onChange={(e) => {
				setText(e.target.value);
				const v = Number(e.target.value);
				if (e.target.value.trim() !== "" && Number.isFinite(v)) onChange(v);
			}}
		/>
	);
}
