// 氛围与交互动画：
//   场景（铺在最底下的画布）：右上方咖啡馆窗外照进来的丁达尔光束、贴着地面慢慢飘的晨雾、光里浮动的微尘和偶尔一闪的星光、细雨
//   粒子（盖在最上面的画布，不挡点击）：点按钮、拨开关、切页面时的一小簇光点
// 窗口藏起来、关了「动态效果」或者系统要求减少动画时不跑，只画一帧静止的画面
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

// 天气：光束、雾、微尘、雨的强度
const WEATHER = {
  mist: { rays: 0.9, fog: 1, motes: 70, sparkles: 1, rain: 0, tint: [255, 254, 246] },
  rain: { rays: 0.45, fog: 0.85, motes: 26, sparkles: 0.4, rain: 110, tint: [246, 250, 250] },
  sun: { rays: 1.25, fog: 0.35, motes: 90, sparkles: 1.4, rain: 0, tint: [255, 253, 238] },
};

// 发光的小点：预先画好，绘制时直接贴图
function glowSprite(rgb) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.25, `rgba(${rgb},0.6)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

// 四角星（原神里那种闪光）
function star(g, x, y, r, alpha, rgb) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = `rgb(${rgb})`;
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + r * 0.12, y - r * 0.12, x + r, y);
  g.quadraticCurveTo(x + r * 0.12, y + r * 0.12, x, y + r);
  g.quadraticCurveTo(x - r * 0.12, y + r * 0.12, x - r, y);
  g.quadraticCurveTo(x - r * 0.12, y - r * 0.12, x, y - r);
  g.fill();
  g.globalAlpha = alpha * 0.5;
  g.drawImage(SPRITES.white, x - r * 1.2, y - r * 1.2, r * 2.4, r * 2.4);
  g.restore();
}

const SPRITES = {};

export function createScene(canvas) {
  const g = canvas.getContext("2d");
  SPRITES.white = SPRITES.white || glowSprite("255,255,250");
  let w = 0;
  let h = 0;
  let weather = WEATHER.mist;
  let raf = 0;
  let last = 0;
  let running = false;
  let motes = [];
  let drops = [];
  let fogs = [];
  let sparkles = [];
  let nextSparkle = 0;
  const rays = Array.from({ length: 6 }, (_, i) => ({ angle: 2.05 + i * 0.075 + rand(-0.02, 0.02), width: rand(0.018, 0.045), speed: rand(0.00012, 0.00028), phase: rand(0, TAU), base: rand(0.45, 1) }));

  // 光源在右上角窗外
  const source = () => [w * 0.94, -h * 0.22];
  // 某一点在光束里有多亮（0~1）
  function beamAt(x, y, t) {
    const [sx, sy] = source();
    const a = Math.atan2(y - sy, x - sx);
    let best = 0;
    for (const r of rays) {
      const d = Math.abs(a - r.angle) / r.width;
      if (d < 2.5) best = Math.max(best, Math.exp(-d * d) * (0.6 + 0.4 * Math.sin(t * r.speed + r.phase)) * r.base);
    }
    return best;
  }

  function seed() {
    const [sx, sy] = source();
    motes = Array.from({ length: weather.motes }, () => {
      // 大多数落在光束里
      const inBeam = Math.random() < 0.8;
      let x;
      let y;
      if (inBeam) {
        const r = rays[Math.floor(Math.random() * rays.length)];
        const dist = rand(h * 0.35, Math.hypot(w, h) * 0.9);
        const a = r.angle + rand(-r.width, r.width);
        x = sx + Math.cos(a) * dist;
        y = sy + Math.sin(a) * dist;
      } else {
        x = rand(0, w);
        y = rand(0, h);
      }
      return { x, y, r: rand(0.5, 1.9), vx: rand(-0.008, 0.008), vy: rand(-0.012, 0.004), tw: rand(0, TAU), ts: rand(0.0012, 0.003) };
    });
    fogs = Array.from({ length: 6 }, (_, i) => ({ x: rand(-0.2, 1.1) * w, y: h * (0.62 + i * 0.07) + rand(-30, 30), rx: rand(0.35, 0.6) * w, ry: rand(60, 130), v: rand(0.004, 0.012) * (i % 2 ? 1 : -1), a: rand(0.16, 0.3) }));
    drops = Array.from({ length: weather.rain }, () => ({ x: rand(0, w * 1.1), y: rand(-h, h), len: rand(10, 22), v: rand(0.45, 0.75), a: rand(0.08, 0.18) }));
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function drawRays(t) {
    const [sx, sy] = source();
    const len = Math.hypot(w, h) * 1.15;
    g.save();
    g.globalCompositeOperation = "screen";
    const [r0, g0, b0] = weather.tint;
    for (const r of rays) {
      const pulse = (0.55 + 0.45 * Math.sin(t * r.speed + r.phase)) * r.base * weather.rays;
      const sway = Math.sin(t * 0.00005 + r.phase) * 0.006;
      const a = r.angle + sway;
      const half = r.width * 0.9;
      const grad = g.createLinearGradient(sx, sy, sx + Math.cos(a) * len, sy + Math.sin(a) * len);
      grad.addColorStop(0, `rgba(${r0},${g0},${b0},0)`);
      grad.addColorStop(0.16, `rgba(${r0},${g0},${b0},${0.34 * pulse})`);
      grad.addColorStop(0.55, `rgba(${r0},${g0},${b0},${0.16 * pulse})`);
      grad.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(a - half) * len, sy + Math.sin(a - half) * len);
      g.lineTo(sx + Math.cos(a + half) * len, sy + Math.sin(a + half) * len);
      g.closePath();
      g.fill();
    }
    // 窗口那一角泛着的光
    const bloom = g.createRadialGradient(w * 0.96, 0, 0, w * 0.96, 0, Math.max(w, h) * 0.55);
    bloom.addColorStop(0, `rgba(${r0},${g0},${b0},${0.5 * Math.min(1, weather.rays)})`);
    bloom.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
    g.fillStyle = bloom;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  function drawFog(dt) {
    if (!weather.fog) return;
    for (const f of fogs) {
      f.x += f.v * dt;
      if (f.x - f.rx > w) f.x = -f.rx;
      if (f.x + f.rx < 0) f.x = w + f.rx;
      // 椭圆的一团雾：把径向渐变按比例压扁
      g.save();
      g.translate(f.x, f.y);
      g.scale(1, f.ry / f.rx);
      const e = g.createRadialGradient(0, 0, 0, 0, 0, f.rx);
      e.addColorStop(0, `rgba(250,250,247,${f.a * weather.fog})`);
      e.addColorStop(1, "rgba(250,250,247,0)");
      g.fillStyle = e;
      g.fillRect(-f.rx, -f.rx, f.rx * 2, f.rx * 2);
      g.restore();
    }
    // 贴着地面的一层薄雾
    const band = g.createLinearGradient(0, h, 0, h * 0.7);
    band.addColorStop(0, `rgba(248,248,244,${0.5 * weather.fog})`);
    band.addColorStop(1, "rgba(248,248,244,0)");
    g.fillStyle = band;
    g.fillRect(0, h * 0.7, w, h * 0.3);
  }

  function drawMotes(t, dt) {
    for (const m of motes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.tw += m.ts * dt;
      if (m.y < -10 || m.x < -10 || m.x > w + 10 || m.y > h + 10) {
        m.x = rand(w * 0.3, w);
        m.y = rand(h * 0.2, h);
      }
      const lit = 0.18 + beamAt(m.x, m.y, t) * 0.82;
      const alpha = lit * (0.45 + 0.55 * Math.abs(Math.sin(m.tw)));
      const s = m.r * 5;
      g.globalAlpha = alpha;
      g.drawImage(SPRITES.white, m.x - s / 2, m.y - s / 2, s, s);
    }
    g.globalAlpha = 1;
    // 偶尔一闪的星光
    if (weather.sparkles && t > nextSparkle) {
      nextSparkle = t + rand(900, 2200) / weather.sparkles;
      const m = motes[Math.floor(Math.random() * motes.length)];
      if (m && beamAt(m.x, m.y, t) > 0.3) sparkles.push({ x: m.x, y: m.y, born: t, life: rand(900, 1400), r: rand(4, 7) });
    }
    sparkles = sparkles.filter((s) => t - s.born < s.life);
    for (const s of sparkles) {
      const p = (t - s.born) / s.life;
      star(g, s.x, s.y, s.r * Math.sin(p * Math.PI), Math.sin(p * Math.PI) * 0.9, "255,255,250");
    }
  }

  function drawRain(dt) {
    if (!drops.length) return;
    g.save();
    g.lineCap = "round";
    g.strokeStyle = "rgb(96,104,100)";
    g.lineWidth = 1;
    for (const d of drops) {
      d.y += d.v * dt;
      d.x -= d.v * dt * 0.18;
      if (d.y > h + 20) {
        d.y = rand(-80, -10);
        d.x = rand(0, w * 1.15);
      }
      g.globalAlpha = d.a;
      g.beginPath();
      g.moveTo(d.x, d.y);
      g.lineTo(d.x + d.len * 0.18, d.y - d.len);
      g.stroke();
    }
    g.restore();
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 33) return; // 约 30 帧，省电
    const dt = Math.min(64, t - (last || t));
    last = t;
    render(t, dt);
  }

  function render(t, dt) {
    g.clearRect(0, 0, w, h);
    drawRays(t);
    drawFog(dt);
    drawRain(dt);
    drawMotes(t, dt);
  }

  const api = {
    setWeather(name) {
      weather = WEATHER[name] || WEATHER.mist;
      seed();
      if (!running) render(performance.now(), 0);
    },
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      render(performance.now(), 0); // 停下时留一帧静止的画面
    },
  };
  window.addEventListener("resize", () => {
    resize();
    if (!running) render(performance.now(), 0);
  });
  resize();
  return api;
}

// ---------------- 交互的粒子 ----------------
const KINDS = {
  tap: { n: 7, speed: [0.04, 0.12], life: [380, 620], size: [1.2, 2.6], stars: 0.2, rgb: "122,128,86" },
  big: { n: 16, speed: [0.06, 0.2], life: [520, 900], size: [1.4, 3.2], stars: 0.45, rgb: "112,118,74" },
  on: { n: 14, speed: [0.05, 0.16], life: [500, 850], size: [1.4, 3], stars: 0.55, rgb: "131,138,86" },
  success: { n: 18, speed: [0.05, 0.18], life: [600, 1000], size: [1.4, 3.4], stars: 0.6, rgb: "104,122,70" },
  error: { n: 8, speed: [0.03, 0.08], life: [420, 700], size: [1.2, 2.4], stars: 0, rgb: "160,92,78" },
};

export function createBurst(canvas) {
  const g = canvas.getContext("2d");
  let parts = [];
  let rings = [];
  let raf = 0;
  let enabled = true;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function tick(t) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    parts = parts.filter((p) => t - p.born < p.life);
    rings = rings.filter((r) => t - r.born < r.life);
    for (const r of rings) {
      const p = (t - r.born) / r.life;
      g.globalAlpha = (1 - p) * 0.5;
      g.strokeStyle = `rgb(${r.rgb})`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(r.x, r.y, 4 + p * r.size, 0, TAU);
      g.stroke();
    }
    for (const p of parts) {
      const age = t - p.born;
      const k = age / p.life;
      const x = p.x + p.vx * age;
      const y = p.y + p.vy * age - 0.00002 * age * age; // 微微往上飘
      const a = (1 - k) * (k < 0.15 ? k / 0.15 : 1);
      if (p.star) star(g, x, y, p.size * 2.2 * (1 - k * 0.5), a, p.rgb);
      else {
        g.globalAlpha = a;
        g.fillStyle = `rgb(${p.rgb})`;
        g.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      }
    }
    g.globalAlpha = 1;
    raf = parts.length || rings.length ? requestAnimationFrame(tick) : 0;
  }
  window.addEventListener("resize", resize);
  resize();
  return {
    set enabled(v) {
      enabled = !!v;
    },
    burst(x, y, kind = "tap") {
      if (!enabled) return;
      const k = KINDS[kind] || KINDS.tap;
      const now = performance.now();
      for (let i = 0; i < k.n; i++) {
        const a = rand(0, TAU);
        const s = rand(...k.speed);
        parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.02, born: now, life: rand(...k.life), size: rand(...k.size), star: Math.random() < k.stars, rgb: Math.random() < 0.35 ? "255,255,250" : k.rgb });
      }
      rings.push({ x, y, born: now, life: 520, size: kind === "tap" ? 18 : 30, rgb: k.rgb });
      if (!raf) raf = requestAnimationFrame(tick);
    },
  };
}
