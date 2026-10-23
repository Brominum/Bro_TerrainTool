// Post effects of the 3D view: ambient occlusion (GTAO) and bloom. Each one can be off. There is no tone mapping (the user's choice).
// The scene renders into one target with a depth texture. GTAO reads that depth (the normals come from the depth), because its own
// normal pass would draw the terrain flat: the terrain gets its heights in the vertex shader.
import * as THREE from "three";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export interface PostSettings {
	ao: boolean;
	bloom: boolean;
}

export class Post {
	private scene: THREE.WebGLRenderTarget;
	private mid: THREE.WebGLRenderTarget;
	private ao?: GTAOPass;
	private bloom?: UnrealBloomPass;
	private out = new OutputPass();
	private size = new THREE.Vector2(1, 1);

	constructor(private renderer: THREE.WebGLRenderer, private world: THREE.Scene, private camera: THREE.PerspectiveCamera) {
		this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1) });
		this.mid = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
		this.out.renderToScreen = true;
	}

	setSize(w: number, h: number) {
		this.size.set(w, h);
		this.scene.setSize(w, h);
		this.mid.setSize(w, h);
		// The ambient occlusion works at half the size (it is soft), so it costs less.
		this.ao?.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
		this.bloom?.setSize(w, h);
	}

	// Draw one frame. Without effects the scene goes straight to the screen.
	// `view` is the camera that draws. The ambient occlusion always uses the perspective camera of the constructor.
	render(s: PostSettings, view: THREE.Camera = this.camera) {
		const r = this.renderer;
		if (!s.ao && !s.bloom) {
			r.setRenderTarget(null);
			r.render(this.world, view);
			return;
		}
		r.setRenderTarget(this.scene);
		r.clear();
		r.render(this.world, view);
		let read = this.scene;
		if (s.ao) {
			if (!this.ao) {
				this.ao = new GTAOPass(this.world, this.camera, Math.ceil(this.size.x / 2), Math.ceil(this.size.y / 2));
				// setGBuffer with a depth texture needs the normal target of the first call (three r186), so it comes after the constructor.
				this.ao.setGBuffer(this.scene.depthTexture!, undefined);
				// Radius in meters: the contact shadows under trees, walls, and in small valleys.
				this.ao.updateGtaoMaterial({ radius: 4, distanceExponent: 1.5, thickness: 4, scale: 1.2, samples: 16, distanceFallOff: 1 });
				this.ao.blendIntensity = 0.85;
				// Far away the depth is too coarse for the normals that GTAO makes from it (blotches on far hills), so the AO fades out from 250 to 600 m.
				this.ao.gtaoMaterial.defines.FRAGMENT_OUTPUT = "vec4(vec3(mix(ao, 1., smoothstep(250., 600., -viewPos.z))), 1.)";
				this.ao.gtaoMaterial.needsUpdate = true;
			}
			this.ao.render(r, this.mid, read, 0, false);
			read = this.mid;
		}
		if (s.bloom) {
			if (!this.bloom) {
				// A small bloom: only the bright parts (sky near the sun, bright sand, lit roofs) glow a little.
				this.bloom = new UnrealBloomPass(this.size.clone(), 0.09, 0.5, 0.92);
				this.bloom.setSize(this.size.x, this.size.y);
			}
			// The bloom adds its glow into the input target.
			this.bloom.render(r, read, read, 0, false);
		}
		this.out.render(r, null!, read, 0, false);
	}
}
