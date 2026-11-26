import { Game } from './game/Game';

import { signIn } from './account/Store';

signIn().then(() => new Game().start(document.getElementById('app') as HTMLCanvasElement)).catch(err => {
  console.error(err);
  document.getElementById('loading')!.innerHTML = `<div class="panel">FAILED TO START<small>${String(err.message ?? err)}</small></div>`;
});
