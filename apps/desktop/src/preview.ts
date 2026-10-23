// Model preview: one model on a turntable. Drag to turn, wheel to zoom.
import * as THREE from "three";
import { fogUniforms, groundUniforms } from "./env";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Model } from "./models";

export class Preview {
	private renderer: THREE.WebGLRenderer;
	private scene = new THREE.Scene();
	private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
	private controls: OrbitControls;
	private current?: THREE.Object3D;

	constructor(private canvas: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.scene.background = new THREE.Color(0x3a4048);
		this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
		const sun = new THREE.DirectionalLight(0xffffff, 2);
		sun.position.set(0.4, 0.8, 0.3);
		this.scene.add(sun);
		this.scene.add(new THREE.GridHelper(20, 20, 0x666666, 0x4a4a4a));
		this.controls = new OrbitControls(this.camera, canvas);
		this.camera.position.set(4, 3, 6);
		new ResizeObserver(() => this.resize()).observe(canvas);
		this.resize();
		this.renderer.setAnimationLoop(() => {
			this.controls.update();
			// The models share their materials with the 3D view. The preview has no fog.
			const k = fogUniforms.uFogK.value;
			fogUniforms.uFogK.value = 0;
			// No terrain in the preview: the height texture would go to the GPU a second time (another WebGL context).
			const hTex = groundUniforms.uGHeight.value;
			groundUniforms.uGOn.value = 0;
			groundUniforms.uGHeight.value = null;
			this.renderer.render(this.scene, this.camera);
			groundUniforms.uGHeight.value = hTex;
			fogUniforms.uFogK.value = k;
			groundUniforms.uGOn.value = 1;
		});
	}

	show(m: Model) {
		if (this.current) this.scene.remove(this.current);
		this.current = new THREE.Mesh(m.geometry, m.materials);
		this.scene.add(this.current);
		const s = m.geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 2);
		this.controls.target.copy(s.center);
		const d = Math.max(1, s.radius) * 2.6;
		this.camera.position.copy(s.center).add(new THREE.Vector3(0.6, 0.45, 0.8).multiplyScalar(d));
		this.camera.far = d * 20;
		this.camera.updateProjectionMatrix();
	}

	private resize() {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}
}
