import { useEffect, useRef, useState } from 'react'
import { imageUrl } from '../lib/api'
import { useStore } from '../store/projectStore'
import type { Point2 } from '../types/project'

// 2D canvas 에서 equirectangular 파노라마를 보고, 바닥/천장 '코너'를 클릭해 경계선을 만든다.
// 점은 항상 원본 이미지 픽셀 좌표로 저장한다 (canvas resize 와 무관).
const HIT = 10 // px, 점 선택 반경

export function PanoramaAnnotator() {
  const image = useStore((s) => s.image)
  const annotation = useStore((s) => s.annotation)
  const mode = useStore((s) => s.annotationMode)
  const setMode = useStore((s) => s.setMode)
  const addPoint = useStore((s) => s.addPoint)
  const updatePoint = useStore((s) => s.updatePoint)
  const undoPoint = useStore((s) => s.undoPoint)
  const clearCurrent = useStore((s) => s.clearCurrent)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [scale, setScale] = useState(1)
  const drag = useRef<{ mode: 'floorBoundary' | 'ceilingBoundary'; i: number } | null>(null)
  // 선택된 점 (클릭 시 좌표 표시 + 정밀 수정용)
  const [sel, setSel] = useState<{ mode: 'floorBoundary' | 'ceilingBoundary'; i: number } | null>(null)

  // 이미지 로드
  useEffect(() => {
    if (!image) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = imageUrl(image.id)
    img.onload = () => { imgRef.current = img; draw() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image])

  // 컨테이너 폭에 맞춰 스케일 계산
  useEffect(() => {
    function onResize() {
      if (!wrapRef.current || !image) return
      const w = wrapRef.current.clientWidth
      setScale(w / image.width)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [image])

  // 다시 그림
  useEffect(draw, [annotation, scale, mode, sel])

  function draw() {
    const cv = canvasRef.current, img = imgRef.current
    if (!cv || !img || !image) return
    cv.width = image.width * scale
    cv.height = image.height * scale
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0, cv.width, cv.height)

    drawPoly(ctx, annotation.floorBoundary, '#39d353', mode === 'floorBoundary')
    drawPoly(ctx, annotation.ceilingBoundary, '#58a6ff', mode === 'ceilingBoundary')

    // 선택 점 강조 + 좌표 표시
    const sp = sel && (sel.mode === 'floorBoundary' ? annotation.floorBoundary : annotation.ceilingBoundary)[sel.i]
    if (sp) {
      const x = sp[0] * scale, y = sp[1] * scale
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = '#ff3b30'; ctx.font = '12px monospace'
      ctx.fillText(`(${sp[0]}, ${sp[1]})`, x + 10, y - 10)
    }
  }

  function drawPoly(ctx: CanvasRenderingContext2D, pts: Point2[], color: string, active: boolean) {
    if (pts.length === 0) return
    ctx.lineWidth = active ? 2.5 : 1.5
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.beginPath()
    pts.forEach((p, i) => {
      const x = p[0] * scale, y = p[1] * scale
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    if (pts.length > 2) ctx.closePath() // 닫힌 폴리곤 미리보기
    ctx.stroke()
    pts.forEach((p, i) => {
      const x = p[0] * scale, y = p[1] * scale
      ctx.beginPath()
      ctx.arc(x, y, active ? 5 : 3.5, 0, Math.PI * 2)
      ctx.fill()
      if (active) {
        ctx.fillStyle = '#000'
        ctx.font = '11px monospace'
        ctx.fillText(String(i), x + 6, y - 6)
        ctx.fillStyle = color
      }
    })
  }

  function toImageCoords(e: React.PointerEvent): Point2 {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left) / scale
    const y = (e.clientY - rect.top) / scale
    return [Math.round(x), Math.round(y)]
  }

  function findNear(pt: Point2): { mode: 'floorBoundary' | 'ceilingBoundary'; i: number } | null {
    const lists: ['floorBoundary' | 'ceilingBoundary', Point2[]][] = [
      ['floorBoundary', annotation.floorBoundary],
      ['ceilingBoundary', annotation.ceilingBoundary],
    ]
    for (const [m, pts] of lists) {
      for (let i = 0; i < pts.length; i++) {
        const dx = (pts[i][0] - pt[0]) * scale, dy = (pts[i][1] - pt[1]) * scale
        if (Math.hypot(dx, dy) <= HIT) return { mode: m, i }
      }
    }
    return null
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!image || (mode !== 'floorBoundary' && mode !== 'ceilingBoundary')) return
    const pt = toImageCoords(e)
    const near = findNear(pt)
    if (near) {
      drag.current = near
      setSel(near)                                   // 기존 점 클릭 → 선택
      ;(e.target as Element).setPointerCapture(e.pointerId)
    } else {
      const list = mode === 'floorBoundary' ? annotation.floorBoundary : annotation.ceilingBoundary
      addPoint(pt)
      setSel({ mode, i: list.length })               // 새 점 추가 → 그 점 선택
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    const pt = toImageCoords(e)
    updatePoint(drag.current.mode, drag.current.i, pt)
  }
  function onPointerUp() { drag.current = null }

  if (!image) return <div className="panel"><h3>2. 경계 어노테이션</h3><p>먼저 이미지를 업로드하세요.</p></div>

  return (
    <div className="panel">
      <h3>2. 경계 어노테이션 (모서리 클릭)</h3>
      <div className="row">
        <button className={mode === 'floorBoundary' ? 'active' : ''}
          onClick={() => setMode('floorBoundary')}>바닥 경계 ●</button>
        <button className={mode === 'ceilingBoundary' ? 'active' : ''}
          onClick={() => setMode('ceilingBoundary')}>천장 경계 ●</button>
        <button onClick={undoPoint}>실행취소</button>
        <button onClick={clearCurrent}>현재 지우기</button>
      </div>
      <p className="hint">
        벽-바닥(또는 벽-천장)이 만나는 <b>각 모서리</b>를 순서대로 클릭하세요. 점을 드래그하거나 아래에서 좌표를 직접 수정.
        바닥 {annotation.floorBoundary.length}점 / 천장 {annotation.ceilingBoundary.length}점
      </p>

      {(() => {
        const pts = sel && (sel.mode === 'floorBoundary' ? annotation.floorBoundary : annotation.ceilingBoundary)
        const p = sel && pts ? pts[sel.i] : null
        if (!sel || !p) return <p className="hint">점을 클릭하면 좌표가 여기 표시되고 수정할 수 있습니다.</p>
        return (
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <b style={{ color: sel.mode === 'floorBoundary' ? '#39d353' : '#58a6ff' }}>
              선택: {sel.mode === 'floorBoundary' ? '바닥' : '천장'} #{sel.i}
            </b>
            <label>x:
              <input type="number" step="1" value={p[0]} style={{ width: 90 }}
                onChange={(e) => updatePoint(sel.mode, sel.i, [Math.round(parseFloat(e.target.value) || 0), p[1]])} />
            </label>
            <label>y:
              <input type="number" step="1" value={p[1]} style={{ width: 90 }}
                onChange={(e) => updatePoint(sel.mode, sel.i, [p[0], Math.round(parseFloat(e.target.value) || 0)])} />
            </label>
            <button onClick={() => setSel(null)}>선택 해제</button>
          </div>
        )
      })()}
      <div ref={wrapRef} className="canvas-wrap">
        <canvas ref={canvasRef}
          style={{ cursor: 'crosshair', width: '100%', display: 'block' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} />
      </div>
    </div>
  )
}
