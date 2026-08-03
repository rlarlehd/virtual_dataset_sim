import { PanoramaUploader } from './components/PanoramaUploader'
import { PanoramaAnnotator } from './components/PanoramaAnnotator'
import { RoomParameterPanel } from './components/RoomParameterPanel'
import { ThreeRoomViewer } from './components/ThreeRoomViewer'
import { VirtualCameraPanel } from './components/VirtualCameraPanel'
import { ExportPanel } from './components/ExportPanel'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>360 Panorama → 임의 CCTV View 합성기</h1>
        <p className="subtitle">
          파노라마 1장 + 수동 경계로 Box Room 을 만들고, 방 안 임의 위치에 가상 CCTV 를 놓아
          프레임을 합성합니다. (단순 crop 이 아닌 평행이동 novel-view)
        </p>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <PanoramaUploader />
          <RoomParameterPanel />
          <VirtualCameraPanel />
          <ExportPanel />
        </aside>
        <main className="content">
          <PanoramaAnnotator />
          <ThreeRoomViewer />
        </main>
      </div>
      <footer>
        <p className="disclaimer">
          이 도구는 360 파노라마 1장을 기반으로 단순 Box Room 을 생성하는 보정/렌더링 유틸리티입니다.
          실제 3D 복원이 아니며, 가려진 영역이나 원본 해상도 부족 영역은 정확히 복원되지 않을 수 있습니다.
        </p>
      </footer>
    </div>
  )
}
