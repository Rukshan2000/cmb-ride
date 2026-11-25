const $ = (id: string) => document.getElementById(id)!;

/** Mode panel: title chip, current job, detail line, running stats. */
export class ModeHUD {
  constructor(readonly toast: (msg: string, ms?: number) => void) {}
  show(title: string, colour: string) {
    const p = $('mode-panel');
    p.hidden = false;
    p.style.borderLeftColor = colour;
    $('mode-title').textContent = title;
    $('mode-title').style.color = colour;
  }
  set(job: string, detail: string, stats: string) {
    if ($('mode-job').textContent !== job) $('mode-job').textContent = job;
    $('mode-detail').textContent = detail;
    $('mode-stats').textContent = stats;
  }
}
