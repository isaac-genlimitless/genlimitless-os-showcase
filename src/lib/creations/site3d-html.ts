// 3D view of a site plan: one self-contained HTML page (three.js from the CDN, like the Dreamhouse),
// served under a sandbox CSP so it runs isolated from the OS origin. Data is embedded as escaped JSON.
import { layoutPlan, USE_COLOR, USE_LABEL, type SitePlan } from "./models/site-plan";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function buildSite3dHtml(title: string, plan: SitePlan): string {
  const layout = layoutPlan(plan);
  // JSON inside <script>: escape "<" so no "</script>" can close the tag early.
  const data = JSON.stringify({ layout, colors: USE_COLOR, labels: USE_LABEL }).replace(/</g, "\\u003c");
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(title) + "</title>",
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#eef1ea;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1c1a}",
    "canvas{display:block}#hud{position:fixed;left:12px;top:10px;font-size:13px;background:rgba(255,255,255,.88);padding:8px 10px;border-radius:10px;max-width:60vw}",
    "#hud b{display:block;font-size:15px;margin-bottom:4px}.k{display:inline-flex;align-items:center;gap:5px;margin-right:10px;white-space:nowrap}",
    ".k i{width:10px;height:10px;border-radius:2px;display:inline-block}#tip{position:fixed;pointer-events:none;background:#1c1c1a;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;display:none}",
    "#warn{color:#b3261e;font-weight:600;margin-top:4px}</style>",
    '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>',
    "</head><body><div id=\"hud\"><b>" + esc(title) + "</b><div id=\"legend\"></div>" + (layout.fits ? "" : '<div id="warn">Doesn\'t fit on the lot as laid out</div>') + "<div style=\"opacity:.7;margin-top:4px\">Drag to orbit · scroll to zoom · hover a block</div></div><div id=\"tip\"></div>",
    '<script id="site-data" type="application/json">' + data + "</script>",
    '<script type="module">',
    'import * as THREE from "three";',
    'import { OrbitControls } from "three/addons/controls/OrbitControls.js";',
    'const D = JSON.parse(document.getElementById("site-data").textContent);',
    "const L = D.layout;",
    'const legend = document.getElementById("legend");',
    "const seen = new Set(L.rects.map(r => r.use));",
    "for (const u of Object.keys(D.colors)) { if (!seen.has(u)) continue; const s = document.createElement(\"span\"); s.className = \"k\"; const i = document.createElement(\"i\"); i.style.background = D.colors[u]; s.append(i, document.createTextNode(D.labels[u])); legend.append(s); }",
    "const scene = new THREE.Scene(); scene.background = new THREE.Color(0xeef1ea);",
    "const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(innerWidth, innerHeight); document.body.append(renderer.domElement);",
    "const span = Math.max(L.lot.w, L.lot.d);",
    "const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, span * 20);",
    "camera.position.set(L.lot.w * 0.5, span * 0.75, L.lot.d * 1.35);",
    "const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(L.lot.w / 2, 0, L.lot.d / 2); controls.maxPolarAngle = Math.PI * 0.48; controls.update();",
    "scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a7a, 1.6));",
    "const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-span, span * 1.5, span * 0.6); scene.add(sun);",
    "const lot = new THREE.Mesh(new THREE.PlaneGeometry(L.lot.w, L.lot.d), new THREE.MeshLambertMaterial({ color: 0xc9d8b6 }));",
    "lot.rotation.x = -Math.PI / 2; lot.position.set(L.lot.w / 2, 0, L.lot.d / 2); scene.add(lot);",
    "const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L.lot.w, 0.1, L.lot.d)), new THREE.LineBasicMaterial({ color: 0x5b6b4a }));",
    "edge.position.set(L.lot.w / 2, 0.05, L.lot.d / 2); scene.add(edge);",
    "const pickable = [];",
    "for (const r of L.rects) {",
    "  const h = r.indoor ? 18 : (r.use === \"parking\" ? 0.6 : 1.2);",
    "  const gap = r.indoor ? 1 : 0;",
    "  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1, r.w - gap), h, Math.max(1, r.d - gap)), new THREE.MeshStandardMaterial({ color: D.colors[r.use], roughness: 0.75 }));",
    "  m.position.set(r.x + r.w / 2, h / 2, r.y + r.d / 2); m.userData = r; scene.add(m); pickable.push(m);",
    "  if (r.indoor) { const roof = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })); roof.position.copy(m.position); scene.add(roof); }",
    "}",
    "const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2(); const tip = document.getElementById(\"tip\");",
    "addEventListener(\"pointermove\", (e) => { mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouse, camera); const hit = ray.intersectObjects(pickable)[0];",
    "  if (hit) { const r = hit.object.userData; tip.textContent = r.label + \" · \" + Math.round(r.w * r.d).toLocaleString() + \" sq ft\"; tip.style.display = \"block\"; tip.style.left = (e.clientX + 12) + \"px\"; tip.style.top = (e.clientY + 12) + \"px\"; } else tip.style.display = \"none\"; });",
    "addEventListener(\"resize\", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });",
    "renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });",
    "</script></body></html>",
  ].join("\n");
}
