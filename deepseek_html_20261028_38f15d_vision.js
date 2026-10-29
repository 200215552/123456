'use strict';


// ========== MediaPipe 加载与启动 ==========
function showError(msg){
  statusEl.textContent = msg;
  statusEl.style.color = '#ff8899';
  statusEl.style.background = 'rgba(40,10,20,0.8)';
  statusEl.style.borderColor = 'rgba(255,100,120,0.3)';
}

async function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = ()=>reject(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}

async function start(){
  // 1) 先启动基础画面（无论 AI 是否成功都能运行）
  resize();
  ensureFaceParticles();
  resetSnake();
  running = true;
  animate();

  // 2) 同时启动指针降级
  setupPointerFallback();

  // 3) 尝试加载 MediaPipe
  statusEl.textContent = '正在加载 AI 模型…';
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    statusEl.textContent = 'AI 模型已加载，正在启动摄像头…';
  } catch(e){
    console.error(e);
    showError('AI 模型加载失败（可能网络/CDN问题）— 已启用鼠标/触摸模式');
    hintEl.innerHTML = '鼠标/手指滑动屏幕 → 控制贪吃蛇';
    return;
  }

  // 4) 启动摄像头
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    camEl.srcObject = stream;
    await camEl.play();
    camEl.style.display = 'block';
  } catch(e){
    console.error(e);
    showError('无法访问摄像头 — 已启用鼠标/触摸模式');
    hintEl.innerHTML = '鼠标/手指滑动屏幕 → 控制贪吃蛇';
    return;
  }

  // 5) 初始化 FaceMesh
  try {
    const faceMesh = new FaceMesh({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    faceMesh.onResults(onFaceResults);

    // 6) 初始化 Hands
    const hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    hands.onResults(onHandResults);

    // 7) 启动帧循环
    const camera = new Camera(camEl, {
      onFrame: async ()=>{
        try{
          await faceMesh.send({image: camEl});
          await hands.send({image: camEl});
        }catch(e){ /* 单帧失败忽略 */ }
      },
      width: 640,
      height: 480
    });
    camera.start();
    statusEl.textContent = '就绪 · 抬手/露脸开始交互';
    hintEl.innerHTML = '抬手 → 指尖控制贪吃蛇 · 张嘴 → 粒子扩散 · 微笑 → 聚拢<br>张开五指 → 蛇变长变粗 · 握拳 → 蛇身收紧';
    // 3 秒后淡出提示
    setTimeout(()=>{ hintEl.style.opacity = '0.15'; }, 6000);
  } catch(e){
    console.error(e);
    showError('AI 初始化失败 — 已启用鼠标/触摸模式');
    hintEl.innerHTML = '鼠标/手指滑动屏幕 → 控制贪吃蛇';
  }
}

// ========== 回调 ==========
function onFaceResults(results){
  if(results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0){
    const lm = results.multiFaceLandmarks[0];
    const P = i => ({x: 1-lm[i].x, y: lm[i].y});

    const upperLip = P(13), lowerLip = P(14);
    const leftMouth = P(61), rightMouth = P(291);
    const leftEye = P(159), rightEye = P(386);
    const leftBrow = P(105), rightBrow = P(334);

    const eyeDist = dist(leftEye.x,leftEye.y, rightEye.x,rightEye.y) + 0.001;
    const mouthGap = dist(upperLip.x,upperLip.y, lowerLip.x,lowerLip.y);
    faceMouthOpen = clamp((mouthGap/eyeDist - 0.08) / 0.35, 0, 1);

    const mouthCenterY = (upperLip.y+lowerLip.y)/2;
    const cornerLift = ((leftMouth.y+rightMouth.y)/2 - mouthCenterY);
    faceSmile = clamp(-cornerLift * 8, 0, 1);

    const browEyeL = Math.abs(leftBrow.y-leftEye.y);
    const browEyeR = Math.abs(rightBrow.y-rightEye.y);
    const browRatio = ((browEyeL+browEyeR)/2) / eyeDist;
    faceBrowDown = clamp((0.35-browRatio)/0.25, 0, 1);

    const contourIdx = [
      234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152,
      377, 400, 378, 379, 365, 288, 361, 454
    ];
    faceContour = contourIdx.map(i=>P(i));
    hasFace = true;
  } else {
    hasFace = false;
  }
}

function onHandResults(results){
  if(!results.multiHandLandmarks || results.multiHandLandmarks.length === 0){
    hasHand = false;
    return;
  }
  const lm = results.multiHandLandmarks[0];
  const pts = lm.map(p => ({x:1-p.x, y:p.y}));

  const wrist = pts[0];
  const indexTip = pts[8];
  const indexMcp = pts[5];
  const middleMcp = pts[9];
  const ringMcp = pts[13];
  const pinkyMcp = pts[17];
  const thumbTip = pts[4];

  const palm = {
    x: (wrist.x+indexMcp.x+middleMcp.x+ringMcp.x+pinkyMcp.x)/5,
    y: (wrist.y+indexMcp.y+middleMcp.y+ringMcp.y+pinkyMcp.y)/5
  };
  const palmScale = Math.max(0.02, dist(palm.x,palm.y, wrist.x,wrist.y));

  const tips = [thumbTip, indexTip, pts[12], pts[16], pts[20]];
  const mids = [pts[3], pts[6], pts[10], pts[14], pts[18]];
  let extended = [];
  let totalExt = 0;
  for(let i=0;i<5;i++){
    const dTip = dist(palm.x,palm.y, tips[i].x,tips[i].y);
    const dMid = dist(palm.x,palm.y, mids[i].x,mids[i].y);
    totalExt += dTip / palmScale;
    if(dTip > dMid * 1.05) extended.push(tips[i]);
  }
  const avgExt = totalExt / 5;
  handSpread = clamp((avgExt - 1.0) / 1.2, 0, 1);

  const pinchDist = dist(thumbTip.x,thumbTip.y, indexTip.x,indexTip.y) / palmScale;
  handPinch = clamp(1 - pinchDist/1.6, 0, 1);

  // 控制点：食指伸出 → 食指；否则伸出指尖平均；否则手掌
  let control;
  const indexIsExtended = extended.some(p => dist(p.x,p.y, indexTip.x,indexTip.y) < 0.02);
  if(indexIsExtended){
    control = {x:indexTip.x, y:indexTip.y};
  } else if(extended.length > 0){
    control = {
      x: extended.reduce((s,p)=>s+p.x,0)/extended.length,
      y: extended.reduce((s,p)=>s+p.y,0)/extended.length
    };
  } else {
    control = {x:palm.x, y:palm.y};
  }

  handTip = {nx: control.x, ny: control.y};
  handPalm = {nx: palm.x, ny: palm.y};
  hasHand = true;
  pointerActive = false;
}
