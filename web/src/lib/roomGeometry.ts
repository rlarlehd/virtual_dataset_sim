import * as THREE from 'three'
import type { Layout, TextureAsset } from '../types/project'

// 일반 다각형 방(수직벽 프리즘)을 Three.js Group 으로 만든다.
// 바닥/천장 텍스처는 footprint bbox 기준, 벽 텍스처는 edge 별로 매핑한다.
// Python generate_textures.py 의 격자 규약과 맞추기 위해 flipY=false 사용.

function loadTex(url: string): THREE.Texture {
  const t = new THREE.TextureLoader().load(url)
  t.flipY = false
  t.colorSpace = THREE.SRGBColorSpace
  t.minFilter = THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  // NPOT 텍스처 안전(REPEAT면 GLB/뷰어에서 검게 나옴) → CLAMP
  t.wrapS = THREE.ClampToEdgeWrapping
  t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

function texByName(textures: TextureAsset[], name: string): THREE.Texture | null {
  const a = textures.find((t) => t.name === name)
  return a ? loadTex(a.url) : null
}

function basicMat(map: THREE.Texture | null, fallback = 0x888888): THREE.Material {
  return new THREE.MeshBasicMaterial({
    map: map ?? undefined,
    color: map ? 0xffffff : fallback,
    side: THREE.DoubleSide,
  })
}

// 수평면(바닥/천장) 폴리곤 메쉬 — bbox 기준 UV
function horizontalMesh(layout: Layout, y: number, map: THREE.Texture | null): THREE.Mesh {
  const fp = layout.footprint
  const xs = fp.map((p) => p[0]), zs = fp.map((p) => p[1])
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const zmin = Math.min(...zs), zmax = Math.max(...zs)
  const W = xmax - xmin || 1, D = zmax - zmin || 1

  const shape = new THREE.Shape()
  fp.forEach((p, i) => { if (i === 0) shape.moveTo(p[0], p[1]); else shape.lineTo(p[0], p[1]) })
  shape.closePath()
  const geo = new THREE.ShapeGeometry(shape)

  // ShapeGeometry 정점은 (x, z, 0). UV 를 텍스처 규약(u=(x-xmin)/W, v=(zmax-z)/D)에 맞춤
  const pos = geo.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getY(i)
    uv[i * 2] = (x - xmin) / W
    uv[i * 2 + 1] = (zmax - z) / D
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.rotateX(Math.PI / 2)   // (x,z,0) -> (x,0,z)
  geo.translate(0, y, 0)

  return new THREE.Mesh(geo, basicMat(map, 0x666666))
}

// 수직벽 quad (edge i: A->B, y=0..H)
function wallMesh(layout: Layout, i: number, map: THREE.Texture | null): THREE.Mesh {
  const fp = layout.footprint
  const A = fp[i], B = fp[(i + 1) % fp.length]
  const H = layout.height
  const ax = A[0], az = A[1], bx = B[0], bz = B[1]
  const verts = new Float32Array([
    ax, H, az,   // 0 A-top
    bx, H, bz,   // 1 B-top
    bx, 0, bz,   // 2 B-bottom
    ax, 0, az,   // 3 A-bottom
  ])
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
  ])
  const idx = [0, 1, 2, 0, 2, 3]
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return new THREE.Mesh(geo, basicMat(map, 0x808080))
}

export function buildRoomGroup(
  layout: Layout, textures: TextureAsset[], skipWalls: number[] = [],
): THREE.Group {
  const g = new THREE.Group()
  const floorMesh = horizontalMesh(layout, 0, texByName(textures, 'floor'))
  floorMesh.name = 'floor'
  g.add(floorMesh)
  const ceilMesh = horizontalMesh(layout, layout.height, texByName(textures, 'ceiling'))
  ceilMesh.name = 'ceiling'
  g.add(ceilMesh)
  // skipWalls 에 든 edge 는 벽을 만들지 않는다(파노라마 좌우 seam 가로지르는 변 등).
  const skip = new Set(skipWalls)
  const n = layout.footprint.length
  for (let i = 0; i < n; i++) {
    if (skip.has(i)) continue
    const mesh = wallMesh(layout, i, texByName(textures, `wall_${i}`))
    mesh.name = `wall_${i}`
    g.add(mesh)
  }
  return g
}

// yaw/pitch/roll(deg) -> THREE.Euler. Python rotation_matrix(Ry@Rx@Rz)와 동일 순서.
export function eulerFromYawPitchRoll(yawDeg: number, pitchDeg: number, rollDeg: number): THREE.Euler {
  return new THREE.Euler(
    THREE.MathUtils.degToRad(pitchDeg),
    THREE.MathUtils.degToRad(yawDeg),
    THREE.MathUtils.degToRad(rollDeg),
    'YXZ',
  )
}
