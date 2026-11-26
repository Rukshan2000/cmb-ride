/** 💾 under the settings button: saves where you are parked (and the game clock). */
export function saveButton(save: () => Promise<void>) {
  const btn = document.createElement('button');
  btn.textContent = '💾 Save';
  btn.style.cssText = 'position:fixed;top:72px;left:12px;z-index:20;height:36px;padding:0 12px;border-radius:10px;border:0;background:rgba(0,0,0,.6);color:#fff;font:600 14px system-ui;cursor:pointer';
  btn.onclick = async () => {
    btn.blur(); // keep keyboard for driving
    btn.disabled = true;
    await save();
    btn.disabled = false;
  };
  document.body.append(btn);
}
