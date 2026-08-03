// FastAPI 백엔드 호출 래퍼
import type { Annotation, ImageInfo, Layout, TextureAsset, VirtualCamera } from '../types/project'

async function jsonPost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

export async function uploadImage(file: File): Promise<ImageInfo> {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/upload', { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`upload failed: ${r.status}`)
  return r.json()
}

export const imageUrl = (id: string) => `/api/image/${id}`

interface LayoutBody {
  image_id: string
  annotation: Annotation
  cameraHeight: number
  rect?: number[] | null
}

export function buildLayoutBody(
  imageId: string, annotation: Annotation, cameraHeight: number,
  rectFallback?: [number, number, number],
): LayoutBody {
  const hasFloor = annotation.floorBoundary.length >= 3
  return {
    image_id: imageId,
    annotation,
    cameraHeight,
    rect: hasFloor ? null : (rectFallback ?? [6, 6, 3]),
  }
}

export function getLayout(body: LayoutBody): Promise<Layout & { walls: number }> {
  return jsonPost('/api/layout', body)
}

export interface BakeResult extends Layout {
  textures: TextureAsset[]
  masks: TextureAsset[]
}

export function bakeTextures(
  body: LayoutBody, opts: { floorSize?: number; wallHeight?: number; sharpen?: boolean } = {},
): Promise<BakeResult> {
  return jsonPost('/api/bake-textures', {
    ...body,
    floorSize: opts.floorSize ?? 1024,
    wallHeight: opts.wallHeight ?? 512,
    sharpen: opts.sharpen ?? false,
  })
}

export async function renderView(
  body: LayoutBody, camera: VirtualCamera,
  opts: { sharpen?: boolean; barrel?: number } = {},
): Promise<string> {
  const r = await fetch('/api/render-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      camera: {
        position: camera.position,
        yawDeg: camera.yawDeg, pitchDeg: camera.pitchDeg, rollDeg: camera.rollDeg,
        fovDeg: camera.fovDeg, width: camera.width, height: camera.height,
      },
      sharpen: opts.sharpen ?? false,
      barrel: opts.barrel ?? 0,
    }),
  })
  if (!r.ok) throw new Error(`render failed: ${r.status} ${await r.text()}`)
  const blob = await r.blob()
  return URL.createObjectURL(blob)
}

export function saveProject(project: unknown): Promise<{ id: string }> {
  return jsonPost('/api/save-project', project)
}
