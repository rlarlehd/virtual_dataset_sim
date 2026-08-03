import { create } from 'zustand'
import type {
  Annotation, AnnotationMode, ImageInfo, Layout, TextureAsset, VirtualCamera,
} from '../types/project'
import { DEFAULT_CAMERA } from '../types/project'

interface ProjectState {
  image: ImageInfo | null
  cameraHeight: number
  rectFallback: [number, number, number]

  annotation: Annotation
  annotationMode: AnnotationMode

  layout: Layout | null
  textures: TextureAsset[]
  masks: TextureAsset[]

  camera: VirtualCamera
  renderedUrl: string | null

  // actions
  setImage: (img: ImageInfo | null) => void
  setCameraHeight: (h: number) => void
  setRect: (r: [number, number, number]) => void
  setMode: (m: AnnotationMode) => void
  addPoint: (p: [number, number]) => void
  updatePoint: (mode: 'floorBoundary' | 'ceilingBoundary', i: number, p: [number, number]) => void
  undoPoint: () => void
  clearCurrent: () => void
  setForwardYaw: (y: number) => void
  loadAnnotation: (a: Annotation) => void

  setLayout: (l: Layout | null) => void
  setTextures: (t: TextureAsset[], m: TextureAsset[]) => void

  setCamera: (c: Partial<VirtualCamera>) => void
  setRenderedUrl: (u: string | null) => void
}

export const useStore = create<ProjectState>((set) => ({
  image: null,
  cameraHeight: 1.5,
  rectFallback: [6, 6, 3],

  annotation: { floorBoundary: [], ceilingBoundary: [], forwardYawDeg: 0 },
  annotationMode: 'floorBoundary',

  layout: null,
  textures: [],
  masks: [],

  camera: { ...DEFAULT_CAMERA },
  renderedUrl: null,

  setImage: (img) => set({ image: img }),
  setCameraHeight: (h) => set({ cameraHeight: h }),
  setRect: (r) => set({ rectFallback: r }),
  setMode: (m) => set({ annotationMode: m }),

  addPoint: (p) => set((s) => {
    if (s.annotationMode !== 'floorBoundary' && s.annotationMode !== 'ceilingBoundary') return {}
    const key = s.annotationMode
    return { annotation: { ...s.annotation, [key]: [...s.annotation[key], p] } }
  }),

  updatePoint: (mode, i, p) => set((s) => {
    const arr = s.annotation[mode].slice()
    arr[i] = p
    return { annotation: { ...s.annotation, [mode]: arr } }
  }),

  undoPoint: () => set((s) => {
    if (s.annotationMode !== 'floorBoundary' && s.annotationMode !== 'ceilingBoundary') return {}
    const key = s.annotationMode
    return { annotation: { ...s.annotation, [key]: s.annotation[key].slice(0, -1) } }
  }),

  clearCurrent: () => set((s) => {
    if (s.annotationMode !== 'floorBoundary' && s.annotationMode !== 'ceilingBoundary') return {}
    const key = s.annotationMode
    return { annotation: { ...s.annotation, [key]: [] } }
  }),

  setForwardYaw: (y) => set((s) => ({ annotation: { ...s.annotation, forwardYawDeg: y } })),
  loadAnnotation: (a) => set({ annotation: a }),

  setLayout: (l) => set({ layout: l }),
  setTextures: (t, m) => set({ textures: t, masks: m }),

  setCamera: (c) => set((s) => ({ camera: { ...s.camera, ...c } })),
  setRenderedUrl: (u) => set({ renderedUrl: u }),
}))
