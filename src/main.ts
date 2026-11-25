import { Game } from './game/Game';

new Game().start(document.getElementById('app') as HTMLCanvasElement).catch(err => {
  console.error(err);
  document.getElementById('loading')!.innerHTML = `<div class="panel">FAILED TO START<small>${String(err.message ?? err)}</small></div>`;
});
