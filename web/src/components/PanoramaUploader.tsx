import { useState } from 'react'
import { uploadImage } from '../lib/api'
import { useStore } from '../store/projectStore'

export function PanoramaUploader() {
  const image = useStore((s) => s.image)
  const setImage = useStore((s) => s.setImage)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true); setErr(null)
    try {
      const info = await uploadImage(f)
      setImage(info)
    } catch (ex) {
      setErr(String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h3>1. 360 파노라마 업로드</h3>
      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} disabled={busy} />
      {busy && <p>업로드 중…</p>}
      {err && <p className="err">{err}</p>}
      {image && (
        <div className="meta">
          <div>{image.filename}</div>
          <div>{image.width} × {image.height}</div>
          <div className={image.ratioOk ? 'ok' : 'warn'}>
            비율 {(image.width / image.height).toFixed(3)} —{' '}
            {image.ratioOk ? '2:1 정상' : '⚠ 2:1 아님 (equirectangular 권장)'}
          </div>
        </div>
      )}
    </div>
  )
}
