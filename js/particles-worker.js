/* ============================================
   NULL-N Background Shader — Raw WebGL
   No external dependencies. Runs off main thread
   via OffscreenCanvas.

   Triple domain-warped fbm noise creates organic,
   fluid visuals impossible with simple particles.
   ============================================ */

let gl, program, canvas;
let timeLoc, resLoc, mouseLoc, scrollLoc, bassLoc, midLoc, highLoc;
let time = 0;
let mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
let scrollVal = 0;
let active = true;
let bass = 0, mid = 0, high = 0;
let tBass = 0, tMid = 0, tHigh = 0;

function lerp(a, b, t) { return a + (b - a) * t; }

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uTime;
uniform vec2  uRes;
uniform vec2  uMouse;
uniform float uScroll;
uniform float uBass;
uniform float uMid;
uniform float uHigh;

// ---- Noise ----
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Interleaved Gradient Noise (Jorge Jimenez) — structured low-frequency
// perturbation used as a final dither to mask 8-bit color banding.
float ign(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 r = mat2(0.866, 0.5, -0.5, 0.866);
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = r * p * 2.0 + 100.0;
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float asp = uRes.x / uRes.y;
    vec2 p = (uv - 0.5) * vec2(asp, 1.0);
    float t = uTime * 0.08;

    // ---- Triple domain warping ----
    vec2 q = vec2(
        fbm(p + t),
        fbm(p + vec2(5.2, 1.3) + t * 0.7)
    );
    vec2 r2 = vec2(
        fbm(p + q * 1.5 + vec2(1.7, 9.2) + t * 0.4),
        fbm(p + q * 1.5 + vec2(8.3, 2.8) + t * 0.3)
    );
    float f = fbm(p + r2 * 2.0);

    // ---- Mouse warp ----
    vec2 m = (uMouse - 0.5) * vec2(asp, 1.0);
    float md = length(p - m);
    f += smoothstep(0.5, 0.0, md) * 0.25;

    // ---- Color mapping — mid enriches palette ----
    vec3 col = vec3(0.035, 0.035, 0.055);
    float f2 = f * f * 1.2;

    // Boundary jitter — breaks the constant-RGB strips that smoothstep
    // emits at fixed thresholds, where Windows displays show banding.
    float bj = (hash(uv * 200.0) - 0.5) * 0.015;
    col = mix(col, vec3(0.0, 0.12, 0.08),  smoothstep(0.0, 0.4, f2 + bj));
    col = mix(col, vec3(0.1, 0.08, 0.28),  smoothstep(0.2, 0.6, f2 + bj));

    // Accent glow — mid enriches color
    col += vec3(0.0, 1.0, 0.67)  * smoothstep(0.5,  0.85, f) * (0.14 + uMid * 0.12);
    col += vec3(0.48, 0.38, 1.0) * smoothstep(0.55, 0.9,  f) * (0.10 + uMid * 0.10);
    col += vec3(1.0, 0.2, 0.4)   * smoothstep(0.65, 0.95, f) * 0.06;

    // ---- Corner shadows — organic, drifting darkness ----
    float td = uTime * 0.1;
    float en = noise(uv * 8.0 + uTime * 0.15);

    // Left side — wider, bold
    float cBL = smoothstep(0.45, 0.0, length(uv - vec2(
        sin(td * 1.5) * 0.04, cos(td * 1.2) * 0.04
    ))) * (0.7 + en * 0.5);
    float cTL = smoothstep(0.45, 0.0, length(uv - vec2(
        sin(td * 1.7) * 0.04, 1.0 + cos(td * 1.4) * 0.04
    ))) * (0.7 + en * 0.5);

    // Right side — smaller, softer to blend naturally
    float cBR = smoothstep(0.32, 0.0, length(uv - vec2(
        1.0 + sin(td * 1.3) * 0.03, cos(td * 1.6) * 0.03
    ))) * (0.6 + en * 0.4);
    float cTR = smoothstep(0.32, 0.0, length(uv - vec2(
        1.0 + sin(td * 1.1) * 0.03, 1.0 + cos(td * 1.8) * 0.03
    ))) * (0.6 + en * 0.4);

    // Diagonal pairing — no two adjacent corners share a band
    float cornerDark = cBL * uBass + cTL * uHigh
                     + cBR * uHigh + cTR * uBass;

    // Deep darkness — center fog stays clean
    col *= max(1.0 - cornerDark * 2.5, 0.0);
    col = mix(col, col * vec3(0.5, 0.55, 1.3), cornerDark * 0.6);

    // Scroll evolution
    col += vec3(0.0, 0.03, 0.02) * uScroll * 0.0005;

    // ---- Stars ----
    vec2 starUV = gl_FragCoord.xy + (uMouse - 0.5) * 4.0;
    vec2 starGrid = floor(starUV * 0.5);
    float starSeed = hash(starGrid);
    float star = step(0.997 - uHigh * 0.001, starSeed);
    col += star * 0.18;

    // ---- Capricorn ----
    vec2 capD = (uMouse - 0.5) * 0.02;
    float cs = 0.0;
    cs = max(cs, smoothstep(0.003, 0.0, length(p - vec2(-0.32, 0.28) - capD)));
    cs = max(cs, smoothstep(0.0035,0.0, length(p - vec2(-0.18, 0.22) - capD)));
    cs = max(cs, smoothstep(0.003, 0.0, length(p - vec2( 0.0,  0.07) - capD)));
    cs = max(cs, smoothstep(0.0025,0.0, length(p - vec2( 0.18, 0.0)  - capD)));
    cs = max(cs, smoothstep(0.003, 0.0, length(p - vec2( 0.32, 0.05) - capD)));
    cs = max(cs, smoothstep(0.004, 0.0, length(p - vec2( 0.42, 0.10) - capD)));
    cs = max(cs, smoothstep(0.0025,0.0, length(p - vec2( 0.0, -0.14) - capD)));
    cs = max(cs, smoothstep(0.0025,0.0, length(p - vec2(-0.18,-0.20) - capD)));
    cs = max(cs, smoothstep(0.0025,0.0, length(p - vec2(-0.28,-0.12) - capD)));
    col += cs * vec3(0.7, 0.8, 1.0) * 0.25;

    // ---- Vignette — opens with energy ----
    float energy = (uBass + uMid + uHigh) * 0.333;
    col *= clamp(1.0 - dot(p * (0.55 - energy * 0.05), p * (0.55 - energy * 0.05)), 0.0, 1.0);

    // ---- Final dither (IGN, ±4/255) ----
    // Interleaved gradient noise distributes quantization error across
    // an animated structured pattern. The visual grain stays minimal
    // while smooth gradients lose their 8-bit stepping entirely.
    col += (ign(gl_FragCoord.xy + fract(uTime) * 50.0) - 0.5) * (8.0 / 255.0);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

function mkShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
}

function init(c, w, h, d) {
    canvas = c;
    canvas.width  = w * d;
    canvas.height = h * d;

    gl = canvas.getContext('webgl', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) return;

    // Display-P3 where supported (Chrome 111+, Safari 16.4+ with capable display) —
    // wider gamut for richer colors. Falls back silently to sRGB.
    if ('drawingBufferColorSpace' in gl) {
        try { gl.drawingBufferColorSpace = 'display-p3'; } catch (_) {}
    }

    gl.viewport(0, 0, canvas.width, canvas.height);

    const vs = mkShader(gl.VERTEX_SHADER, VERT);
    const fs = mkShader(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    timeLoc   = gl.getUniformLocation(program, 'uTime');
    resLoc    = gl.getUniformLocation(program, 'uRes');
    mouseLoc  = gl.getUniformLocation(program, 'uMouse');
    scrollLoc = gl.getUniformLocation(program, 'uScroll');
    bassLoc   = gl.getUniformLocation(program, 'uBass');
    midLoc    = gl.getUniformLocation(program, 'uMid');
    highLoc   = gl.getUniformLocation(program, 'uHigh');

    gl.uniform2f(resLoc, canvas.width, canvas.height);

    // Single oversized triangle — covers viewport, no diagonal seam
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    render();
}

function render() {
    if (!active) return;
    requestAnimationFrame(render);

    time += 0.016;
    mouse.x = lerp(mouse.x, mouse.tx, 0.03);
    mouse.y = lerp(mouse.y, mouse.ty, 0.03);
    bass = lerp(bass, tBass, 0.12);
    mid  = lerp(mid,  tMid,  0.18);
    high = lerp(high, tHigh, 0.25);

    gl.uniform1f(timeLoc, time);
    gl.uniform2f(mouseLoc, mouse.x, mouse.y);
    gl.uniform1f(scrollLoc, scrollVal);
    gl.uniform1f(bassLoc, bass);
    gl.uniform1f(midLoc, mid);
    gl.uniform1f(highLoc, high);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

self.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
        case 'init':
            init(d.canvas, d.width, d.height, d.dpr || 1);
            break;
        case 'mouse':
            mouse.tx = d.x * 0.5 + 0.5;
            mouse.ty = d.y * 0.5 + 0.5;
            break;
        case 'scroll':
            scrollVal = d.y;
            break;
        case 'resize':
            if (!gl || !canvas) break;
            canvas.width  = d.width  * (d.dpr || 1);
            canvas.height = d.height * (d.dpr || 1);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.uniform2f(resLoc, canvas.width, canvas.height);
            break;
        case 'audio':
            tBass = d.bass;
            tMid  = d.mid;
            tHigh = d.high;
            break;
        case 'visibility':
            active = d.visible;
            if (active) render();
            break;
    }
};
