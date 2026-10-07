// Disque de la fiche jeu : on l'attrape au clic (ou au doigt) pour le faire tourner, il garde son élan
// en ralentissant, et un nouveau clic l'arrête net. Seule la sérigraphie tourne ; le reflet reste fixe.

const FRICTION = 0.988; // par tranche de 16 ms : la vitesse perd ~1,2 % à chaque image
const MAX_SPEED = 3; // degrés par milliseconde (~8 tours/s)
const SAMPLE_MS = 90; // fenêtre utilisée pour mesurer la vitesse au lâcher

export function makeSpinnable(disc) {
  const print = disc.querySelector('.disc-art');
  if (!print) return;

  let angle = 0;
  let speed = 0; // degrés par milliseconde
  let raf = 0;
  let dragging = false;
  let lastPointerAngle = 0;
  let samples = []; // [instant, angle cumulé]

  const apply = () => {
    print.style.transform = `rotate(${angle}deg)`;
  };

  const pointerAngle = (e) => {
    const r = disc.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  function coast(now, prev) {
    if (!disc.isConnected) return; // fiche refermée
    const dt = Math.min(64, now - prev);
    angle += speed * dt;
    speed *= FRICTION ** (dt / 16);
    apply();
    if (Math.abs(speed) > 0.002) raf = requestAnimationFrame((t) => coast(t, now));
    else speed = 0;
  }

  disc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Attraper le disque l'arrête net, qu'on le fasse tourner ensuite ou non.
    cancelAnimationFrame(raf);
    speed = 0;
    dragging = true;
    lastPointerAngle = pointerAngle(e);
    samples = [[e.timeStamp, angle]];
    disc.setPointerCapture(e.pointerId);
    disc.classList.add('is-grabbed');
  });

  disc.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const a = pointerAngle(e);
    let delta = a - lastPointerAngle;
    if (delta > 180) delta -= 360; // passage de -180° à 180°
    if (delta < -180) delta += 360;
    lastPointerAngle = a;
    angle += delta;
    apply();
    samples.push([e.timeStamp, angle]);
    while (samples.length > 2 && e.timeStamp - samples[0][0] > SAMPLE_MS) samples.shift();
  });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    disc.classList.remove('is-grabbed');
    // Vitesse au lâcher : pente sur les derniers mouvements (0 si on a marqué un temps d'arrêt).
    const [t0, a0] = samples[0];
    const elapsed = e.timeStamp - t0;
    speed = elapsed > 0 && e.timeStamp - samples.at(-1)[0] < 60 ? (angle - a0) / elapsed : 0;
    speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, speed));
    if (speed) raf = requestAnimationFrame((t) => coast(t, t - 16));
  };
  disc.addEventListener('pointerup', release);
  disc.addEventListener('pointercancel', release);
}
