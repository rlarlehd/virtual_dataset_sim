import { useState } from 'react'
import { buildLayoutBody, renderView } from '../lib/api'
import { useStore } from '../store/projectStore'
import type { VirtualCamera } from '../types/project'

// 방 bbox 기준 CCTV 프리셋 (Python cctv_presets 와 동일 규약)
function presets(layout: { footprint: [number, number][]; height: number; cameraHeight: number }) {
  const xs = layout.footprint.map((p) => p[0]), zs = layout.footprint.map((p) => p[1])
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const zmin = Math.min(...zs), zmax = Math.max(...zs)
  const cx = (xmin + xmax) / 2, cz = (zmin + zmax) / 2, h = layout.height, m = 0.3
  return {
    'Center Eye': { position: [cx, layout.cameraHeight, cz], yawDeg: 0, pitchDeg: 0, fovDeg: 75 },
    'Ceiling Top': { position: [cx, h - m, cz], yawDeg: 0, pitchDeg: -90, fovDeg: 100 },
    'Front CCTV': { position: [cx, h - m, zmax - m], yawDeg: 180, pitchDeg: -35, fovDeg: 95 },
    'Wall-Corner CCTV': { position: [xmin + m, h - m, zmin + m], yawDeg: 45, pitchDeg: -40, fovDeg: 100 },
  } as Record<string, Partial<VirtualCamera>>
}

const num = (v: string) => parseFloat(v) || 0

export function VirtualCameraPanel() {
  const image = useStore((s) => s.image)
  const annotation = useStore((s) => s.annotation)
  const cameraHeight = useStore((s) => s.cameraHeight)
  const rect = useStore((s) => s.rectFallback)
  const layout = useStore((s) => s.layout)
  const camera = useStore((s) => s.camera)
  const setCamera = useStore((s) => s.setCamera)
  const renderedUrl = useStore((s) => s.renderedUrl)
  const setRenderedUrl = useStore((s) => s.setRenderedUrl)

  const [busy, setBusy] = useState(false)
  const [sharpen, setSharpen] = useState(false)
  const [barrel, setBarrel] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  async function hqRender() {
    if (!image) return
    setBusy(true); setErr(null)
    try {
      const body = buildLayoutBody(image.id, annotation, cameraHeight, rect)
      const url = await renderView(body, camera, { sharpen, barrel })
      setRenderedUrl(url)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  const p = camera.position
  const setPos = (i: number, v: number) => {
    const np = [...p] as [number, number, number]; np[i] = v; setCamera({ position: np })
  }

  return (
    <div className="panel">
      <h3>5. 가상 CCTV 카메라</h3>

      <div className="presets">
        {layout && Object.entries(presets(layout)).map(([name, pr]) => (
          <button key={name} onClick={() => setCamera(pr)}>{name}</button>
        ))}
      </div>

      <div className="grid2">
        <label>X<input type="number" step="0.1" value={p[0]} onChange={(e) => setPos(0, num(e.target.value))} /></label>
        <label>Y<input type="number" step="0.1" value={p[1]} onChange={(e) => setPos(1, num(e.target.value))} /></label>
        <label>Z<input type="number" step="0.1" value={p[2]} onChange={(e) => setPos(2, num(e.target.value))} /></label>
        <label>Yaw°<input type="number" value={camera.yawDeg} onChange={(e) => setCamera({ yawDeg: num(e.target.value) })} /></label>
        <label>Pitch°<input type="number" value={camera.pitchDeg} onChange={(e) => setCamera({ pitchDeg: num(e.target.value) })} /></label>
        <label>Roll°<input type="number" value={camera.rollDeg} onChange={(e) => setCamera({ rollDeg: num(e.target.value) })} /></label>
        <label>FOV°<input type="number" value={camera.fovDeg} onChange={(e) => setCamera({ fovDeg: num(e.target.value) })} /></label>
      </div>

      <div className="row">
        <label className="chk"><input type="checkbox" checked={sharpen} onChange={(e) => setSharpen(e.target.checked)} /> sharpen</label>
        <label>barrel k1
          <input type="number" step="0.05" value={barrel} onChange={(e) => setBarrel(num(e.target.value))} />
        </label>
      </div>

      <button className="primary" onClick={hqRender} disabled={busy || !image}>
        {busy ? '렌더링 중…' : '고품질 렌더 (Python)'}
      </button>
      {err && <p className="err">{err}</p>}

      {renderedUrl && (
        <div className="render-result">
          <img src={renderedUrl} alt="rendered cctv frame" style={{ width: '100%' }} />
          <a href={renderedUrl} download="cctv_frame.png"><button>다운로드</button></a>
        </div>
      )}
    </div>
  )
}
