'use strict';

// ========== 基础画布与状态 ==========
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const camEl = document.getElementById('cam');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

let W = 0, H = 0;
let time = 0;
let running = false;

// 手/脸数据
let handTip = null;        // {nx, ny} 归一化，已镜像
let handPalm = null;
let handSpread = 0.5;      // 0~1 手指张开度
let handPinch = 0;         // 0~1 捏合度
let hasHand = false;

let faceContour = null;    // [{nx, ny}]
let faceMouthOpen = 0;
let faceSmile = 0;
let faceBrowDown = 0;
let hasFace = false;

// 平滑值
let smoothTip = {x:0,y:0};
let smoothSpread = 0.5;
let smoothPinch = 0;
let smoothMouth = 0;
let smoothSmile = 0;
let smoothBrow = 0;

// 游戏对象
let snake = [];
let orbs = [];
let ripples = [];
let faceParticles = [];
let virtualContour = [];

// 配置
const CFG = {
  initialSnakeLength: 16,
  minSnakeLength: 10,
  maxSnakeLength: 200,
  snakeBaseSize: 3.0,
  snakeNodeDist: 6.0,
  orbCount: 7,
  collectRadius: 28,
  orbRespawnFrames: 14,
  rippleSpeed: 1.8,
  rippleMaxRadius: 95,
  faceContourSample: 40,
  faceParticleDensity: 12,
  faceBaseHue: 222,
  snakeBaseHue: 275,
  orbHue: 190,
  rippleHue: 210,
};

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const lerp = (a,b,t)=>a+(b-a)*t;
const dist = (x1,y1,x2,y2)=>Math.hypot(x1-x2,y1-y2);

// ========== 初始化 ==========
function resize(){
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W;
  canvas.height = H;
  buildVirtualContour();
  initOrbs();
  if(snake.length){
    for(const s of snake){
      s.x = clamp(s.x, 0, W);
      s.y = clamp(s.y, 0, H);
    }
  } else {
    resetSnake();
  }
}

function buildVirtualContour(){
  virtualContour = [];
  const n = CFG.faceContourSample;
  const cx=0.5, cy=0.52, rx=0.15, ry=0.20;
  for(let i=0;i<n;i++){
    const t = i/(n-1);
    const ang = Math.PI*0.08 + t*Math.PI*0.84;
    virtualContour.push({
      x: cx + Math.cos(ang)*rx,
      y: cy + Math.sin(ang)*ry*0.85 + 0.05
    });
  }
}

function initOrbs(){
  orbs = [];
  for(let i=0;i<CFG.orbCount;i++){
    orbs.push({
      nx: 0.18 + Math.random()*0.64,
      ny: 0.18 + Math.random()*0.64,
      phase: Math.random()*Math.PI*2,
      size: 3.5 + Math.random()*3,
      cooldown: 0
    });
  }
}

function ensureFaceParticles(){
  if(faceParticles.length) return;
  const total = CFG.faceContourSample * CFG.faceParticleDensity;
  for(let i=0;i<total;i++){
    const ci = Math.floor(i / CFG.faceParticleDensity);
    const perPoint = i % CFG.faceParticleDensity;
    faceParticles.push({
      contourIdx: ci,
      angleOffset: (perPoint / CFG.faceParticleDensity) * Math.PI*2 + Math.random()*0.4,
      radialOffset: (Math.random()-0.5) * 0.07,
      sizeVar: 0.6 + Math.random()*0.9,
      phase: Math.random()*Math.PI*2
    });
  }
}

function resetSnake(){
  const sx = smoothTip.x || W*0.5;
  const sy = smoothTip.y || H*0.5;
  snake = [];
  for(let i=0;i<CFG.initialSnakeLength;i++){
    snake.push({x:sx - i*3, y:sy - i*3});
  }
}

// ========== 鼠标/触摸降级控制 ==========
let pointerActive = false;
function setupPointerFallback(){
  const updateFromEvent = (e)=>{
    let cx, cy;
    if(e.touches && e.touches.length > 0){
      cx = e.touches[0].clientX;
      cy = e.touches[0].clientY;
    } else {
      cx = e.clientX;
      cy = e.clientY;
    }
    handTip = {nx: cx/W, ny: cy/H};
    handPalm = handTip;
    hasHand = true;
    pointerActive = true;
  };
  window.addEventListener('mousemove', updateFromEvent);
  window.addEventListener('touchmove', (e)=>{e.preventDefault(); updateFromEvent(e);}, {passive:false});
  window.addEventListener('touchstart', (e)=>{e.preventDefault(); updateFromEvent(e);}, {passive:false});
}

// ========== 更新逻辑 ==========
function updateSmooth(){
  if(hasHand && handTip){
    const tx = handTip.nx * W;
    const ty = handTip.ny * H;
    smoothTip.x = lerp(smoothTip.x, tx, 0.3);
    smoothTip.y = lerp(smoothTip.y, ty, 0.3);
    smoothSpread = lerp(smoothSpread, handSpread, 0.15);
    smoothPinch = lerp(smoothPinch, handPinch, 0.18);
  } else {
    smoothSpread = lerp(smoothSpread, 0.5, 0.03);
    smoothPinch = lerp(smoothPinch, 0, 0.05);
  }

  if(hasFace){
    smoothMouth = lerp(smoothMouth, faceMouthOpen, 0.12);
    smoothSmile = lerp(smoothSmile, faceSmile, 0.12);
    smoothBrow = lerp(smoothBrow, faceBrowDown, 0.12);
  } else {
    smoothMouth = lerp(smoothMouth, 0, 0.05);
    smoothSmile = lerp(smoothSmile, 0, 0.05);
    smoothBrow = lerp(smoothBrow, 0, 0.05);
  }
}

function updateSnake(){
  if(snake.length === 0) return;
  const head = snake[0];

  if(hasHand && smoothTip.x > 0){
    const tx = clamp(smoothTip.x, 4, W-4);
    const ty = clamp(smoothTip.y, 4, H-4);
    const dx = tx - head.x;
    const dy = ty - head.y;
    const d = Math.hypot(dx,dy);
    const speed = Math.min(9 + d*0.15, 22);
    if(d > 1.5){
      head.x += (dx/d) * speed;
      head.y += (dy/d) * speed;
    } else {
      head.x = tx; head.y = ty;
    }
  } else {
    head.x += Math.sin(time*0.008) * 0.3;
    head.y += Math.cos(time*0.0065) * 0.3;
  }
  head.x = clamp(head.x, 2, W-2);
  head.y = clamp(head.y, 2, H-2);

  const nodeDist = CFG.snakeNodeDist * (1 - smoothPinch*0.35);
  for(let i=1;i<snake.length;i++){
    const prev = snake[i-1];
    const curr = snake[i];
    const dx = prev.x - curr.x;
    const dy = prev.y - curr.y;
    const d = Math.hypot(dx,dy);
    if(d > nodeDist){
      const move = (d - nodeDist) * 0.55;
      if(d > 0.01){
        curr.x += (dx/d) * move;
        curr.y += (dy/d) * move;
      }
    }
    curr.x = clamp(curr.x, 1, W-1);
    curr.y = clamp(curr.y, 1, H-1);
  }

  const targetLength = Math.floor(
    CFG.minSnakeLength + smoothSpread * (CFG.maxSnakeLength - CFG.minSnakeLength)
  );
  while(snake.length < targetLength && snake.length < CFG.maxSnakeLength){
    const tail = snake[snake.length-1];
    snake.push({x: tail.x + (Math.random()-0.5)*4, y: tail.y + (Math.random()-0.5)*4});
  }
  while(snake.length > targetLength && snake.length > CFG.minSnakeLength){
    snake.pop();
  }
}

function updateOrbs(){
  for(const orb of orbs){
    if(orb.cooldown > 0) orb.cooldown--;
    orb.phase += 0.03;
  }
}

function checkCollision(){
  if(snake.length === 0) return;
  const head = snake[0];
  for(const orb of orbs){
    if(orb.cooldown > 0) continue;
    const ox = orb.nx * W;
    const oy = orb.ny * H;
    if(dist(head.x,head.y, ox,oy) < CFG.collectRadius){
      ripples.push({x:ox, y:oy, radius:8, alpha:0.9, maxRadius:CFG.rippleMaxRadius});
      orb.cooldown = CFG.orbRespawnFrames;
      orb.nx = 0.12 + Math.random()*0.76;
      orb.ny = 0.12 + Math.random()*0.76;
      if(snake.length < CFG.maxSnakeLength){
        const tail = snake[snake.length-1];
        snake.push({x:tail.x, y:tail.y});
        snake.push({x:tail.x, y:tail.y});
      }
    }
  }
}

function updateRipples(){
  for(let i=ripples.length-1;i>=0;i--){
    const r = ripples[i];
    r.radius += CFG.rippleSpeed;
    r.alpha -= 0.012;
    if(r.radius > r.maxRadius || r.alpha <= 0.02) ripples.splice(i,1);
  }
}

// ========== 绘制 ==========
function drawBg(){
  const g = ctx.createRadialGradient(W*0.5,H*0.5,0, W*0.5,H*0.5,Math.max(W,H)*0.8);
  g.addColorStop(0,'#0b0e18');
  g.addColorStop(0.55,'#080b12');
  g.addColorStop(1,'#04060a');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,W,H);
}

function drawFace(){
  ensureFaceParticles();
  const contour = (hasFace && faceContour && faceContour.length > 3)
    ? faceContour : virtualContour;
  if(contour.length === 0) return;

  const breathBase = 1 + Math.sin(time*0.0025)*0.03;
  const expand = smoothMouth * 0.22 - smoothSmile * 0.10;
  const jitterAmt = smoothBrow * 3.5;
  const cx = W*0.5, cy = H*0.5;

  // 光晕层
  ctx.save();
  ctx.shadowColor = `hsla(${CFG.faceBaseHue},55%,65%,0.4)`;
  ctx.shadowBlur = 26;
  for(const p of faceParticles){
    const base = contour[p.contourIdx % contour.length];
    if(!base) continue;
    const bx = base.x*W, by = base.y*H;
    const dx = bx-cx, dy = by-cy;
    const dc = Math.hypot(dx,dy)+0.001;
    const nx = dx/dc, ny = dy/dc;
    const breathOff = (breathBase-1)*dc*0.9 + expand*dc*0.5;
    const radOff = p.radialOffset*45;
    const jx = Math.sin(time*0.05 + p.phase)*jitterAmt;
    const jy = Math.cos(time*0.047 + p.phase*1.3)*jitterAmt;
    const px = bx + nx*(radOff+breathOff) + Math.cos(p.angleOffset)*2.5 + jx;
    const py = by + ny*(radOff+breathOff) + Math.sin(p.angleOffset)*2.5 + jy;
    ctx.beginPath();
    ctx.arc(px,py,4.5,0,Math.PI*2);
    ctx.fillStyle = `hsla(${CFG.faceBaseHue},55%,68%,0.20)`;
    ctx.fill();
  }
  ctx.restore();

  // 清晰粒子
  ctx.save();
  ctx.shadowColor = `hsla(${CFG.faceBaseHue},65%,78%,0.7)`;
  ctx.shadowBlur = 10;
  for(const p of faceParticles){
    const base = contour[p.contourIdx % contour.length];
    if(!base) continue;
    const bx = base.x*W, by = base.y*H;
    const dx = bx-cx, dy = by-cy;
    const dc = Math.hypot(dx,dy)+0.001;
    const nx = dx/dc, ny = dy/dc;
    const breathOff = (breathBase-1)*dc*0.9 + expand*dc*0.5;
    const radOff = p.radialOffset*45;
    const jx = Math.sin(time*0.05 + p.phase)*jitterAmt;
    const jy = Math.cos(time*0.047 + p.phase*1.3)*jitterAmt;
    const px = bx + nx*(radOff+breathOff) + Math.cos(p.angleOffset)*2.5 + jx;
    const py = by + ny*(radOff+breathOff) + Math.sin(p.angleOffset)*2.5 + jy;
    const size = 2.0 * p.sizeVar * (0.9 + 0.2*Math.sin(time*0.03 + p.phase));
    const hueShift = smoothSmile*12 - smoothMouth*8;
    ctx.beginPath();
    ctx.arc(px,py,size,0,Math.PI*2);
    ctx.fillStyle = `hsla(${CFG.faceBaseHue+hueShift},65%,80%,0.9)`;
    ctx.fill();
  }
  ctx.restore();
}

function drawOrbs(){
  for(const orb of orbs){
    const px = orb.nx*W, py = orb.ny*H;
    if(orb.cooldown > 0){
      ctx.save();
      ctx.shadowColor = `hsla(${CFG.orbHue},80%,70%,0.4)`;
      ctx.shadowBlur = 18;
      ctx.fillStyle = `hsla(${CFG.orbHue},80%,72%,0.2)`;
      ctx.beginPath();
      ctx.arc(px,py,4,0,Math.PI*2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    const pulse = Math.sin(orb.phase)*0.4 + 0.8;
    const size = orb.size * pulse;
    ctx.save();
    ctx.shadowColor = `hsla(${CFG.orbHue},90%,72%,0.9)`;
    ctx.shadowBlur = 26;
    ctx.fillStyle = `hsla(${CFG.orbHue},85%,72%,0.45)`;
    ctx.beginPath();
    ctx.arc(px,py,size*2.2,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 16;
    ctx.fillStyle = `hsla(${CFG.orbHue},85%,85%,0.95)`;
    ctx.beginPath();
    ctx.arc(px,py,size*0.9,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(px-1,py-1,size*0.35,0,Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
}

function drawRipples(){
  for(const r of ripples){
    ctx.save();
    ctx.shadowColor = `hsla(${CFG.rippleHue},80%,72%,0.6)`;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `hsla(${CFG.rippleHue},78%,74%,${r.alpha})`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(r.x,r.y,r.radius,0,Math.PI*2);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${CFG.rippleHue},78%,84%,${r.alpha*0.45})`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(r.x,r.y,r.radius*0.8,0,Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawSnake(){
  if(snake.length === 0) return;
  const pinchPull = smoothPinch * 0.35;
  const head = snake[0];
  const segs = snake.map((s,i)=>{
    if(i===0) return {x:s.x,y:s.y};
    const t = i / snake.length;
    const pull = pinchPull * t;
    return {
      x: s.x + (head.x - s.x) * pull,
      y: s.y + (head.y - s.y) * pull
    };
  });

  // 光晕
  ctx.save();
  ctx.shadowColor = `hsla(${CFG.snakeBaseHue},70%,65%,0.7)`;
  ctx.shadowBlur = 20;
  for(let i=0;i<segs.length;i++){
    const seg = segs[i];
    const factor = 1 - (i/segs.length)*0.5;
    const size = CFG.snakeBaseSize * factor * (1 + smoothSpread*0.4 - smoothPinch*0.2);
    const hue = CFG.snakeBaseHue + (i/segs.length)*15;
    const light = 68 - (i/segs.length)*15;
    ctx.fillStyle = `hsla(${hue},72%,${light}%,0.5)`;
    ctx.beginPath();
    ctx.arc(seg.x,seg.y,size*2.0,0,Math.PI*2);
    ctx.fill();
  }
  ctx.restore();

  // 清晰层
  ctx.save();
  ctx.shadowColor = `hsla(${CFG.snakeBaseHue},80%,80%,0.9)`;
  ctx.shadowBlur = 12;
  for(let i=0;i<segs.length;i++){
    const seg = segs[i];
    const factor = 1 - (i/segs.length)*0.5;
    const size = CFG.snakeBaseSize * factor * (1 + smoothSpread*0.4 - smoothPinch*0.2);
    const hue = CFG.snakeBaseHue + (i/segs.length)*15;
    const light = 68 - (i/segs.length)*10;
    ctx.fillStyle = `hsla(${hue},72%,${light}%,0.95)`;
    ctx.beginPath();
    ctx.arc(seg.x,seg.y,size,0,Math.PI*2);
    ctx.fill();
  }
  ctx.restore();

  // 蛇头高光
  ctx.save();
  ctx.shadowColor = 'rgba(230,210,255,1)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = 'rgba(255,245,255,0.9)';
  ctx.beginPath();
  ctx.arc(head.x, head.y, CFG.snakeBaseSize*1.7, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function drawPointerIndicator(){
  if(hasHand && smoothTip.x > 0 && !pointerActive){
    // 手部追踪时显示指尖光环
    ctx.save();
    ctx.shadowColor = 'rgba(180,220,255,0.9)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(220,240,255,0.6)';
    ctx.beginPath();
    ctx.arc(smoothTip.x, smoothTip.y, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,230,255,0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(smoothTip.x, smoothTip.y, 10, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
}

// ========== 主循环 ==========
function animate(){
  if(!running) return;
  time++;
  updateSmooth();
  updateSnake();
  updateOrbs();
  checkCollision();
  updateRipples();

  drawBg();
  drawFace();
  drawOrbs();
  drawRipples();
  drawSnake();
  drawPointerIndicator();

  requestAnimationFrame(animate);
}
