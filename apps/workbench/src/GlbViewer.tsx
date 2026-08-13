import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function GlbViewer(input: { blob: Blob; onSelect: (entityId: string | null) => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5f3);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10_000);
    camera.position.set(5, -6, 4);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6d766d, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(4, -3, 7);
    scene.add(light);
    const grid = new THREE.GridHelper(10, 20, 0xb4bab5, 0xd9ddda);
    scene.add(grid);
    let root: THREE.Object3D | null = null;
    let disposed = false;
    let frame = 0;
    const resize = () => {
      const width = Math.max(container.clientWidth, 320);
      const height = Math.max(container.clientHeight, 360);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const url = URL.createObjectURL(input.blob);
    container.dataset.viewerState = "loading";
    new GLTFLoader().load(url, (gltf) => {
      if (disposed) return;
      root = gltf.scene;
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const previous = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of previous) material.dispose();
        const seed = [...object.name].reduce((value, character) => value + character.charCodeAt(0), 0);
        const color = new THREE.Color().setHSL((seed % 37) / 37, 0.22, 0.58);
        object.material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(object.geometry, 24),
          new THREE.LineBasicMaterial({ color: 0x39413d }),
        );
        edges.raycast = () => undefined;
        object.add(edges);
      });
      scene.add(root);
      const bounds = new THREE.Box3().setFromObject(root);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, 1);
      const distance = span * 1.8;
      camera.near = Math.max(span / 10_000, 0.01);
      camera.far = distance * 10;
      camera.updateProjectionMatrix();
      camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
      controls.target.copy(center);
      controls.minDistance = span * 0.15;
      controls.maxDistance = distance * 4;
      grid.scale.setScalar(span / 10);
      grid.position.set(center.x, bounds.min.y, center.z);
      controls.update();
      container.dataset.viewerState = `loaded:${span.toFixed(3)}`;
    }, undefined, (error) => {
      container.dataset.viewerState = `error:${String(error)}`;
    });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const click = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = root ? raycaster.intersectObject(root, true)[0] : undefined;
      if (!hit) return input.onSelect(null);
      let current: THREE.Object3D | null = hit.object;
      while (current && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(current.name)) current = current.parent;
      input.onSelect(current?.name ?? null);
    };
    renderer.domElement.addEventListener("click", click);
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("click", click);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      renderer.dispose();
      URL.revokeObjectURL(url);
      renderer.domElement.remove();
    };
  }, [input.blob, input.onSelect]);

  return <div className="glb-viewer" ref={host} aria-label="GLB 三维模型查看器" />;
}
