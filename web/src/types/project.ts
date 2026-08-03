// 프로젝트 전역 타입 (spec §4 스키마 기반)

export type Point2 = [number, number]

export type AnnotationMode = 'floorBoundary' | 'ceilingBoundary' | null

export interface Annotation {
  // 원본 이미지 픽셀 좌표 (u, v) 기준의 코너 점들
  floorBoundary: Point2[]
  ceilingBoundary: Point2[]
  forwardYawDeg: number
}

export interface ImageInfo {
  id: string
  filename: string
  width: number
  height: number
  ratioOk: boolean
}

export interface Layout {
  footprint: Point2[] // (x, z) 미터
  height: number
  cameraHeight: number
}

export interface TextureAsset {
  name: string
  url: string
}

export interface VirtualCamera {
  position: [number, number, number]
  yawDeg: number
  pitchDeg: number
  rollDeg: number
  fovDeg: number
  width: number
  height: number
}

export const DEFAULT_CAMERA: VirtualCamera = {
  position: [0, 1.5, 0],
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  fovDeg: 75,
  width: 1280,
  height: 720,
}
