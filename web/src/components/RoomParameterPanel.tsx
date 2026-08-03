import { useState } from 'react'
import { bakeTextures, buildLayoutBody, getLayout } from '../lib/api'
import { useStore } from '../store/projectStore'

export function RoomParameterPanel() {
  const image = useStore((s) => s.image)
  const annotation = useStore((s) => s.annotation)
  const cameraHeight = useStore((s) => s.cameraHeight)
  const setCameraHeight = useStore((s) => s.setCameraHeight)
  const rect = useStore((s) => s.rectFallback)
  const setRect = useStore((s) => s.setRect)
  const layout = useStore((s) => s.layout)
  const setLayout = useStore((s) => s.setLayout)
  const setTextures = useStore((s) => s.setTextures)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const hasFloor = annotation.floorBoundary.length >= 3

  function body() {
    return buildLayoutBody(image!.id, annotation, cameraHeight, rect)
  }

  async function recover() {
    if (!image) return
    setBusy('layout'); setErr(null)
    try {
      const l = await getLayout(body())
      setLayout({ footprint: l.footprint, height: l.height, cameraHeight: l.cameraHeight })
    } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  async function bake() {
    if (!image) return
    setBusy('bake'); setErr(null)
    try {
      const r = await bakeTextures(body(), { floorSize: 1024, wallHeight: 512 })
      setLayout({ footprint: r.footprint, height: r.height, cameraHeight: r.cameraHeight })
      setTextures(r.textures, r.masks)
    } catch (e) { setErr(String(e)) } finally { setBusy(null) }
  }

  return (
    <div className="panel">
      <h3>3. 방 파라미터 / 형상 복원</h3>
      <label>카메라 높이 (m)
        <input type="number" step="0.1" value={cameraHeight}
          onChange={(e) => setCameraHeight(parseFloat(e.target.value) || 0)} />
      </label>

      {!hasFloor && (
        <div className="rect-fallback">
          <p className="hint">바닥 경계가 3점 미만 → 직사각형 폴백 사용 (W·D·H)</p>
          <div className="row">
            {(['W', 'D', 'H'] as const).map((lab, i) => (
              <label key={lab}>{lab}
                <input type="number" step="0.1" value={rect[i]}
                  onChange={(e) => {
                    const v = [...rect] as [number, number, number]
                    v[i] = parseFloat(e.target.value) || 0
                    setRect(v)
                  }} />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="row">
        <button onClick={recover} disabled={!!busy}>
          {busy === 'layout' ? '복원 중…' : '방 형상 복원'}
        </button>
        <button onClick={bake} disabled={!!busy}>
          {busy === 'bake' ? '굽는 중…' : '텍스처 굽기 (bake)'}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      {layout && (
        <div className="meta">
          <div>footprint: {layout.footprint.length} 코너</div>
          <div>height: {layout.height.toFixed(2)} m</div>
          <div>{hasFloor ? '경계 어노테이션 기반' : '직사각형 폴백'}</div>
        </div>
      )}
    </div>
  )
}
