import { useRef } from 'react'
import { useStore } from '../store/projectStore'
import type { Annotation } from '../types/project'

// annotation JSON 저장/불러오기 (spec §4 스키마 호환)
export function ExportPanel() {
  const image = useStore((s) => s.image)
  const annotation = useStore((s) => s.annotation)
  const cameraHeight = useStore((s) => s.cameraHeight)
  const camera = useStore((s) => s.camera)
  const loadAnnotation = useStore((s) => s.loadAnnotation)
  const setCameraHeight = useStore((s) => s.setCameraHeight)
  const fileRef = useRef<HTMLInputElement>(null)

  function save() {
    const project = {
      version: '0.2.0',
      image: image ? { filename: image.filename, width: image.width, height: image.height, type: 'equirectangular' } : null,
      room: { cameraHeight },
      annotation,
      virtualCamera: camera,
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'project.json'; a.click()
    URL.revokeObjectURL(url)
  }

  async function load(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    const data = JSON.parse(await f.text())
    const ann: Annotation = data.annotation ?? data
    loadAnnotation({
      floorBoundary: ann.floorBoundary ?? [],
      ceilingBoundary: ann.ceilingBoundary ?? [],
      forwardYawDeg: ann.forwardYawDeg ?? 0,
    })
    if (data.room?.cameraHeight) setCameraHeight(data.room.cameraHeight)
  }

  return (
    <div className="panel">
      <h3>6. 프로젝트 저장 / 불러오기</h3>
      <div className="row">
        <button onClick={save}>annotation JSON 저장</button>
        <button onClick={() => fileRef.current?.click()}>불러오기</button>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={load} />
      </div>
    </div>
  )
}
