export interface DriveInput {
  throttle: number;  // 0..1  (W / Up)
  brake: number;     // 0..1  (S / Down)
  steer: number;     // -1..1, +1 = left
  handbrake: boolean;
}

/** Keyboard state plus one-shot actions (camera, reset, pause). */
export class InputManager {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement) return; // typing a destination isn't driving
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', e => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  drive(): DriveInput {
    const k = (...codes: string[]) => codes.some(c => this.down.has(c));
    return {
      throttle: k('KeyW', 'ArrowUp') ? 1 : 0,
      brake: k('KeyS', 'ArrowDown') ? 1 : 0,
      steer: (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0),
      handbrake: k('Space'),
    };
  }

  /** True once per key press. Call consumeFrame() at the end of each frame. */
  wasPressed(code: string) { return this.pressed.has(code); }
  consumeFrame() { this.pressed.clear(); }
}
