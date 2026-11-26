import * as pc from 'playcanvas';
import { GameConfig } from '../game/GameConfig';

// Vehicles that come from GLB files instead of the procedural builder (player, lobby and multiplayer riders;
// AI traffic stays procedural: these have many separate meshes and would cost too many draw calls in bulk).
// ponytail: imported lamps don't switch on at night, and the tuk-tuk's wheels are part of its body (no spin/steer).

/** yaw: turn the file to face -Z. wheel: separate GLB spun by VehicleController. paint: repaintable body colour. */
export const IMPORTED: Record<string, { file: string; yaw: number; wheel?: string; paint?: boolean }> = {
  tuktuk: { file: 'tuktuk.glb', yaw: 180 },
  camaro: { file: 'camaro.glb', yaw: 0, wheel: 'camaro-wheel.glb', paint: true },
};

/** Entity that fills in once the GLB has loaded (assets are cached by URL). */
export function glbEntity(app: pc.AppBase, file: string, yaw = 0, paint?: [number, number, number]): pc.Entity {
  const holder = new pc.Entity(file);
  let gone = false; // (a cached asset calls back immediately, before the holder has a parent: don't test .parent)
  holder.once('destroy', () => (gone = true));
  app.assets.loadFromUrl(`${GameConfig.dataUrl}/vehicles/${file}`, 'container', (err, asset) => {
    if (err || !asset) { console.warn(`Vehicle model ${file}: ${err}`); return; }
    if (gone) return; // destroyed before it arrived
    const e = (asset.resource as pc.ContainerResource).instantiateRenderEntity({ castShadows: true });
    if (paint) for (const r of e.findComponents('render') as pc.RenderComponent[]) for (const mi of r.meshInstances) {
      const m = mi.material as pc.StandardMaterial, d = m.diffuse;
      if (d.r > 0.4 && d.g < 0.2 && d.b < 0.2 && m.metalness > 0.3) { // the 0xb01c22 paint
        const own = m.clone();
        own.diffuse = new pc.Color(...paint); own.clearCoat = 0.8; own.clearCoatGloss = 0.92; own.update();
        mi.material = own;
      }
    }
    // Turn a wrapper, never the file's root: Sketchfab exports keep their "upright" rotation on that node.
    const pivot = new pc.Entity('yaw');
    pivot.setLocalEulerAngles(0, yaw, 0);
    pivot.addChild(e);
    holder.addChild(pivot);
  });
  return holder;
}
