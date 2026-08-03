import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { useStore } from '../store/projectStore'
import { buildRoomGroup, eulerFromYawPitchRoll } from '../lib/roomGeometry'

// 가상 카메라 시점에서 Box Room 을 실시간 렌더(Three.js 경로).
//  - 캔버스 드래그: 시선 회전(yaw/pitch)
//  - WASD: 이동, Q/E: 위아래(자유비행), Ctrl: 가속
//  - 메쉬 클릭: '바닥(보행가능구간)' 지정/해제 (초록 와이어프레임)
//  - 보행 모드: 카메라가 지정 바닥 위 눈높이에 붙어 그 구간 안에서만 이동
const DOWN = new THREE.Vector3(0, -1, 0)
const EYE_HEIGHT = 1.6

// ── 투영 GT 공용 헬퍼 ──
// 객체의 월드 AABB 8꼭짓점을 카메라로 투영해 정규화 화면좌표(0..1, y는 아래방향) bbox 로 돌려준다.
// 중심이 카메라 뒤면 null. (drawGT 오버레이 · crop 추출 양쪽에서 사용)
const _scratchBox = new THREE.Box3()
const _scratchV = new THREE.Vector3()
const _scratchFwd = new THREE.Vector3()
const _scratchC = new THREE.Vector3()
function projectBoxNDC(
  cam: THREE.PerspectiveCamera, obj: THREE.Object3D,
): { minx: number; miny: number; maxx: number; maxy: number } | null {
  _scratchBox.setFromObject(obj)
  if (_scratchBox.isEmpty()) return null
  cam.getWorldDirection(_scratchFwd)
  _scratchBox.getCenter(_scratchC)
  if (_scratchC.sub(cam.position).dot(_scratchFwd) <= 0) return null   // 카메라 뒤
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9
  for (let c = 0; c < 8; c++) {
    _scratchV.set(c & 1 ? _scratchBox.max.x : _scratchBox.min.x,
                  c & 2 ? _scratchBox.max.y : _scratchBox.min.y,
                  c & 4 ? _scratchBox.max.z : _scratchBox.min.z).project(cam)
    const nx = _scratchV.x * 0.5 + 0.5, ny = -_scratchV.y * 0.5 + 0.5
    if (nx < minx) minx = nx; if (nx > maxx) maxx = nx
    if (ny < miny) miny = ny; if (ny > maxy) maxy = ny
  }
  return { minx, miny, maxx, maxy }
}

// ── 주 동선(path) 공용 헬퍼 ──
// 동선 = 바닥 위 (x,z) 점들의 폴리라인. 사람은 첫 점→마지막 점 방향으로 주로 이동한다.
type Vec2 = [number, number]
function pathTotalLength(path: Vec2[]): number {
  let L = 0
  for (let i = 0; i < path.length - 1; i++) {
    L += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
  }
  return L
}
// 시작점에서 호길이 d 만큼 진행한 (x,z)+진행방향 heading(atan2(dx,dz)).
function pointAtDist(path: Vec2[], d: number): { x: number; z: number; heading: number } {
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1][0] - path[i][0], dz = path[i + 1][1] - path[i][1]
    const seg = Math.hypot(dx, dz) || 1e-9
    if (d <= seg || i === path.length - 2) {
      const t = Math.max(0, Math.min(1, d / seg))
      return { x: path[i][0] + dx * t, z: path[i][1] + dz * t, heading: Math.atan2(dx, dz) }
    }
    d -= seg
  }
  const last = path[path.length - 1]
  return { x: last[0], z: last[1], heading: 0 }
}

// ── 신원 로스터: pid 파생 + 결정적 특성 ──
// 파일명 → pid. 마지막 숫자 + 접두(네임스페이스) 해시를 합쳐 접두가 다르면 pid도 다름.
//  예) run_person_0001 ≠ walk_person_0001. 같은 파일명은 항상 같은 pid(맵·순서 무관).
function pidFromName(name: string, fallback: number): number {
  const stem = name.replace(/\.(glb|gltf)$/i, '')
  const groups = stem.match(/\d+/g)
  const num = (groups && groups.length ? parseInt(groups[groups.length - 1], 10) : fallback) % 100000
  const ns = stem.replace(/\d+(?=\D*$)/, '')   // 마지막 숫자 제거 → 접두부(run_person_ 등)
  const nsHash = hashStr(ns) % 10000            // 네임스페이스 0..9999
  return nsHash * 100000 + num                  // 접두 다르면 pid 공간 분리
}
// 문자열 해시(32bit) — 재질명별 색 분산용
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
// mulberry32: pid 로 시드한 결정적 난수 → 같은 pid = 항상 같은 옷 색/특성(모든 맵 동일)
function seededRand(seed: number): () => number {
  let a = (seed >>> 0) + 0x6d2b79f5
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// MPFB/MakeHuman GLB 재질의 알파 블렌딩 때문에 피부가 비쳐 보이는 문제 수정.
// 속눈썹/눈썹만 알파 컷아웃(alphaTest), 나머지(피부/얼굴/이빨/눈/옷/헤어)는 전부 불투명 강제.
function fixMpfbTransparency(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    mats.forEach((m) => {
      const ud = (o.userData?.object_type as string) ?? ''
      const name = `${o.name} ${ud} ${m.name ?? ''}`.toLowerCase()
      const std = m as THREE.MeshStandardMaterial
      if (/eyelash|eyebrow|brow|lash/.test(name)) {
        std.transparent = false; std.alphaTest = 0.5; std.depthWrite = true; std.side = THREE.DoubleSide
      } else {
        std.transparent = false; std.alphaTest = 0; std.opacity = 1; std.depthWrite = true
      }
      std.needsUpdate = true
    })
  })
}

// ── 랜덤 의상(옷 색 재색칠) 공용 헬퍼 ──
// Mixamo 캐릭터는 피부+옷이 body diffuse 한 장에 구워져 있음.
// 옷(채도 높은 픽셀)만 hue 회전, 피부/머리카락(무채색·피부톤)은 보호 → 인스턴스별 옷 색 다양화.
function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h = 0
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (mx === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
}
// 피부/입술/눈 보호 판정: 붉은~노랑(−40°~60°) 중 과채도 아닌 것 (실제 텍스처로 튜닝)
function isSkinTone(h: number, s: number, l: number): boolean {
  const deg = h * 360
  return (deg >= 320 || deg <= 60) && s <= 0.80 && l >= 0.12 && l <= 0.97
}
// 재질 이름으로 부위 분류 (MPFB 명명 기반)
function classifyMat(name: string): 'hair' | 'clothes' | 'skip' {
  const n = name.toLowerCase()
  if (n.includes('hair')) return 'hair'
  if (/body|high-?poly|base|eye|brow|lash|teeth|tongue|cornea|nail|mouth|gum/.test(n)) return 'skip' // 피부/얼굴 → 유지
  return 'clothes'   // 셔츠/바지/치마/신발/자켓 등
}

// diffuse 를 (목표 hue, 채도, 밝기)로 재색칠. 밝기는 tgtL 로 이동하되 texKeep 만큼 원본 명암 보존(주름/음영).
//  · all=true: 모든 픽셀(옷/머리 메쉬 통째로) — MPFB 처럼 옷이 별도 메쉬일 때
//  · all=false: 채도 높은 비피부 픽셀만 (피부+옷 한 장 텍스처 대비 안전장치)
function recolorRegion(
  image: CanvasImageSource, hueTarget: number, satTarget: number,
  all: boolean, tgtL: number, texKeep: number,
): HTMLCanvasElement | null {
  const dim = image as { width?: number; height?: number }
  const w = typeof dim.width === 'number' ? dim.width : 0
  const h = typeof dim.height === 'number' ? dim.height : 0
  if (!w || !h) return null
  // 대형 diffuse 는 1024 로 다운스케일(픽셀루프/ GPU메모리 절감, CCTV용도엔 충분)
  const MAX = 1024
  const scale = Math.min(1, MAX / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale))
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, cw, ch)
  let id: ImageData
  try { id = ctx.getImageData(0, 0, cw, ch) } catch { return null }
  const d = id.data
  for (let p = 0; p < d.length; p += 4) {
    const [hh, ss, ll] = rgb2hsl(d[p] / 255, d[p + 1] / 255, d[p + 2] / 255)
    if (!all) {
      if (ss < 0.22) continue
      if (isSkinTone(hh, ss, ll)) continue
    }
    let l2 = tgtL * (1 - texKeep) + ll * texKeep   // 목표 밝기로 이동 + 원본 명암 일부 유지
    if (l2 < 0) l2 = 0; else if (l2 > 1) l2 = 1
    const [r, g, b] = hsl2rgb(hueTarget, satTarget, l2)
    d[p] = r * 255; d[p + 1] = g * 255; d[p + 2] = b * 255
  }
  ctx.putImageData(id, 0, 0)
  return cv
}

// crop 열화: 실제 CCTV 영상에서 딴 것처럼 해상도 손실 + 블러 + 밝기/대비 변동 + 센서 노이즈 + JPEG 압축.
// 반환은 image/jpeg dataURL. (crop 마다 랜덤 강도 → 다양성)
function degradeCrop(src: HTMLCanvasElement): string {
  const w = src.width, h = src.height
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
  // 1) 다운스케일 → 업스케일 (해상도 손실/블러의 근원)
  const ds = 0.45 + Math.random() * 0.35                 // 0.45~0.8 배로 줄였다 되돌림
  const lw = Math.max(1, Math.round(w * ds)), lh = Math.max(1, Math.round(h * ds))
  const small = document.createElement('canvas'); small.width = lw; small.height = lh
  small.getContext('2d')!.drawImage(src, 0, 0, lw, lh)
  // 2) 원 크기로 복원(+ 약한 블러·밝기·대비 변동)
  const out = document.createElement('canvas'); out.width = w; out.height = h
  const octx = out.getContext('2d', { willReadFrequently: true })!
  const bright = 0.9 + Math.random() * 0.2, contrast = 0.88 + Math.random() * 0.24
  octx.filter = `blur(0.5px) brightness(${bright.toFixed(3)}) contrast(${contrast.toFixed(3)})`
  octx.drawImage(small, 0, 0, w, h)
  octx.filter = 'none'
  // 3) 센서 노이즈
  try {
    const id = octx.getImageData(0, 0, w, h); const d = id.data
    const amp = 5 + Math.random() * 12
    for (let p = 0; p < d.length; p += 4) {
      const n = (Math.random() - 0.5) * amp
      d[p] = clamp(d[p] + n); d[p + 1] = clamp(d[p + 1] + n); d[p + 2] = clamp(d[p + 2] + n)
    }
    octx.putImageData(id, 0, 0)
  } catch { /* tainted 등 → 노이즈 스킵 */ }
  // 4) JPEG 압축 아티팩트(품질 랜덤)
  return out.toDataURL('image/jpeg', 0.45 + Math.random() * 0.3)   // 품질 0.45~0.75
}

export function ThreeRoomViewer() {
  const layout = useStore((s) => s.layout)
  const textures = useStore((s) => s.textures)
  const camera = useStore((s) => s.camera)
  const setCamera = useStore((s) => s.setCamera)
  const setLayout = useStore((s) => s.setLayout)
  const setTextures = useStore((s) => s.setTextures)
  const annotation = useStore((s) => s.annotation)
  const image = useStore((s) => s.image)

  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const camRef = useRef<THREE.PerspectiveCamera | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const keysRef = useRef<Set<string>>(new Set())
  const camStateRef = useRef(camera)
  const floorMeshesRef = useRef<Set<THREE.Mesh>>(new Set())
  const overlayRef = useRef<Map<THREE.Mesh, THREE.Mesh>>(new Map())
  const walkRef = useRef(false)
  const rayRef = useRef(new THREE.Raycaster())
  // 걷는 사람들 GLB (여러 명). id=템플릿 종류, pid=인스턴스 고유 신원ID(ReID/crop 라벨)
  // pathIdx=배정된 동선(-1=미배정), dist=진행 호길이, lateral=진행방향 수직 평행 오프셋, latTarget=오프셋 목표(가끔 갱신→궤적 변경)
  // sx=직전 화면중심 x(0~1, 트리거 crossing 감지), lastCap=마지막 자동캡처 tick(쿨다운), caps=이 맵에서 캡처된 횟수
  const walkersRef = useRef<{ obj: THREE.Object3D; mixer: THREE.AnimationMixer; angle: number; speed: number; id: number; pid: number; pathIdx: number; dist: number; lateral: number; latTarget: number; sx: number; lastCap: number; caps: number }[]>([])
  const gtCanvasRef = useRef<HTMLCanvasElement>(null)
  const showGTRef = useRef(true)
  const personFileRef = useRef<HTMLInputElement>(null)
  const [personLoaded, setPersonLoaded] = useState(false)
  const [personCount, setPersonCount] = useState(5)   // 이 맵에 투입할 인원(로스터에서 앞부터)
  const [personScale, setPersonScale] = useState(1)   // 사람 크기 배율
  // 재색칠 텍스처 캐시(같은 텍스처×스타일 재사용 → 인원 많아도 비용 제한)
  const clothTexCacheRef = useRef<Map<string, THREE.Texture>>(new Map())
  // GLB 풀(로드된 템플릿, 세션 유지) + 신원 로스터
  const templatesRef = useRef<{ scene: THREE.Object3D; longest: THREE.AnimationClip | null; name: string }[]>([])
  const [poolNames, setPoolNames] = useState<string[]>([])
  const [roster, setRoster] = useState<{ pid: number; glb: string; variant: number }[]>([])
  const [rosterSize, setRosterSize] = useState(100)
  const rosterFileRef = useRef<HTMLInputElement>(null)
  // 점진 투입(시간차) + 현재 활동 인원
  const [spawnRate, setSpawnRate] = useState(5)       // 분당 투입 인원
  const [spawnTarget, setSpawnTarget] = useState(30)  // 목표 동시 인원(상한)
  const [spawnRunning, setSpawnRunning] = useState(false)
  const [activeCount, setActiveCount] = useState(0)
  const spawnTimerRef = useRef<number | null>(null)
  const spawnCursorRef = useRef(0)
  const [thumbs, setThumbs] = useState<{ pid: number; variant: number; url: string }[] | null>(null)  // 로스터 미리보기
  const [previewBusy, setPreviewBusy] = useState(false)
  const [showGT, setShowGT] = useState(true)          // 투영 GT bbox+ID 오버레이
  useEffect(() => { showGTRef.current = showGT }, [showGT])
  // 조명
  const hemiRef = useRef<THREE.HemisphereLight | null>(null)
  const dirRef = useRef<THREE.DirectionalLight | null>(null)
  const [brightness, setBrightness] = useState(1)
  // 녹화 → YOLO 검출 → 재생 오버레이
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const resultVideoRef = useRef<HTMLVideoElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const detRef = useRef<{ fps: number; width: number; height: number; nframes: number; frames: number[][][] } | null>(null)
  const [recording, setRecording] = useState(false)
  const [detBusy, setDetBusy] = useState(false)
  const [detInfo, setDetInfo] = useState<string | null>(null)
  const [recUrl, setRecUrl] = useState<string | null>(null)

  const [walk, setWalk] = useState(false)
  const [floorCount, setFloorCount] = useState(0)
  const [deleteMode, setDeleteMode] = useState(false)   // 클릭 시 면(벽 등) 삭제
  const deleteRef = useRef(false)
  useEffect(() => { deleteRef.current = deleteMode }, [deleteMode])

  // 주 동선(paths): 각 동선 = 바닥 위 [x,z] 점들. 클릭으로 마지막 동선에 점 추가.
  const [paths, setPaths] = useState<Vec2[][]>([])
  const pathsRef = useRef<Vec2[][]>([])
  useEffect(() => { pathsRef.current = paths }, [paths])
  const [pathMode, setPathMode] = useState(false)     // 클릭 시 동선 점 추가
  const pathModeRef = useRef(false)
  useEffect(() => { pathModeRef.current = pathMode }, [pathMode])
  const [showPaths, setShowPaths] = useState(false)   // 동선 표시(기본 꺼짐)
  const pathGroupRef = useRef<THREE.Group | null>(null)
  const [showFloor, setShowFloor] = useState(false)   // 지정 바닥(초록 와이어) 표시(기본 꺼짐)
  const showFloorRef = useRef(false)
  useEffect(() => {
    showFloorRef.current = showFloor
    for (const o of overlayRef.current.values()) o.visible = showFloor
  }, [showFloor])
  const [flipX, setFlipX] = useState(true)            // 방 X축 반전(좌우 반전 이슈 보정, 기본 ON)
  const flipXRef = useRef(true)
  useEffect(() => {
    flipXRef.current = flipX
    const g = groupRef.current
    if (!g) return
    g.scale.x = flipX ? -1 : 1
    g.updateMatrixWorld(true)   // 바닥 레이캐스트가 즉시 정확하도록
  }, [flipX])

  // 맵 저장/불러오기 · crop
  const mapFileRef = useRef<HTMLInputElement>(null)
  const [mapList, setMapList] = useState<{ name: string; camid: number }[]>([])   // 서버 maps/ 목록
  const [curMap, setCurMap] = useState('')
  // Phase 4 오케스트레이터(전 맵 자동 순회 수집)
  const [coverage, setCoverage] = useState(0.7)       // 각 신원이 등장할 맵 비율
  const [waveSize, setWaveSize] = useState(15)        // 맵당 동시 투입 인원(웨이브)
  const [capTarget, setCapTarget] = useState(3)       // 신원당 목표 캡처 장수
  const [orchRunning, setOrchRunning] = useState(false)
  const [orchStatus, setOrchStatus] = useState('')
  const orchStopRef = useRef(false)
  const [buildInfo, setBuildInfo] = useState('')      // MSMT17 조립 결과
  const [clearCrops, setClearCrops] = useState(false)
  // 로드한 맵 상태를 방 그룹 재생성 직후 적용하기 위한 대기 슬롯
  const pendingMapRef = useRef<{ faces: string[]; floorFaces: string[] } | null>(null)
  const cropFrameRef = useRef(0)                        // crop 프레임 카운터
  const [camIndex, setCamIndex] = useState(0)           // 이 맵의 카메라 번호(cross-camera ReID)
  const [cropDegrade, setCropDegrade] = useState(true)  // crop 열화(실 CCTV 느낌)
  const [cropOccl, setCropOccl] = useState(true)        // 벽에 가린 사람 crop 제외
  const [cropBusy, setCropBusy] = useState(false)
  const [cropInfo, setCropInfo] = useState<string | null>(null)
  // 자동 캡처(트리거): 화면 가로 3등분 선 통과 시 자동 crop
  const [autoCapture, setAutoCapture] = useState(false)
  const [capCount, setCapCount] = useState(0)
  const autoCaptureRef = useRef(false)
  const cropDegradeRef = useRef(true)
  const cropOcclRef = useRef(true)
  const camIndexRef = useRef(0)
  const capturingRef = useRef(false)                    // POST 중복 방지
  useEffect(() => { autoCaptureRef.current = autoCapture }, [autoCapture])
  useEffect(() => { cropDegradeRef.current = cropDegrade }, [cropDegrade])
  useEffect(() => { cropOcclRef.current = cropOccl }, [cropOccl])
  useEffect(() => { camIndexRef.current = camIndex }, [camIndex])
  const TRIGGER_LINES = [0.33, 0.66, 0.9]               // 화면 가로 위치(0~1)

  useEffect(() => { camStateRef.current = camera }, [camera])
  useEffect(() => { walkRef.current = walk; if (walk) snapToFloor() }, [walk])
  // 밝기 슬라이더 → 조명 강도(기본 hemi 1.3 / dir 1.1 에 배율)
  useEffect(() => {
    if (hemiRef.current) hemiRef.current.intensity = 1.3 * brightness
    if (dirRef.current) dirRef.current.intensity = 1.1 * brightness
  }, [brightness])
  // 사람 크기 슬라이더 → 스폰된 사람들 실시간 리스케일
  useEffect(() => {
    for (const wk of walkersRef.current) wk.obj.scale.setScalar(personScale)
  }, [personScale])

  // 검출 결과 재생 오버레이: 재생 영상 위에 프레임별 bbox 를 그린다
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const v = resultVideoRef.current, cv = overlayCanvasRef.current, det = detRef.current
      if (!v || !cv || !det) return
      const dw = v.clientWidth, dh = v.clientHeight
      if (dw === 0) return
      if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh }
      const ctx = cv.getContext('2d')!
      ctx.clearRect(0, 0, dw, dh)
      // 길이 비율로 프레임 매핑(가변 fps에 강건) → 없으면 fps 폴백
      const dur = v.duration
      const fi = (isFinite(dur) && dur > 0)
        ? (v.currentTime / dur) * (det.nframes - 1)
        : v.currentTime * det.fps
      const idx = Math.min(det.nframes - 1, Math.max(0, Math.round(fi)))
      const boxes = det.frames[idx] || []
      const sx = dw / det.width, sy = dh / det.height
      ctx.lineWidth = 2; ctx.strokeStyle = '#00e676'; ctx.fillStyle = '#00e676'; ctx.font = '12px monospace'
      for (const b of boxes) {
        const x = b[0] * sx, y = b[1] * sy, w = (b[2] - b[0]) * sx, h = (b[3] - b[1]) * sy
        ctx.strokeRect(x, y, w, h)
        ctx.fillText(`person ${b[4]}`, x, Math.max(11, y - 3))
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  // 지정 바닥 위로 카메라 y 스냅 (없으면 null)
  function floorYAt(x: number, z: number): number | null {
    const meshes = Array.from(floorMeshesRef.current)
    if (!meshes.length) return null
    rayRef.current.set(new THREE.Vector3(x, 1000, z), DOWN)
    const hits = rayRef.current.intersectObjects(meshes, false)
    return hits.length ? hits[0].point.y : null
  }
  function snapToFloor() {
    const st = camStateRef.current
    const y = floorYAt(st.position[0], st.position[2])
    if (y != null) setCamera({ position: [st.position[0], y + EYE_HEIGHT, st.position[2]] })
  }
  // 지정 바닥 범위 안에서 무작위 바닥점 (없으면 null)
  function randomFloorPoint(): [number, number] | null {
    const meshes = Array.from(floorMeshesRef.current)
    if (!meshes.length) return null
    const bb = new THREE.Box3()
    meshes.forEach((m) => bb.expandByObject(m))
    for (let t = 0; t < 40; t++) {
      const x = bb.min.x + Math.random() * (bb.max.x - bb.min.x)
      const z = bb.min.z + Math.random() * (bb.max.z - bb.min.z)
      if (floorYAt(x, z) != null) return [x, z]
    }
    return null
  }

  // 1) 1회 초기화
  useEffect(() => {
    const mount = mountRef.current!
    const w = mount.clientWidth, h = mount.clientHeight
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(window.devicePixelRatio)
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xc9ced6)   // 검정 대신 밝은 중립색(빈 공간이 검게 안 보이게)
    // 조명 — 사람 GLB(PBR 재질)가 검게 안 나오도록. (방 메쉬는 Basic 재질이라 조명 무관)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x909090, 1.3)
    scene.add(hemi)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1)
    dirLight.position.set(2, 5, 3)
    scene.add(dirLight)
    hemiRef.current = hemi
    dirRef.current = dirLight
    const cam = new THREE.PerspectiveCamera(camera.fovDeg, w / h, 0.01, 100)
    rendererRef.current = renderer
    sceneRef.current = scene
    camRef.current = cam

    const moveStep = () => {
      const k = keysRef.current
      if (!k.size) return
      const st = camStateRef.current
      const yaw = THREE.MathUtils.degToRad(st.yawDeg)
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
      const step = k.has('control') ? 0.12 : 0.04

      // 보행 모드: 수평 이동만, 지정 바닥 위에서만 (구간 밖이면 막힘)
      if (walkRef.current && floorMeshesRef.current.size) {
        const mv = new THREE.Vector3()
        if (k.has('w')) mv.add(fwd)
        if (k.has('s')) mv.sub(fwd)
        if (k.has('d')) mv.add(right)
        if (k.has('a')) mv.sub(right)
        if (mv.lengthSq() === 0) return
        mv.normalize().multiplyScalar(step)
        const nx = st.position[0] + mv.x, nz = st.position[2] + mv.z
        const y = floorYAt(nx, nz)
        if (y != null) setCamera({ position: [nx, y + EYE_HEIGHT, nz] })
        return
      }

      // 자유 비행
      const mv = new THREE.Vector3()
      if (k.has('w')) mv.add(fwd)
      if (k.has('s')) mv.sub(fwd)
      if (k.has('d')) mv.add(right)
      if (k.has('a')) mv.sub(right)
      if (k.has('e') || k.has(' ')) mv.y += 1
      if (k.has('q') || k.has('shift')) mv.y -= 1
      if (mv.lengthSq() === 0) return
      mv.normalize().multiplyScalar(step)
      setCamera({ position: [st.position[0] + mv.x, st.position[1] + mv.y, st.position[2] + mv.z] })
    }

    // 걷는 사람들 이동.
    //  · 주 동선이 지정돼 있으면: 배정된 동선을 첫 점→마지막 점 방향으로 진행(끝나면 시작으로 순환).
    //  · 없으면: 지정 바닥 위를 자유 배회(경계 만나면 방향 전환).
    // 각 동선의 현재 인원에 반비례하는 가중치(1/(1+count))로 랜덤 선택 → 랜덤이되 몰림 방지("약간 균일")
    const pickBalancedPath = (n: number): number => {
      const counts = new Array(n).fill(0)
      for (const w of walkersRef.current) if (w.pathIdx >= 0 && w.pathIdx < n) counts[w.pathIdx]++
      const weights = counts.map((c) => 1 / (1 + c))
      let r = Math.random() * weights.reduce((a, b) => a + b, 0)
      for (let k = 0; k < n; k++) { r -= weights[k]; if (r <= 0) return k }
      return n - 1
    }
    const stepWalkers = (dt: number) => {
      if (floorMeshesRef.current.size === 0) return
      const usable = pathsRef.current.filter((p) => p.length >= 2)
      if (usable.length) {
        walkersRef.current.forEach((wk) => {
          // 미배정/범위 밖이면 균형 랜덤 배정 + 시작 위치·평행 오프셋 분산
          if (wk.pathIdx < 0 || wk.pathIdx >= usable.length) {
            wk.pathIdx = pickBalancedPath(usable.length)
            wk.dist = Math.random() * pathTotalLength(usable[wk.pathIdx])
            wk.lateral = (Math.random() - 0.5) * 4
            wk.latTarget = wk.lateral
          }
          wk.dist += wk.speed * dt
          if (wk.dist >= (pathTotalLength(usable[wk.pathIdx]) || 1e-9)) {
            wk.pathIdx = pickBalancedPath(usable.length)   // 끝점 도달 → 새 랜덤 동선으로 갈아탐
            wk.dist = 0
          }
          // 동선은 '진행 방향(축)'만 결정. 실제 경로 = 그 방향에 평행하게 오프셋된 축.
          // 오프셋을 목표값으로 부드럽게 이동시키고, 가끔 새 목표를 뽑아 중간에 궤적을 바꾼다(흔들림 X).
          if (Math.random() < dt * 0.12) wk.latTarget = (Math.random() - 0.5) * 4   // 평균 ~8초마다 새 궤적
          wk.lateral += (wk.latTarget - wk.lateral) * Math.min(1, dt * 0.6)         // 부드럽게 접근
          const p = pointAtDist(usable[wk.pathIdx], wk.dist)
          const perpX = Math.cos(p.heading), perpZ = -Math.sin(p.heading)
          let x = p.x + perpX * wk.lateral, z = p.z + perpZ * wk.lateral
          let y = floorYAt(x, z)
          if (y == null) {                                    // 바닥 밖(=벽쪽) → 오프셋 안쪽으로 되돌림
            wk.latTarget = wk.lateral * 0.4; wk.lateral *= 0.5
            x = p.x + perpX * wk.lateral; z = p.z + perpZ * wk.lateral
            y = floorYAt(x, z)
            if (y == null) {                                  // 그래도 밖이면 동선 라인(바닥 위)으로
              wk.lateral = 0; wk.latTarget = 0; x = p.x; z = p.z; y = floorYAt(x, z)
            }
          }
          wk.obj.position.set(x, y ?? wk.obj.position.y, z)
          wk.obj.rotation.y = p.heading                       // 진행방향(흔들림 없음)
        })
        return
      }
      for (const wk of walkersRef.current) {
        let ang = wk.angle + (Math.random() - 0.5) * 0.06               // 자연스러운 흔들림
        const dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang))
        const speed = wk.speed                                          // 사람마다 다른 속도
        const nx = wk.obj.position.x + dir.x * speed * dt
        const nz = wk.obj.position.z + dir.z * speed * dt
        const y = floorYAt(nx, nz)
        if (y != null) { wk.obj.position.set(nx, y, nz); wk.obj.rotation.y = ang }
        else { ang += 2.4 }                                             // 바닥 벗어남 → 회전
        wk.angle = ang
      }
    }

    // 투영 GT: 각 사람 3D 박스 → 2D bbox + ID 를 오버레이 캔버스에 그린다
    const drawGT = () => {
      const gcv = gtCanvasRef.current
      if (!gcv) return
      const W = mount.clientWidth, H = mount.clientHeight
      if (gcv.width !== W || gcv.height !== H) { gcv.width = W; gcv.height = H }
      const ctx = gcv.getContext('2d')!
      ctx.clearRect(0, 0, W, H)
      if (!showGTRef.current) return
      for (const wk of walkersRef.current) {
        const b = projectBoxNDC(cam, wk.obj)
        if (!b) continue
        const minx = b.minx * W, maxx = b.maxx * W, miny = b.miny * H, maxy = b.maxy * H
        // 화면 밖 / 너무 작음 skip
        if (maxx < 0 || minx > W || maxy < 0 || miny > H) continue
        if (maxx - minx < 4 || maxy - miny < 6) continue
        const x = Math.max(0, minx), y = Math.max(0, miny)
        ctx.lineWidth = 2; ctx.strokeStyle = '#ff3b30'; ctx.fillStyle = '#ff3b30'; ctx.font = '12px monospace'
        ctx.strokeRect(x, y, Math.min(W, maxx) - x, Math.min(H, maxy) - y)
        ctx.fillText(`ID ${wk.pid}`, x, Math.max(11, y - 3))
      }
    }

    const clock = new THREE.Clock()
    let raf = 0
    const loop = () => {
      const dt = clock.getDelta()
      moveStep()
      for (const wk of walkersRef.current) wk.mixer.update(dt)
      stepWalkers(dt)
      renderer.render(scene, cam)
      drawGT()
      raf = requestAnimationFrame(loop)
    }
    loop()

    const onResize = () => {
      const ww = mount.clientWidth, hh = mount.clientHeight
      renderer.setSize(ww, hh); cam.aspect = ww / hh; cam.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 2) layout/textures 변경 → room group 재생성 (바닥 지정 초기화)
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !layout) return
    if (groupRef.current) scene.remove(groupRef.current)
    floorMeshesRef.current.clear()
    overlayRef.current.clear()
    setFloorCount(0)

    const pending = pendingMapRef.current
    // 맵 로드 중이면 모든 면을 만든 뒤 저장된 면만 남긴다(seam skip 불필요). 아니면 seam 변 건너뜀.
    const skip: number[] = []
    if (!pending) {
      // 파노라마 좌우 끝(seam)을 가로지르는 footprint 변 = 실제 벽이 아니므로 건너뜀
      const fb = annotation.floorBoundary
      const W = image?.width ?? 0
      if (W && fb.length === layout.footprint.length) {
        for (let i = 0; i < fb.length; i++) {
          const a = fb[i], b = fb[(i + 1) % fb.length]
          if (Math.abs(a[0] - b[0]) > W * 0.5) skip.push(i)   // u 좌표가 좌우로 감김
        }
      }
    }
    const g = buildRoomGroup(layout, textures, skip)
    g.scale.x = flipXRef.current ? -1 : 1   // X축 반전 유지
    groupRef.current = g
    scene.add(g)

    if (pending) {
      // 저장된 맵 복원: 저장 당시 존재하던 면만 남기고(삭제된 면 제거), 저장된 바닥 지정 복원
      const keep = new Set(pending.faces)
      for (const c of [...g.children]) {
        if ((c as THREE.Mesh).isMesh && !keep.has(c.name)) g.remove(c)
      }
      for (const name of pending.floorFaces) {
        const m = g.getObjectByName(name) as THREE.Mesh | null
        if (m) toggleFloor(m)   // 세트 등록 + 초록 오버레이
      }
      pendingMapRef.current = null
    } else {
      // 바닥면은 항상 보행 가능 → 클릭 없이 자동 등록
      const fm = g.getObjectByName('floor') as THREE.Mesh | null
      if (fm) { floorMeshesRef.current.add(fm); setFloorCount(floorMeshesRef.current.size) }
    }
  }, [layout, textures, annotation, image])

  // 2.5) 주 동선 시각화(라인 + 시작=초록/끝=빨강 마커). paths/layout 변경 시 재생성.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (pathGroupRef.current) { scene.remove(pathGroupRef.current); pathGroupRef.current = null }
    if (!paths.length || !showPaths) return          // 동선 숨김이면 렌더 안 함
    const yAt = (x: number, z: number) => (floorYAt(x, z) ?? 0) + 0.03   // 바닥 위 살짝
    const grp = new THREE.Group()
    grp.name = 'paths'
    paths.forEach((path) => {
      if (path.length === 0) return
      const pts = path.map((p) => new THREE.Vector3(p[0], yAt(p[0], p[1]), p[1]))
      if (pts.length >= 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts)
        grp.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x2196f3, depthTest: false })))
      }
      // 점 마커: 시작=초록, 끝=빨강, 중간=파랑
      path.forEach((p, i) => {
        const isStart = i === 0, isEnd = i === path.length - 1 && path.length > 1
        const color = isStart ? 0x33dd66 : isEnd ? 0xff3b30 : 0x2196f3
        const r = isStart || isEnd ? 0.09 : 0.06
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(r, 12, 8),
          new THREE.MeshBasicMaterial({ color, depthTest: false }),
        )
        m.position.set(p[0], yAt(p[0], p[1]), p[1])
        grp.add(m)
      })
    })
    pathGroupRef.current = grp
    scene.add(grp)
  }, [paths, layout, textures, showPaths])

  // 3) 가상 카메라 파라미터 → Three 카메라
  useEffect(() => {
    const cam = camRef.current
    if (!cam) return
    cam.position.set(camera.position[0], camera.position[1], camera.position[2])
    cam.setRotationFromEuler(eulerFromYawPitchRoll(camera.yawDeg, camera.pitchDeg, camera.rollDeg))
    cam.fov = camera.fovDeg
    cam.updateProjectionMatrix()
  }, [camera])

  // WASD/QE 키 입력 (입력창 포커스 중엔 무시)
  useEffect(() => {
    const MOVE = ['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift', 'control']
    const isTyping = () => {
      const el = document.activeElement
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    }
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return
      const key = e.key.toLowerCase()
      if (MOVE.includes(key)) { keysRef.current.add(key); e.preventDefault() }
    }
    const up = (e: KeyboardEvent) => { keysRef.current.delete(e.key.toLowerCase()) }
    const blur = () => keysRef.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // 메쉬 클릭 → 바닥 지정/해제
  function toggleFloor(mesh: THREE.Mesh) {
    const group = groupRef.current
    if (!group) return
    const set = floorMeshesRef.current, ov = overlayRef.current
    if (set.has(mesh)) {
      set.delete(mesh)
      const o = ov.get(mesh); if (o) { group.remove(o); (o.material as THREE.Material).dispose(); ov.delete(mesh) }
    } else {
      set.add(mesh)
      const o = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
        color: 0x33ff99, wireframe: true, transparent: true, opacity: 0.9, depthTest: false,
      }))
      o.visible = showFloorRef.current       // 보행구간 숨김 상태면 새 오버레이도 숨김
      group.add(o); ov.set(mesh, o)
    }
    setFloorCount(set.size)
  }
  // 현재 동선(마지막 path)에 바닥 위 점을 추가. 없으면 새 동선 생성.
  function addPathPoint(x: number, z: number) {
    setPaths((ps) => {
      const next = ps.map((p) => p.slice())
      if (next.length === 0) next.push([])
      next[next.length - 1].push([+x.toFixed(3), +z.toFixed(3)])
      return next
    })
  }
  function newPath() {
    setPaths((ps) => (ps.length === 0 || ps[ps.length - 1].length > 0 ? [...ps, []] : ps))
  }
  function undoPathPoint() {
    setPaths((ps) => {
      if (!ps.length) return ps
      const next = ps.map((p) => p.slice())
      const last = next[next.length - 1]
      if (last.length) last.pop()
      else if (next.length > 1) next.pop()         // 빈 동선이면 그 동선을 제거
      return next
    })
  }
  function clearPaths() { setPaths([]) }

  function pickAt(clientX: number, clientY: number) {
    const cam = camRef.current, group = groupRef.current, renderer = rendererRef.current
    if (!cam || !group || !renderer) return
    const r = renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    rayRef.current.setFromCamera(ndc, cam)
    // 동선 그리기: 바닥 메쉬에 찍힌 점을 현재 동선에 추가
    if (pathModeRef.current) {
      const floors = Array.from(floorMeshesRef.current)
      const fh = floors.length ? rayRef.current.intersectObjects(floors, false) : []
      if (fh.length) addPathPoint(fh[0].point.x, fh[0].point.z)
      return
    }
    // 오버레이는 제외하고 실제 방 메쉬만 픽킹
    const targets = group.children.filter((c) => !Array.from(overlayRef.current.values()).includes(c as THREE.Mesh))
    const hits = rayRef.current.intersectObjects(targets, false)
    if (!hits.length) return
    const m = hits[0].object as THREE.Mesh
    if (deleteRef.current) {
      groupRef.current?.remove(m)                 // 면(벽 등) 삭제
      floorMeshesRef.current.delete(m)
    } else {
      toggleFloor(m)                              // 바닥 지정/해제
    }
  }

  // 드래그=회전 / 클릭(안 움직이면)=바닥 지정
  function onDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true
    drag.current.x = e.clientX; drag.current.y = e.clientY
    setCamera({
      yawDeg: camera.yawDeg + dx * 0.25,
      pitchDeg: Math.max(-89, Math.min(89, camera.pitchDeg - dy * 0.25)),
    })
  }
  function onUp(e: React.PointerEvent) {
    if (drag.current && !drag.current.moved) pickAt(e.clientX, e.clientY)  // 클릭 = 바닥 지정
    drag.current = null
  }

  // pid 로 신원별 외형을 결정적으로 적용. 재질 이름으로 옷/머리/피부 분류.
  //  · 옷(별도 메쉬): 메쉬마다 색이 달라 상·하의 구분. 대부분 무채색(검정/회/흰), 일부 은은한 색. 밝기도 신원별로 달라 다양.
  //  · 머리: 검정 또는 갈색.  · 피부/얼굴: 유지.
  function applyClothing(obj: THREE.Object3D, pid: number) {
    const cache = clothTexCacheRef.current
    // 머리 스타일(신원별): 55% 검정, 45% 갈색
    const hr = seededRand(pid ^ 0x9e3779b9)
    const black = hr() < 0.55
    const hairHue = black ? 0.08 : Math.round((0.04 + hr() * 0.05) * 24) / 24
    const hairSat = Math.round((black ? hr() * 0.10 : 0.30 + hr() * 0.25) * 20) / 20
    const hairTgtL = Math.round((black ? 0.05 + hr() * 0.05 : 0.16 + hr() * 0.12) * 20) / 20

    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || !m.material) return
      const recolorOne = (mm: THREE.Material): THREE.Material => {
        const std = mm as THREE.MeshStandardMaterial
        if (!std.map || !std.map.image) return mm
        const cat = classifyMat(mm.name || '')
        if (cat === 'skip') return mm
        let hue: number, sat: number, tgtL: number, texKeep: number
        if (cat === 'hair') {
          hue = hairHue; sat = hairSat; tgtL = hairTgtL; texKeep = 0.5
        } else {
          // 옷: 재질명별로 색 분산 → 상·하의·신발이 서로 다른 색. pid 로 시드해 맵 간 고정.
          const rg = seededRand((pid * 0x85ebca6b) ^ hashStr(mm.name || ''))
          const b = rg(), c = rg(), d = rg(), h = rg()
          // 밝기: 검정~흰 전 구간 고르게(무채색이라도 신원별 명도로 확실히 구분)
          tgtL = Math.round((0.06 + b * 0.86) * 40) / 40
          // 채도: 55% 무채색, 45% 은은한~중간 유채색
          sat = Math.round((c < 0.55 ? d * 0.05 : 0.16 + d * 0.30) * 40) / 40
          hue = Math.round(h * 36) / 36   // 색상 세밀
          texKeep = 0.35
        }
        const key = `${std.map.uuid}|${cat[0]}|${hue}_${sat}_${tgtL}`
        let tex = cache.get(key)
        if (!tex) {
          const cv = recolorRegion(std.map.image as CanvasImageSource, hue, sat, true, tgtL, texKeep)
          if (!cv) return mm
          tex = new THREE.CanvasTexture(cv)
          tex.flipY = std.map.flipY
          tex.colorSpace = std.map.colorSpace
          tex.wrapS = std.map.wrapS; tex.wrapT = std.map.wrapT
          tex.needsUpdate = true
          cache.set(key, tex)
        }
        const nm = std.clone()
        nm.map = tex
        nm.needsUpdate = true
        return nm
      }
      m.material = Array.isArray(m.material) ? m.material.map(recolorOne) : recolorOne(m.material)
    })
  }

  // GLB 풀 로드 코어(세션 유지). 파일명 정렬 → 로드 순서 무관하게 안정적. 스폰은 하지 않음.
  async function loadTemplatesFromSources(sources: { url: string; name: string; revoke?: boolean }[]) {
    const loader = new GLTFLoader()
    let tpls: { scene: THREE.Object3D; longest: THREE.AnimationClip | null; name: string }[]
    try {
      tpls = await Promise.all(sources.map(async (s) => {
        const gltf = await loader.loadAsync(s.url)
        if (s.revoke) URL.revokeObjectURL(s.url)
        fixMpfbTransparency(gltf.scene)
        const longest = gltf.animations.length
          ? gltf.animations.reduce((a, b) => (a.duration > b.duration ? a : b)) : null
        return { scene: gltf.scene, longest, name: s.name }
      }))
    } catch (e) { alert('GLB 로드 실패: ' + e); return }
    tpls.sort((a, b) => a.name.localeCompare(b.name))
    templatesRef.current = tpls
    setPoolNames(tpls.map((t) => t.name))
    console.log(`GLB 풀 ${tpls.length}종 로드`)
  }

  // 파일 선택으로 로드(오브젝트 URL 사용)
  async function loadTemplates(files: File[]) {
    await loadTemplatesFromSources(files.map((f) => ({ url: URL.createObjectURL(f), name: f.name, revoke: true })))
  }

  // 서버 /data/glb 의 모든 GLB 를 풀로 로드
  async function loadPoolFromServer() {
    try {
      const r = await fetch('/api/glb')
      if (!r.ok) throw new Error(await r.text())
      const files = ((await r.json()).files ?? []) as string[]
      if (!files.length) { alert('/data/glb 에 GLB 파일이 없습니다. 서버 폴더에 GLB 를 넣어주세요.'); return }
      await loadTemplatesFromSources(files.map((n) => ({ url: `/api/glb/${encodeURIComponent(n)}`, name: n })))
    } catch (e) { alert('서버 GLB 풀 로드 실패: ' + e) }
  }

  // 로스터 자동 생성: 풀을 돌며 원본(variant 0) + 재색칠 변형(variant≥1)으로 size 명까지 채움.
  // 각 신원의 pid: 원본=파일명 pid, 변형=basePid + round×1,000,000 (원본/라운드 간 충돌 없음).
  function buildRoster(size: number): { pid: number; glb: string; variant: number }[] {
    const tpls = templatesRef.current
    if (!tpls.length) { alert('먼저 GLB 풀을 로드하세요.'); return [] }
    const glb = tpls.length
    const out: { pid: number; glb: string; variant: number }[] = []
    for (let k = 0; k < Math.max(1, size); k++) {
      const ti = k % glb, round = Math.floor(k / glb)
      const basePid = pidFromName(tpls[ti].name, ti)   // basePid < 1e9 (nsHash*1e5 + num)
      out.push({ pid: round === 0 ? basePid : basePid + round * 1000000000, glb: tpls[ti].name, variant: round })
    }
    setRoster(out)
    console.log(`로스터 ${out.length}명 생성 (원본 ${Math.min(size, glb)} + 변형 ${Math.max(0, size - glb)})`)
    return out
  }

  // 로스터 엔트리 1명을 바닥 위에 추가(append). 성공 시 true.
  function addWalkerFromEntry(e: { pid: number; glb: string; variant: number }): boolean {
    const tpl = templatesRef.current.find((t) => t.name === e.glb)
    if (!tpl) return false
    const obj = cloneSkinned(tpl.scene)
    if (e.variant > 0) applyClothing(obj, e.pid)   // 원본은 그대로, 변형만 재색칠(결정적)
    obj.scale.setScalar(personScale)
    const pt = randomFloorPoint()
    if (!pt) return false
    const y = floorYAt(pt[0], pt[1]) ?? 0
    obj.position.set(pt[0], y, pt[1])
    sceneRef.current?.add(obj)
    const speed = 0.6 + Math.random() * 1.0
    const mixer = new THREE.AnimationMixer(obj)
    mixer.timeScale = speed / 1.1
    if (tpl.longest) {
      const act = mixer.clipAction(tpl.longest)
      act.time = Math.random() * (tpl.longest.duration || 1)
      act.play()
    }
    walkersRef.current.push({ obj, mixer, angle: Math.random() * Math.PI * 2, speed, id: 0, pid: e.pid, pathIdx: -1, dist: 0, lateral: 0, latTarget: 0, sx: -1, lastCap: -999, caps: 0 })
    return true
  }

  // 지정 엔트리들을 한 번에 스폰(기존 사람 제거 후). 오케스트레이터·수동 공용.
  function spawnEntries(entries: { pid: number; glb: string; variant: number }[]) {
    for (const wk of walkersRef.current) sceneRef.current?.remove(wk.obj)
    walkersRef.current = []
    for (const e of entries) if (!addWalkerFromEntry(e)) break
    setPersonLoaded(true)
    setActiveCount(walkersRef.current.length)
  }

  // ── 점진 투입: rate 명/분으로 목표 인원까지 시간차로 누적 ──
  function stopGradualSpawn() {
    if (spawnTimerRef.current != null) { clearInterval(spawnTimerRef.current); spawnTimerRef.current = null }
    setSpawnRunning(false)
  }
  function startGradualSpawn() {
    if (floorMeshesRef.current.size === 0) { alert('먼저 방을 복원/텍스처 굽기 하세요(바닥 필요).'); return }
    if (!templatesRef.current.length) { alert('먼저 GLB 풀을 로드하세요.'); return }
    if (spawnTimerRef.current != null) return
    const entries = roster.length ? roster : buildRoster(rosterSize)
    if (!entries.length) return
    spawnCursorRef.current = walkersRef.current.length   // 현재 인원부터 이어서(고유 신원 유지)
    setSpawnRunning(true); setPersonLoaded(true)
    const stepMs = Math.max(200, Math.round(60000 / Math.max(1, spawnRate)))   // 1명당 간격
    spawnTimerRef.current = window.setInterval(() => {
      const cap = Math.min(spawnTarget, entries.length)
      if (walkersRef.current.length >= cap || spawnCursorRef.current >= entries.length) { stopGradualSpawn(); return }
      if (addWalkerFromEntry(entries[spawnCursorRef.current])) {
        spawnCursorRef.current++
        setActiveCount(walkersRef.current.length)
      }
    }, stepMs)
  }
  // 언마운트 시 타이머 정리
  useEffect(() => () => { if (spawnTimerRef.current != null) clearInterval(spawnTimerRef.current) }, [])

  // 로스터 앞에서 count 명 스폰(수동 투입 버튼용)
  function spawnFromRoster(count: number) {
    if (floorMeshesRef.current.size === 0) { alert('먼저 방을 복원/텍스처 굽기 하세요(바닥 필요).'); return }
    if (!templatesRef.current.length) { alert('먼저 GLB 풀을 로드하세요.'); return }
    let entries = roster
    if (!entries.length) entries = buildRoster(Math.max(count, rosterSize))
    spawnEntries(entries.slice(0, Math.min(Math.max(1, count), entries.length)))
  }

  // 로스터 저장/불러오기 (JSON) — 풀과 무관하게 pid↔(glb,variant) 고정
  function saveRoster() {
    if (!roster.length) { alert('먼저 로스터를 생성하세요.'); return }
    const blob = new Blob([JSON.stringify({ type: 'vd-roster', version: '1.0', size: roster.length, entries: roster }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'roster.json'; a.click()
    URL.revokeObjectURL(url)
  }
  async function loadRosterFile(file: File) {
    let data: { type?: string; entries?: { pid: number; glb: string; variant: number }[] }
    try { data = JSON.parse(await file.text()) } catch (e) { alert('JSON 파싱 실패: ' + e); return }
    if (data.type !== 'vd-roster' || !Array.isArray(data.entries)) { alert('roster JSON(vd-roster) 형식이 아닙니다.'); return }
    setRoster(data.entries)
    setRosterSize(data.entries.length)
    console.log(`로스터 ${data.entries.length}명 불러옴`)
  }

  // 로스터 미리보기: 각 신원을 오프스크린 렌더 → pid 썸네일 그리드
  async function previewRoster() {
    const tpls = templatesRef.current
    if (!tpls.length) { alert('먼저 GLB 풀을 로드하세요.'); return }
    const entries = roster.length ? roster : buildRoster(rosterSize)
    if (!entries.length) return
    setPreviewBusy(true); setThumbs(null)
    await new Promise((r) => setTimeout(r, 20))   // busy 표시 반영
    const W = 150, H = 230
    const byName = new Map(tpls.map((t) => [t.name, t]))
    const rnd = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    rnd.setSize(W, H); rnd.setPixelRatio(1)
    const sc = new THREE.Scene()
    sc.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.4))
    const dl = new THREE.DirectionalLight(0xffffff, 1.1); dl.position.set(1, 3, 2); sc.add(dl)
    const cam = new THREE.PerspectiveCamera(32, W / H, 0.01, 100)
    const out: { pid: number; variant: number; url: string }[] = []
    const limit = Math.min(entries.length, 300)   // 미리보기 상한
    const box = new THREE.Box3(), c = new THREE.Vector3(), s = new THREE.Vector3()
    for (let i = 0; i < limit; i++) {
      const e = entries[i]; const tpl = byName.get(e.glb); if (!tpl) continue
      const obj = cloneSkinned(tpl.scene)
      if (e.variant > 0) applyClothing(obj, e.pid)
      sc.add(obj)
      box.setFromObject(obj); box.getCenter(c); box.getSize(s)
      const hgt = s.y || 1.7
      const dist = (hgt * 0.62) / Math.tan(THREE.MathUtils.degToRad(32 / 2))
      cam.position.set(c.x, c.y + hgt * 0.02, c.z + dist)   // 정면(+z) 가정
      cam.lookAt(c.x, c.y, c.z)
      rnd.render(sc, cam)
      out.push({ pid: e.pid, variant: e.variant, url: rnd.domElement.toDataURL('image/png') })
      sc.remove(obj)
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0))   // UI 양보
    }
    rnd.dispose()
    setThumbs(out); setPreviewBusy(false)
  }

  // 방 전체 3D 메쉬 GLB 저장
  function saveGLB() {
    const g = groupRef.current
    if (!g) { alert('먼저 방 형상 복원 + 텍스처 굽기를 하세요.'); return }
    // 오버레이(초록 와이어) 제외하고 내보내기
    const clean = new THREE.Group()
    g.children.forEach((c) => { if (!Array.from(overlayRef.current.values()).includes(c as THREE.Mesh)) clean.add(c.clone()) })
    exportGroup(clean, 'room.glb')
  }
  // 보행구간(지정 바닥)만 GLB 저장
  function saveFloorGLB() {
    if (!floorMeshesRef.current.size) { alert('바닥으로 쓸 메쉬를 클릭해 지정하세요.'); return }
    const grp = new THREE.Group()
    floorMeshesRef.current.forEach((m) => grp.add(m.clone()))
    exportGroup(grp, 'walkable_floor.glb')
  }
  function exportGroup(obj: THREE.Object3D, filename: string) {
    new GLTFExporter().parse(obj, (res) => {
      const blob = new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    }, (err) => alert('GLB 내보내기 실패: ' + err), { binary: true })
  }

  // ── 맵 저장/불러오기 (JSON: 편집상태 라운드트립 / GLB: 지오메트리) ──
  // 현재 방 그룹에 남아있는 면 이름들(오버레이 제외)
  function presentFaceNames(): string[] {
    const g = groupRef.current
    if (!g) return []
    const ov = new Set(overlayRef.current.values())
    return g.children
      .filter((c) => (c as THREE.Mesh).isMesh && !ov.has(c as THREE.Mesh) && c.name)
      .map((c) => c.name)
  }
  // 텍스처 bake + 면 삭제 + 바닥 지정 + 화각(카메라)까지 한 맵을 서버 /data/maps 에 저장.
  async function saveMapJSON() {
    if (!layout) { alert('먼저 방 형상 복원 + 텍스처 굽기를 하세요.'); return }
    const map = {
      type: 'vd-room-map',
      version: '1.0',
      image_id: image?.id ?? null,
      layout,
      textures,                                        // /api/asset/... URL (서버에 영구 저장됨)
      faces: presentFaceNames(),                       // 삭제되지 않고 남은 면
      floorFaces: Array.from(floorMeshesRef.current).map((m) => m.name).filter(Boolean),
      camera,                                          // 바라보는 화각(pose+fov) 저장
      paths,                                           // 주 동선(들)
      flipX,                                           // X축 반전 상태
      personScale,                                     // 사람 크기 배율
    }
    const suggested = `room_map_${map.image_id ?? 'scene'}`
    const input = window.prompt('맵 이름 (.json 자동 추가) — 서버 /data/maps 에 저장됩니다', suggested)
    if (input === null) return                                   // 취소
    const base = (input.trim() || suggested).replace(/\.json$/i, '')
    try {
      const r = await fetch('/api/save-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: base, map }),
      })
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      await refreshMaps()                              // 목록 즉시 갱신
      setCurMap(j.name); setCamIndex(j.camid)          // 방금 저장한 맵을 선택
      alert(`맵 저장됨: ${j.name} (cam${j.camid}) → /data/maps`)
    } catch (e) { alert('맵 저장 실패: ' + e) }
  }

  // vd-room-map 데이터를 씬에 적용(파일/서버/오케스트레이터 공용)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyMapJSON(data: any): boolean {
    if (data.type !== 'vd-room-map' || !data.layout) { alert('맵 JSON(vd-room-map) 형식이 아닙니다.'); return false }
    // 그룹 재생성 직후 적용할 면/바닥 지정 예약 → layout/textures 세팅으로 rebuild 트리거
    pendingMapRef.current = { faces: data.faces ?? [], floorFaces: data.floorFaces ?? [] }
    if (data.camera) setCamera(data.camera)             // 저장된 화각 복원
    if (typeof data.personScale === 'number') setPersonScale(data.personScale)   // 사람 크기 복원
    flipXRef.current = !!data.flipX                     // rebuild 전에 반전 상태 확정
    setFlipX(!!data.flipX)                              // X축 반전 복원
    setPaths(Array.isArray(data.paths) ? data.paths : [])   // 주 동선 복원
    // 로드 시 사람들의 동선 배정 초기화 → 새 동선에 맞춰 재배정
    for (const wk of walkersRef.current) { wk.pathIdx = -1; wk.dist = 0 }
    setTextures(data.textures ?? [], [])
    setLayout(data.layout)
    return true
  }

  // 맵 파일 로드 (.json 또는 .glb/.gltf)
  async function loadMapFile(file: File) {
    const name = file.name.toLowerCase()
    if (name.endsWith('.glb') || name.endsWith('.gltf')) { await loadMapGLB(file); return }
    try { applyMapJSON(JSON.parse(await file.text())) } catch (e) { alert('JSON 파싱 실패: ' + e) }
  }

  // 서버 maps/ 폴더에서 이름으로 로드 + camid 설정
  async function loadMapByName(name: string, camid: number) {
    try {
      const r = await fetch(`/api/maps/${encodeURIComponent(name)}`)
      if (!r.ok) throw new Error(await r.text())
      if (applyMapJSON(await r.json())) { setCamIndex(camid); setCurMap(name) }
    } catch (e) { alert('맵 로드 실패: ' + e) }
  }
  async function refreshMaps() {
    try {
      const r = await fetch('/api/maps')
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      setMapList(j.maps ?? [])
      return (j.maps ?? []) as { name: string; camid: number }[]
    } catch (e) { alert('맵 목록 실패: ' + e); return [] }
  }
  // 현재 선택된 맵 삭제 — 서버에서 맵 JSON + 텍스처(assets)까지 제거
  async function deleteCurrentMap() {
    if (!curMap) { alert('삭제할 현재 맵이 없습니다. 목록에서 맵을 먼저 선택/로드하세요.'); return }
    if (!window.confirm(`현재 맵 '${curMap}' 과 텍스처를 서버에서 삭제합니다. 계속할까요?`)) return
    try {
      const r = await fetch(`/api/maps/${encodeURIComponent(curMap)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      setCurMap('')
      await refreshMaps()                            // 목록 갱신
      alert(`삭제됨: ${j.deleted}${j.removedTextures ? ' (텍스처 포함)' : (j.textureShared ? ' (텍스처는 다른 맵이 사용 중이라 유지)' : '')}`)
    } catch (e) { alert('맵 삭제 실패: ' + e) }
  }

  // 신원 pid 가 등장할 맵(camid) 집합 — pid 시드로 결정적, 크기=ceil(coverage×M) (≥ 지정 비율)
  function mapsForPid(pid: number, M: number, cov: number): Set<number> {
    const K = Math.max(1, Math.min(M, Math.ceil(cov * M)))
    const order = Array.from({ length: M }, (_, i) => i)
    const rnd = seededRand(pid ^ 0x5f356495)
    for (let i = M - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[order[i], order[j]] = [order[j], order[i]] }
    return new Set(order.slice(0, K))
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // ── 전 맵 자동 순회 수집 ──
  async function runOrchestrator() {
    if (orchRunning) return
    if (!templatesRef.current.length) { alert('먼저 GLB 풀을 로드하세요.'); return }
    let entries = roster
    if (!entries.length) entries = buildRoster(rosterSize)
    if (!entries.length) return
    let maps = mapList
    if (!maps.length) maps = await refreshMaps()
    if (!maps.length) { alert('maps/ 폴더에 맵이 없습니다.'); return }

    stopGradualSpawn()   // 점진 투입과 충돌 방지
    setOrchRunning(true); orchStopRef.current = false; setCapCount(0)
    const M = maps.length
    try {
      for (const m of maps) {
        if (orchStopRef.current) break
        setOrchStatus(`맵 ${m.name} (cam${m.camid}) 로드…`)
        await loadMapByName(m.name, m.camid)
        // 방/바닥 준비 대기(레이아웃 rebuild 이후 floor 등록)
        for (let t = 0; t < 30 && floorMeshesRef.current.size === 0; t++) await sleep(100)
        await sleep(900)   // 텍스처 로드 여유
        if (floorMeshesRef.current.size === 0) { setOrchStatus(`맵 ${m.name}: 바닥 없음 → 건너뜀`); await sleep(600); continue }

        const assigned = entries.filter((e) => mapsForPid(e.pid, M, coverage).has(m.camid))
        for (let i = 0; i < assigned.length && !orchStopRef.current; i += waveSize) {
          const wave = assigned.slice(i, i + waveSize)
          spawnEntries(wave)
          setAutoCapture(true)
          // 웨이브 완료: 전원 caps≥목표 또는 타임아웃
          const maxTicks = 120   // ×250ms = 30s
          for (let t = 0; t < maxTicks && !orchStopRef.current; t++) {
            await sleep(250)
            if (walkersRef.current.every((w) => w.caps >= capTarget)) break
          }
          setAutoCapture(false)
          await sleep(200)
          setOrchStatus(`맵 ${m.name}: ${Math.min(i + waveSize, assigned.length)}/${assigned.length} 신원`)
        }
      }
    } finally {
      setAutoCapture(false)
      // 사람 정리
      for (const wk of walkersRef.current) sceneRef.current?.remove(wk.obj)
      walkersRef.current = []
      setActiveCount(0)
      setOrchRunning(false)
      setOrchStatus(orchStopRef.current ? '중지됨' : '완료')
    }
  }
  function stopOrchestrator() { orchStopRef.current = true }

  // 모아둔 crop → MSMT17 형태로 조립(서버)
  async function buildMsmt() {
    setBuildInfo('조립 중…')
    try {
      const r = await fetch('/api/build-msmt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trainRatio: 0.9, out: 'msmt_out', clearCrops }),
      })
      if (!r.ok) throw new Error(await r.text())
      const j = await r.json()
      setBuildInfo(`완료 → data/${j.out} · 신원 ${j.pids}(train ${j.train_pids}/test ${j.test_pids}) · train ${j.train_imgs} · query ${j.query} · gallery ${j.gallery}`)
    } catch (e) { setBuildInfo('실패: ' + e) }
  }

  // GLB 맵 로드: 메쉬를 월드좌표로 평탄화해 그룹에 넣고 floor* 이름 메쉬를 바닥으로 등록
  async function loadMapGLB(file: File) {
    const scene = sceneRef.current
    if (!scene) return
    const loader = new GLTFLoader()
    const url = URL.createObjectURL(file)
    let gltf
    try { gltf = await loader.loadAsync(url) }
    catch (e) { alert('GLB 로드 실패: ' + e); return }
    finally { URL.revokeObjectURL(url) }

    if (groupRef.current) scene.remove(groupRef.current)
    floorMeshesRef.current.clear()
    overlayRef.current.clear()
    pendingMapRef.current = null
    const g = new THREE.Group()
    gltf.scene.updateMatrixWorld(true)
    const meshes: THREE.Mesh[] = []
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
    for (const m of meshes) {
      m.updateMatrixWorld(true)
      const geo = m.geometry.clone(); geo.applyMatrix4(m.matrixWorld)   // 변환 베이크(그룹 top-level 픽킹용)
      const nm = new THREE.Mesh(geo, m.material)
      nm.name = m.name
      g.add(nm)
      if (m.name === 'floor' || m.name.startsWith('floor')) floorMeshesRef.current.add(nm)
    }
    g.scale.x = flipXRef.current ? -1 : 1   // 현재 X축 반전 상태 반영
    groupRef.current = g
    scene.add(g)
    setFloorCount(floorMeshesRef.current.size)
  }

  // 카메라→사람 몸통 여러 높이로 레이캐스트. 방 메쉬(벽 등)가 앞을 막으면 true(가림).
  function isOccluded(cam: THREE.PerspectiveCamera, obj: THREE.Object3D, roomMeshes: THREE.Object3D[]): boolean {
    if (!roomMeshes.length) return false
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return false
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
    const hgt = box.max.y - box.min.y
    const ray = new THREE.Raycaster()
    const s = new THREE.Vector3(), dir = new THREE.Vector3()
    for (const t of [0.15, 0.4, 0.6, 0.85]) {           // 몸통 중심축 여러 높이
      s.set(cx, box.min.y + hgt * t, cz)
      dir.copy(s).sub(cam.position)
      const dist = dir.length()
      ray.set(cam.position, dir.normalize())
      const hits = ray.intersectObjects(roomMeshes, false)
      if (hits.length && hits[0].distance < dist - 0.05) return true   // 사람보다 앞에 벽 → 가림
    }
    return false
  }

  // 가림 판정용 방 메쉬(오버레이 제외)
  function roomMeshesForOccl(): THREE.Object3D[] {
    const overlays = new Set(overlayRef.current.values())
    return groupRef.current
      ? groupRef.current.children.filter((c) => (c as THREE.Mesh).isMesh && !overlays.has(c as THREE.Mesh))
      : []
  }
  // 정규화 bbox(전신 프레임 내 가정)를 캔버스에서 잘라 (열화 포함) crop 픽셀 반환. 너무 작으면 null.
  function cropPixels(canvas: HTMLCanvasElement, b: { minx: number; miny: number; maxx: number; maxy: number }) {
    const W = canvas.width, H = canvas.height
    const x = Math.max(0, Math.floor(b.minx * W)), y = Math.max(0, Math.floor(b.miny * H))
    const x2 = Math.min(W, Math.ceil(b.maxx * W)), y2 = Math.min(H, Math.ceil(b.maxy * H))
    const cw = x2 - x, ch = y2 - y
    if (cw < 8 || ch < 16) return null
    const tmp = document.createElement('canvas'); tmp.width = cw; tmp.height = ch
    tmp.getContext('2d')!.drawImage(canvas, x, y, cw, ch, 0, 0, cw, ch)
    const dataUrl = cropDegradeRef.current ? degradeCrop(tmp) : tmp.toDataURL('image/png')
    return { x, y, w: cw, h: ch, dataUrl }
  }
  const mapIdOf = () => image?.id ?? 'map'

  // ── 현재 화각에 보이는 전신·비가림 객체 crop → 서버 저장 ──
  async function cropCurrentView() {
    const renderer = rendererRef.current, scene = sceneRef.current, cam = camRef.current
    if (!renderer || !scene || !cam) return
    if (!walkersRef.current.length) { alert('먼저 사람을 투입하세요.'); return }
    renderer.render(scene, cam)
    const canvas = renderer.domElement
    const roomMeshes = roomMeshesForOccl()
    const items: { pid: number; cam: number; frame: number; x: number; y: number; w: number; h: number; dataUrl: string }[] = []
    let clipped = 0, occ = 0
    for (const wk of walkersRef.current) {
      const b = projectBoxNDC(cam, wk.obj)
      if (!b) continue
      if (b.minx < 0 || b.miny < 0 || b.maxx > 1 || b.maxy > 1) { clipped++; continue }
      if (cropOcclRef.current && isOccluded(cam, wk.obj, roomMeshes)) { occ++; continue }
      const px = cropPixels(canvas, b)
      if (!px) continue
      items.push({ pid: wk.pid, cam: camIndexRef.current, frame: cropFrameRef.current++, ...px })
    }
    if (!items.length) { setCropInfo(`전신이 다 나온 객체가 없습니다 (잘림 ${clipped} · 가림 ${occ} 제외).`); return }
    setCropBusy(true); setCropInfo(null)
    try {
      const r = await fetch('/api/save-crops', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapId: mapIdOf(), crops: items }),
      })
      if (!r.ok) throw new Error(await r.text())
      const res = await r.json()
      setCropInfo(`crop ${res.saved}개 저장 → data/${res.dir} (cam ${camIndexRef.current} · 잘림 ${clipped} · 가림 ${occ} 제외)`)
    } catch (e) { alert('crop 저장 실패: ' + e) } finally { setCropBusy(false) }
  }

  // ── 자동 캡처: 화면 가로 3등분 선을 사람 화면중심 x가 통과할 때 전신·비가림이면 crop ──
  useEffect(() => {
    if (!autoCapture) return
    let raf = 0, tick = 0
    const pending: { pid: number; cam: number; frame: number; x: number; y: number; w: number; h: number; dataUrl: string }[] = []
    const loop = () => {
      raf = requestAnimationFrame(loop)
      tick++
      const renderer = rendererRef.current, cam = camRef.current
      if (!renderer || !cam) return
      const canvas = renderer.domElement
      const roomMeshes = roomMeshesForOccl()
      for (const wk of walkersRef.current) {
        const b = projectBoxNDC(cam, wk.obj)
        const cx = b ? (b.minx + b.maxx) / 2 : null
        if (cx == null || !b) { wk.sx = -1; continue }
        if (wk.sx >= 0 && tick - wk.lastCap > 12) {
          let crossed = false
          for (const line of TRIGGER_LINES) if ((wk.sx - line) * (cx - line) < 0) { crossed = true; break }
          if (crossed
            && b.minx >= 0 && b.miny >= 0 && b.maxx <= 1 && b.maxy <= 1              // 전신
            && !(cropOcclRef.current && isOccluded(cam, wk.obj, roomMeshes))) {       // 비가림
            const px = cropPixels(canvas, b)
            if (px) { pending.push({ pid: wk.pid, cam: camIndexRef.current, frame: cropFrameRef.current++, ...px }); wk.lastCap = tick; wk.caps++ }
          }
        }
        wk.sx = cx
      }
      // 모아서 전송(중복 POST 방지)
      if (pending.length && !capturingRef.current) {
        capturingRef.current = true
        const batch = pending.splice(0, pending.length)
        fetch('/api/save-crops', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mapId: mapIdOf(), crops: batch }),
        }).then((r) => r.ok ? r.json() : null)
          .then((j) => { if (j) setCapCount((c) => c + (j.saved || 0)) })
          .catch(() => {})
          .finally(() => { capturingRef.current = false })
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCapture])

  // ── 녹화 → YOLO 검출 → 재생 ──
  function startRec() {
    const canvas = rendererRef.current?.domElement
    if (!canvas) return
    const stream = canvas.captureStream(30)
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime })
    chunksRef.current = []
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
    rec.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' })
      if (recUrl) URL.revokeObjectURL(recUrl)
      setRecUrl(URL.createObjectURL(blob))
      await runDetect(blob)
    }
    rec.start()
    recorderRef.current = rec
    setRecording(true)
  }
  function stopRec() {
    recorderRef.current?.stop()
    setRecording(false)
  }
  async function runDetect(blob: Blob) {
    setDetBusy(true); setDetInfo(null)
    try {
      const fd = new FormData()
      fd.append('file', blob, 'rec.webm')
      const r = await fetch('/api/detect', { method: 'POST', body: fd })
      if (!r.ok) throw new Error(await r.text())
      const det = await r.json()
      detRef.current = det
      setDetInfo(`검출 ${det.nframes}프레임 @ ${det.fps}fps · ${det.width}x${det.height}`)
    } catch (e) { alert('검출 실패: ' + e) } finally { setDetBusy(false) }
  }

  return (
    <div className="panel viewer-panel">
      <h3>4. Box Room 뷰어 (드래그=시선 · 클릭=바닥지정 · WASD=이동 · Q/E=위아래)</h3>
      {!layout && <p className="hint">방 형상 복원 + 텍스처 굽기 후 표시됩니다.</p>}

      {/* 로스터 미리보기 오버레이 */}
      {thumbs && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.82)',
          display: 'flex', flexDirection: 'column', padding: 12,
        }}>
          <div className="row" style={{ alignItems: 'center', gap: 12, color: '#fff', marginBottom: 8 }}>
            <b>로스터 미리보기 — {thumbs.length}명{roster.length > thumbs.length ? ` (전체 ${roster.length} 중 앞 ${thumbs.length})` : ''}</b>
            <span className="hint" style={{ color: '#bbb' }}>파랑 테두리=재색칠 변형</span>
            <button onClick={() => setThumbs(null)} style={{ marginLeft: 'auto' }}>닫기</button>
          </div>
          <div style={{
            flex: 1, overflowY: 'auto', display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8,
          }}>
            {thumbs.map((t, i) => (
              <div key={i} style={{
                background: '#e9edf2', borderRadius: 6, padding: 4, textAlign: 'center',
                border: t.variant > 0 ? '2px solid #2196f3' : '2px solid transparent',
              }}>
                <img src={t.url} alt={`pid ${t.pid}`} style={{ width: '100%', display: 'block', borderRadius: 4 }} />
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#222' }}>
                  {t.pid}{t.variant > 0 ? ` v${t.variant}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label title="메쉬를 클릭하면 바닥(보행가능구간)으로 지정됩니다">
          <input type="checkbox" checked={walk} onChange={(e) => setWalk(e.target.checked)} disabled={floorCount === 0} />
          {' '}보행 모드
        </label>
        <label title="켜고 벽/면을 클릭하면 그 면을 삭제합니다(seam 벽이 남아있을 때 수동 제거)">
          <input type="checkbox" checked={deleteMode}
            onChange={(e) => { setDeleteMode(e.target.checked); if (e.target.checked) setPathMode(false) }} />
          {' '}면 삭제(클릭)
        </label>
        <span className="hint">지정된 바닥: {floorCount}개 · 클릭={pathMode ? '동선 점 추가' : deleteMode ? '면 삭제' : '바닥 지정'}</span>
        <label title="지정된 바닥면(초록 와이어프레임 메쉬) 표시 (꺼도 보행/바닥 판정은 유지)">
          <input type="checkbox" checked={showFloor} onChange={(e) => setShowFloor(e.target.checked)} />
          {' '}지정 바닥(녹색) 표시
        </label>
        <label title="방(재구성 공간+텍스처)을 좌우로 반전(handedness 보정). 반전 후 그린 동선/투입은 정합됨">
          <input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} />
          {' '}X축 반전
        </label>
        <button onClick={saveGLB} disabled={!layout}>방 전체 저장 (.glb)</button>
        <button onClick={saveFloorGLB} disabled={floorCount === 0}>보행구간 저장 (.glb)</button>
        <button onClick={saveMapJSON} disabled={!layout} title="텍스처·삭제된 면·바닥지정·화각까지 저장">맵 저장 (.json)</button>
        <button onClick={() => mapFileRef.current?.click()} title="저장한 맵(.json) 또는 방(.glb) 불러오기">맵 불러오기</button>
        <input ref={mapFileRef} type="file" accept=".json,.glb,.gltf,application/json,model/gltf-binary" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadMapFile(f); e.target.value = '' }} />
        {/* 맵 세트(서버 maps/ 폴더, camid=인덱스) */}
        <button onClick={refreshMaps} title="서버 maps/ 폴더의 맵 목록 불러오기(맵=카메라)">맵 목록 새로고침</button>
        {mapList.length > 0 && (
          <select value={curMap} title="camid = 목록 인덱스"
            onChange={(e) => { const m = mapList.find((x) => x.name === e.target.value); if (m) loadMapByName(m.name, m.camid) }}>
            <option value="">맵 선택({mapList.length})…</option>
            {mapList.map((m) => <option key={m.name} value={m.name}>cam{m.camid} · {m.name}</option>)}
          </select>
        )}
        <button onClick={deleteCurrentMap} disabled={!curMap}
          title="현재 선택된 맵과 그 텍스처를 서버에서 삭제">현재 맵 삭제</button>
        {/* 신원 로스터 */}
        <button onClick={loadPoolFromServer} title="서버 /data/glb 의 모든 GLB 를 풀로 로드">GLB 풀 로드</button>
        <button onClick={() => personFileRef.current?.click()} title="로컬 PC 의 GLB 파일을 직접 선택해 풀로 로드">직접 선택</button>
        <input ref={personFileRef} type="file" accept=".glb,.gltf,model/gltf-binary" hidden multiple
          onChange={(e) => { const fs = e.target.files; if (fs && fs.length) loadTemplates(Array.from(fs)); e.target.value = '' }} />
        <span className="hint">풀 {poolNames.length}종 · 로스터 {roster.length}명</span>
        <label title="자동 생성할 신원 수(원본 + 재색칠 변형으로 채움)">
          로스터 <input type="number" min="1" max="5000" step="1" value={rosterSize} style={{ width: 64 }}
            onChange={(e) => setRosterSize(Math.max(1, parseInt(e.target.value) || 1))} />
        </label>
        <button onClick={() => buildRoster(rosterSize)} disabled={poolNames.length === 0}>로스터 생성</button>
        <button onClick={previewRoster} disabled={poolNames.length === 0 || previewBusy}>
          {previewBusy ? '미리보기 렌더 중…' : '로스터 미리보기'}
        </button>
        <button onClick={saveRoster} disabled={roster.length === 0}>로스터 저장</button>
        <button onClick={() => rosterFileRef.current?.click()}>로스터 불러오기</button>
        <input ref={rosterFileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadRosterFile(f); e.target.value = '' }} />
        <label title="이 맵에 투입할 인원(로스터 앞에서)">
          인원 <input type="number" min="1" max="500" step="1" value={personCount} style={{ width: 56 }}
            onChange={(e) => setPersonCount(Math.max(1, parseInt(e.target.value) || 1))} />
        </label>
        <button onClick={() => spawnFromRoster(personCount)} disabled={floorCount === 0 || poolNames.length === 0}>
          {personLoaded ? `재투입 ${personCount}명` : `투입 ${personCount}명`}
        </button>
        {/* 점진 투입(시간차) */}
        <label title="분당 투입 인원(시간차로 누적)">
          점진 <input type="number" min="1" max="120" step="1" value={spawnRate} style={{ width: 48 }}
            onChange={(e) => setSpawnRate(Math.max(1, parseInt(e.target.value) || 5))} disabled={spawnRunning} />명/분
        </label>
        <label title="점진 투입 목표(동시) 인원 상한">
          목표 <input type="number" min="1" max="500" step="1" value={spawnTarget} style={{ width: 56 }}
            onChange={(e) => setSpawnTarget(Math.max(1, parseInt(e.target.value) || 30))} disabled={spawnRunning} />
        </label>
        {!spawnRunning
          ? <button onClick={startGradualSpawn} disabled={floorCount === 0 || poolNames.length === 0} title="시간차로 사람을 누적 투입">점진 시작</button>
          : <button onClick={stopGradualSpawn}>점진 정지</button>}
        <span className="hint">현재 {activeCount}명{spawnRunning ? ' (투입 중…)' : ''}</span>
        <label title="사람 크기 배율(실시간)">
          크기 <input type="range" min="0.1" max="2" step="0.05" value={personScale}
            onChange={(e) => setPersonScale(parseFloat(e.target.value))} />
          {personScale.toFixed(2)}
        </label>
        <label title="투영 GT 바운딩박스 + ID (ReID 라벨 검증)">
          <input type="checkbox" checked={showGT} onChange={(e) => setShowGT(e.target.checked)} />
          {' '}GT 박스+ID
        </label>
        <label title="사람(조명 받는 재질) 밝기">
          밝기 <input type="range" min="0" max="3" step="0.05" value={brightness}
            onChange={(e) => setBrightness(parseFloat(e.target.value))} />
          {brightness.toFixed(2)}
        </label>
      </div>

      {/* 주 동선 지정: 켜고 바닥을 순서대로 클릭 → 첫 점→마지막 점 방향으로 사람들이 이동 */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
        <label title="켜고 바닥을 순서대로 클릭하면 현재 동선에 점이 추가됩니다(첫 점→끝 점이 주 이동방향)">
          <input type="checkbox" checked={pathMode} disabled={floorCount === 0}
            onChange={(e) => { setPathMode(e.target.checked); if (e.target.checked) setDeleteMode(false) }} />
          {' '}주 동선 그리기(클릭)
        </label>
        <button onClick={newPath} disabled={!pathMode} title="현재 동선을 마치고 새 동선을 시작">＋ 새 동선</button>
        <button onClick={undoPathPoint} disabled={paths.length === 0} title="마지막 점 취소">점 취소</button>
        <button onClick={clearPaths} disabled={paths.length === 0} title="모든 동선 삭제">동선 지우기</button>
        <label title="동선 라인/마커 표시 (꺼도 사람은 동선을 따라 이동)">
          <input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} />
          {' '}동선 표시
        </label>
        <span className="hint">
          동선 {paths.filter((p) => p.length >= 2).length}개
          {paths.length > 0 && ` · 현재 ${paths[paths.length - 1].length}점`}
          {' '}· <span style={{ color: '#33dd66' }}>●</span>시작 <span style={{ color: '#ff3b30' }}>●</span>끝
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <div ref={mountRef} className="three-mount"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
        <canvas ref={gtCanvasRef}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
      </div>

      {/* 현재 화각에 보이는 객체 crop 추출 (투영 GT bbox → 서버 저장, ReID 데이터셋용) */}
      <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label title="이 맵의 카메라 번호(맵=카메라, cross-camera ReID 라벨)">
          cam <input type="number" min="0" max="99" step="1" value={camIndex} style={{ width: 52 }}
            onChange={(e) => setCamIndex(Math.max(0, parseInt(e.target.value) || 0))} />
        </label>
        <label title="crop 저장 시 해상도손실·블러·노이즈·JPEG압축으로 실제 CCTV 영상처럼 열화">
          <input type="checkbox" checked={cropDegrade} onChange={(e) => setCropDegrade(e.target.checked)} />
          {' '}열화(실 CCTV 느낌)
        </label>
        <label title="벽 등에 가려진 사람은 crop에서 제외(카메라→몸통 레이캐스트)">
          <input type="checkbox" checked={cropOccl} onChange={(e) => setCropOccl(e.target.checked)} />
          {' '}가림 제외
        </label>
        <button onClick={cropCurrentView} disabled={cropBusy || !personLoaded}
          title="현재 화각에 보이는 사람들을 pid/cam/frame 이름으로 crop 저장">
          이 화각 객체 crop 저장
        </button>
        <label title="사람 화면중심 x가 1/3·2/3·3/3 선을 넘을 때 전신·비가림이면 자동 crop">
          <input type="checkbox" checked={autoCapture} onChange={(e) => setAutoCapture(e.target.checked)} disabled={!personLoaded} />
          {' '}자동 캡처(트리거)
        </label>
        {autoCapture && <span className="hint">자동 캡처 {capCount}장</span>}
        {cropBusy && <span className="hint">crop 저장 중…</span>}
        {cropInfo && <span className="hint">{cropInfo}</span>}
      </div>

      {/* 전 맵 자동 순회 수집 (오케스트레이터) */}
      <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>전 맵 자동 수집</b>
        <label title="각 신원이 등장할 맵 비율(≥). pid 시드로 고정">
          커버리지 <input type="number" min="0.1" max="1" step="0.05" value={coverage} style={{ width: 60 }}
            onChange={(e) => setCoverage(Math.min(1, Math.max(0.1, parseFloat(e.target.value) || 0.7)))} disabled={orchRunning} />
        </label>
        <label title="맵마다 동시에 투입할 인원(웨이브 단위)">
          동시인원 <input type="number" min="1" max="100" step="1" value={waveSize} style={{ width: 56 }}
            onChange={(e) => setWaveSize(Math.max(1, parseInt(e.target.value) || 15))} disabled={orchRunning} />
        </label>
        <label title="신원당 목표 캡처 장수(도달하면 다음 웨이브)">
          신원당 <input type="number" min="1" max="20" step="1" value={capTarget} style={{ width: 48 }}
            onChange={(e) => setCapTarget(Math.max(1, parseInt(e.target.value) || 3))} disabled={orchRunning} />
        </label>
        {!orchRunning
          ? <button onClick={runOrchestrator} disabled={poolNames.length === 0} title="maps/ 전 맵을 순회하며 커버리지대로 스폰·자동캡처">▶ 시작</button>
          : <button onClick={stopOrchestrator}>■ 중지</button>}
        {orchStatus && <span className="hint">{orchStatus} · 누적 {capCount}장</span>}
        <span style={{ borderLeft: '1px solid #bbb', height: 18 }} />
        <label title="조립 후 원본 crop 폴더 비우기">
          <input type="checkbox" checked={clearCrops} onChange={(e) => setClearCrops(e.target.checked)} disabled={orchRunning} />
          {' '}조립 후 crop 비우기
        </label>
        <button onClick={buildMsmt} disabled={orchRunning} title="모아둔 crop을 신원 90/10 분할 + query/gallery + list로 MSMT17 조립">MSMT17 조립</button>
        {buildInfo && <span className="hint">{buildInfo}</span>}
      </div>

      {/* 녹화 → YOLOv8 검출 → 하단 재생(30fps) + bbox 오버레이 */}
      <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
        <button onClick={recording ? stopRec : startRec} disabled={detBusy || !layout}>
          {recording ? '■ 정지 & 검출' : '● 녹화 시작'}
        </button>
        {detBusy && <span className="hint">YOLOv8 검출 중…</span>}
        {detInfo && <span className="hint">{detInfo}</span>}
      </div>
      {recUrl && (
        <div style={{ position: 'relative', marginTop: 6, lineHeight: 0 }}>
          <video ref={resultVideoRef} src={recUrl} controls autoPlay loop muted
            onLoadedMetadata={() => {
              const v = resultVideoRef.current
              if (v && !isFinite(v.duration)) {   // MediaRecorder webm duration=Infinity 보정
                const onU = () => { v.currentTime = 0; v.removeEventListener('timeupdate', onU) }
                v.addEventListener('timeupdate', onU)
                v.currentTime = 1e6
              }
            }}
            style={{ width: '100%', display: 'block' }} />
          <canvas ref={overlayCanvasRef}
            style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
        </div>
      )}
    </div>
  )
}
