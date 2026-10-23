import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "remixicon/fonts/remixicon.css";
import "./styles.css";

// Without this, an error during start or render gives an empty window. It shows the error and lets the user clear the saved settings.
class Crash extends Component<{ children: ReactNode }, { error?: unknown }> {
	state: { error?: unknown } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	render() {
		const e = this.state.error;
		if (e === undefined) return this.props.children;
		const reset = () => {
			for (const k of Object.keys(localStorage)) if (k.startsWith("terrainTool.")) localStorage.removeItem(k);
			location.reload();
		};
		return (
			<div style={{ padding: 24, color: "#ddd", font: "14px sans-serif", whiteSpace: "pre-wrap" }}>
				<h3>Terrain Tool stopped with an error</h3>
				<code>{e instanceof Error ? `${e.message}\n\n${e.stack}` : String(e)}</code>
				<p>
					<button onClick={() => location.reload()}>Reload</button> <button onClick={reset}>Clear the saved settings and reload</button>
				</p>
			</div>
		);
	}
}
createRoot(document.getElementById("root")!).render(
	<Crash>
		<App />
	</Crash>,
);
