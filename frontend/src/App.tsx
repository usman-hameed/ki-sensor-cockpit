import { useEffect, useRef, useState } from "react";
import { controller } from "./controller";
import { CameraPreview } from "./components/CameraPreview";
import { Copilot } from "./components/Copilot";
import { LiveChart, type LiveChartHandle } from "./components/LiveChart";
import { ManualCard } from "./components/ManualCard";
import { ManualSheet } from "./components/ManualSheet";
import { MeasureCard } from "./components/MeasureCard";
import { PartCheckPanel } from "./components/PartCheckPanel";
import { PartsPanel } from "./components/PartsPanel";
import { QrOverlay } from "./components/QrOverlay";
import { ReportModal } from "./components/ReportModal";
import { SidePanels } from "./components/SidePanels";
import { Toasts } from "./components/Toasts";
import { StatusBar, Tabs, TopBar } from "./components/TopBar";
import { TwinView } from "./components/TwinView";
import { useStore } from "./state/store";

const SWAP_KEY = "cockpit-twin-big";

export default function App() {
  const qrOpen = useStore((s) => s.qrOpen);
  const sensor = useStore((s) => s.config?.sensors[0]);
  const chart = useRef<LiveChartHandle>(null);
  const [windowS, setWindowS] = useState(30);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // the 3D model and the live signal can trade places: the big middle and the small card on the right
  const [swapped, setSwapped] = useState(() => {
    try { return localStorage.getItem(SWAP_KEY) === "1"; } catch { return false; }
  });
  const swap = () => setSwapped((s) => {
    try { localStorage.setItem(SWAP_KEY, s ? "0" : "1"); } catch { /* private mode */ }
    return !s;
  });
  const toggle = (id: string) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    void controller.start();
  }, []);

  const live = (compact: boolean) => <LiveChart ref={chart} windowS={windowS} paused={paused} hidden={hidden} compact={compact} />;

  return (
    <div className="app">
      <TopBar />
      <Tabs />
      <main className="work">
        <SidePanels sensor={sensor} />
        <MeasureCard sensor={sensor} chart={chart} slot={swapped ? <TwinView /> : live(false)}
          windowS={windowS} setWindowS={setWindowS} paused={paused} setPaused={setPaused}
          hidden={hidden} toggle={toggle} swapped={swapped} onSwap={swap} />
        <div className="rightcol">
          <section className="card mini" onDoubleClick={swap}>
            <div className="mini-head">
              <span>{swapped ? "Live-Signal" : "3D-Modell"}</span>
              <button className="btn small" onClick={swap} title="In die Mitte holen (oder doppelklicken)">⤢ Groß</button>
            </div>
            <div className="mini-body">{swapped ? live(true) : <TwinView />}</div>
          </section>
          <Copilot />
        </div>
      </main>
      <StatusBar />
      {qrOpen && <QrOverlay />}
      <ReportModal />
      <PartCheckPanel />
      <PartsPanel />
      <CameraPreview />
      <ManualSheet />
      <ManualCard />
      <Toasts />
    </div>
  );
}
