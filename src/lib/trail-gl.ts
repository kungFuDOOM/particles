/**
 * WebGL2 renderer for the whole field. Every particle streak is one instanced quad, so a
 * whole lane is a single draw call instead of thousands of Canvas2D path segments. Trails
 * accumulate in a half-float framebuffer, which fades smoothly all the way to the ground
 * with no 8-bit residue, and the bloom is a quarter-resolution separable blur.
 *
 * The final pass also paints the backdrop glows and the vignette, and the dust, shockwaves,
 * flashes and seam are drawn on top in the same canvas, so the page composites one opaque
 * layer with no CSS blend modes; that matters most on older integrated GPUs.
 */

export type Rgba = readonly [number, number, number, number];

/** Everything the final pass needs besides the trail itself. CSS pixels, 0..1 colours. */
export type Composite = {
  glow: number;
  ink: boolean;
  ground: Rgba;
  /** rgb plus peak alpha of the soft side glows. */
  buy: Rgba;
  sell: Rgba;
  /** Vertical centre and radius of the side glows, and the front's x. */
  cy: number;
  reach: number;
  fx: number;
  /** Peak alpha of the faint heat band along the front. */
  seam: number;
  /** Vignette: where it starts (fraction of the corner radius), its colour and strength. */
  vignetteFrom: number;
  vignette: Rgba;
};

/** Floats per shape instance: x, y, radius, thickness, then premultiplied r, g, b, a. */
export const SHAPE_STRIDE = 8;

/** Shape thickness codes: 0 is a filled disc, > 0 a ring that wide, SHAPE_GLOW a soft radial glow. */
export const SHAPE_GLOW = -1;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FILL_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

const SEG_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_seg;
uniform vec2 u_res;
uniform float u_half;
uniform float u_px;
out vec2 v_local;
out float v_len;
void main() {
  vec2 p0 = a_seg.xy;
  vec2 d = a_seg.zw - p0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float r = u_half + u_px;
  float along = mix(-r, len + r, a_corner.x);
  float across = a_corner.y * r;
  vec2 p = p0 + dir * along + n * across;
  v_local = vec2(along, across);
  v_len = len;
  vec2 clip = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SEG_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in float v_len;
uniform vec4 u_color;
uniform float u_half;
uniform float u_px;
uniform float u_fade;
out vec4 o;
void main() {
  float t = v_local.x - clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(t, v_local.y));
  float cover = clamp((u_half - dist) / u_px + 0.5, 0.0, 1.0);
  // Optional fade in and out over the first and last 18% of the line (the front seam).
  float f = clamp(v_local.x / max(v_len, 1e-4), 0.0, 1.0);
  cover *= mix(1.0, clamp(min(f, 1.0 - f) / 0.18, 0.0, 1.0), u_fade);
  o = vec4(u_color.rgb, u_color.a * cover);
}`;

const SHAPE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_shape;
layout(location = 2) in vec4 a_color;
uniform vec2 u_res;
uniform float u_px;
out vec2 v_local;
out vec4 v_shape;
out vec4 v_color;
void main() {
  float extent = a_shape.z + max(a_shape.w, 0.0) * 0.5 + u_px;
  vec2 local = vec2(a_corner.x * 2.0 - 1.0, a_corner.y) * extent;
  vec2 p = a_shape.xy + local;
  v_local = local;
  v_shape = a_shape;
  v_color = a_color;
  vec2 clip = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

/** Segments in the ring mesh; the outer edge is pushed out so no chord cuts the stroke. */
const RING_SEGMENTS = 96;

// Rings are drawn as a thin annulus, so only pixels near the ring are shaded; a bounding
// square around a large shockwave would shade most of the screen for a 2 px line.
const RING_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_shape;
layout(location = 2) in vec4 a_color;
uniform vec2 u_res;
uniform float u_px;
out vec2 v_local;
out vec4 v_shape;
out vec4 v_color;
void main() {
  float pad = a_shape.w * 0.5 + u_px;
  float radius = a_corner.y < 0.0
    ? max(a_shape.z - pad, 0.0)
    : (a_shape.z + pad) / cos(3.14159265 / ${RING_SEGMENTS}.0);
  vec2 local = vec2(cos(a_corner.x), sin(a_corner.x)) * radius;
  v_local = local;
  v_shape = a_shape;
  v_color = a_color;
  vec2 clip = (a_shape.xy + local) / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const SHAPE_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_shape;
in vec4 v_color;
uniform float u_px;
out vec4 o;
void main() {
  float d = length(v_local);
  float r = v_shape.z;
  float w = v_shape.w;
  float cover;
  if (w > 0.0) {
    cover = clamp((w * 0.5 - abs(d - r)) / u_px + 0.5, 0.0, 1.0);
  } else if (w < 0.0) {
    // Radial glow: full at the centre, 35% by a third of the way out, gone at the edge.
    float t = d / r;
    cover = t < 0.35 ? mix(1.0, 0.35, t / 0.35) : mix(0.35, 0.0, clamp((t - 0.35) / 0.65, 0.0, 1.0));
  } else {
    cover = clamp((r - d) / u_px + 0.5, 0.0, 1.0);
  }
  o = v_color * cover;
}`;

const DOWN_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  o = vec4(c * 0.25, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 0.227;
  c += texture(u_tex, v_uv + u_step * 1.385).rgb * 0.316;
  c += texture(u_tex, v_uv - u_step * 1.385).rgb * 0.316;
  c += texture(u_tex, v_uv + u_step * 3.231).rgb * 0.0703;
  c += texture(u_tex, v_uv - u_step * 3.231).rgb * 0.0703;
  o = vec4(c, 1.0);
}`;

// Backdrop glows and the vignette amount, rendered at quarter resolution into a small
// texture only when they change; smooth gradients upscale without visible loss.
const BACKDROP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec2 u_res;
uniform vec3 u_ground;
uniform vec4 u_buy;
uniform vec4 u_sell;
uniform vec3 u_atmo;
uniform float u_seam;
uniform float u_vig_from;
out vec4 o;
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_res;
  // The ground, then the sell glow, the buy glow and the heat along the front.
  vec3 bg = u_ground;
  bg = mix(bg, u_sell.rgb, u_sell.a * max(0.0, 1.0 - distance(p, vec2(u_res.x, u_atmo.x)) / u_atmo.y));
  bg = mix(bg, u_buy.rgb, u_buy.a * max(0.0, 1.0 - distance(p, vec2(0.0, u_atmo.x)) / u_atmo.y));
  bg = mix(bg, vec3(1.0, 0.94, 0.88), u_seam * max(0.0, 1.0 - abs(p.x - u_atmo.z) / 160.0));
  vec2 half_res = u_res * 0.5;
  float k = clamp((length(p - half_res) / length(half_res) - u_vig_from) / (1.0 - u_vig_from), 0.0, 1.0);
  o = vec4(bg, k);
}`;

const PRESENT_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_glow;
uniform sampler2D u_back;
uniform float u_glow_a;
uniform float u_ink;
uniform vec4 u_vig;
out vec4 o;
void main() {
  vec4 back = texture(u_back, v_uv);
  vec3 t = min(texture(u_trail, v_uv).rgb + texture(u_glow, v_uv).rgb * u_glow_a, vec3(1.0));
  // Light-emitting grounds screen the trails over the backdrop; paper multiplies ink into it.
  vec3 c = mix(1.0 - (1.0 - back.rgb) * (1.0 - t), back.rgb * t, u_ink);
  o = vec4(mix(c, u_vig.rgb, back.a * u_vig.a), 1.0);
}`;

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

type Programs = {
  fill: WebGLProgram;
  seg: WebGLProgram;
  shape: WebGLProgram;
  ring: WebGLProgram;
  backdrop: WebGLProgram;
  down: WebGLProgram;
  blur: WebGLProgram;
  present: WebGLProgram;
};

export class GLTrail {
  readonly canvas: HTMLCanvasElement;
  lost = false;
  private gl: WebGL2RenderingContext;
  private programs!: Programs;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private quadVao!: WebGLVertexArrayObject;
  private segVao!: WebGLVertexArrayObject;
  private segBuffer!: WebGLBuffer;
  private segCapacity = 0;
  private shapeVao!: WebGLVertexArrayObject;
  private ringVao!: WebGLVertexArrayObject;
  private shapeBuffer!: WebGLBuffer;
  private shapeCapacity = 0;
  private trail: Target | null = null;
  private glowA: Target | null = null;
  private glowB: Target | null = null;
  private back: Target | null = null;
  private backKey = "";
  private half = true;
  private blank = false;
  private cssW = 1;
  private cssH = 1;
  private scale = 1;

  /** Returns null when WebGL2 is unavailable, so the caller can fall back to Canvas2D. */
  static create(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      // Software-emulated WebGL is slower than Canvas2D's own rasteriser; let those devices fall back.
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) return null;
    try {
      return new GLTrail(canvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.init();
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.init();
      this.trail = this.glowA = this.glowB = this.back = null;
      this.resize(this.cssW, this.cssH, this.scale);
    });
  }

  private init() {
    const gl = this.gl;
    // Rendering to half float is near universal; plain 8-bit targets are the fallback.
    this.half = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
    gl.getExtension("OES_texture_float_linear");
    this.uniforms.clear();
    this.programs = {
      fill: this.program(QUAD_VS, FILL_FS),
      seg: this.program(SEG_VS, SEG_FS),
      shape: this.program(SHAPE_VS, SHAPE_FS),
      ring: this.program(RING_VS, SHAPE_FS),
      backdrop: this.program(QUAD_VS, BACKDROP_FS),
      down: this.program(QUAD_VS, DOWN_FS),
      blur: this.program(QUAD_VS, BLUR_FS),
      present: this.program(QUAD_VS, PRESENT_FS),
    };

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.segVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.segBuffer = gl.createBuffer()!;
    this.segCapacity = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);

    this.shapeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.shapeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.shapeBuffer = gl.createBuffer()!;
    this.shapeCapacity = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SHAPE_STRIDE * 4, 0);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribDivisor(2, 1);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, SHAPE_STRIDE * 4, 16);

    // Ring mesh: per vertex (angle, -1 inner | +1 outer), as one closed triangle strip.
    const ring = new Float32Array((RING_SEGMENTS + 1) * 4);
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2;
      ring.set([angle, -1, angle, 1], i * 4);
    }
    this.ringVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ringVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, ring, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  /** True once after the trail buffer was created empty (first use, or a restored context). */
  takeBlank() {
    const blank = this.blank;
    this.blank = false;
    return blank;
  }

  /** Sizes the trail to the CSS box at `scale` device pixels per CSS pixel, keeping what is drawn. */
  resize(cssW: number, cssH: number, scale: number) {
    const gl = this.gl;
    this.cssW = cssW;
    this.cssH = cssH;
    this.scale = scale;
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.lost) return;
    const old = this.trail;
    if (old && old.w === w && old.h === h) return;
    const next = this.target(w, h);
    if (old) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, next.fbo);
      gl.blitFramebuffer(0, 0, old.w, old.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      this.dispose(old);
    }
    this.trail = next;
    const gw = Math.max(1, Math.round(cssW / 4));
    const gh = Math.max(1, Math.round(cssH / 4));
    if (this.glowA) this.dispose(this.glowA);
    if (this.glowB) this.dispose(this.glowB);
    if (this.back) this.dispose(this.back);
    this.glowA = this.target(gw, gh);
    this.glowB = this.target(gw, gh);
    this.back = this.target(gw, gh, false);
    this.backKey = "";
    if (!old) this.blank = true;
  }

  clear(rgb: Rgba) {
    if (!this.ready()) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail!.fbo);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Pulls every trail pixel `amount` of the way back toward the ground colour. */
  fade(rgb: Rgba, amount: number) {
    if (!this.ready()) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail!.fbo);
    gl.viewport(0, 0, this.trail!.w, this.trail!.h);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.fill(rgb[0], rgb[1], rgb[2], amount);
    if (!this.half) {
      // An 8-bit fade stalls a few levels short of the ground; nudge the residue the last step.
      const toward = rgb[0] > 0.5 ? gl.FUNC_ADD : gl.FUNC_REVERSE_SUBTRACT;
      gl.blendEquation(toward);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.fill(1.5 / 255, 1.5 / 255, 1.5 / 255, 1);
      gl.blendEquation(gl.FUNC_ADD);
    }
  }

  /** Uploads every streak for this frame as x0, y0, x1, y1 in CSS pixels. */
  upload(data: Float32Array, count: number) {
    if (!this.ready() || count === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuffer);
    const bytes = count * 16;
    if (bytes > this.segCapacity) {
      this.segCapacity = Math.max(bytes, this.segCapacity * 2, 64 * 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.segCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 4);
  }

  /**
   * Draws `count` uploaded streaks starting at `first`, `width` CSS pixels wide, into the
   * trail, or with `screen` straight onto the canvas (after `present`), faded at both ends.
   */
  strokes(first: number, count: number, color: Rgba, width: number, additive: boolean, screen = false) {
    if (!this.ready() || count <= 0) return;
    const gl = this.gl;
    const prog = this.programs.seg;
    this.bindOutput(screen);
    gl.useProgram(prog);
    gl.uniform2f(this.u(prog, "u_res"), this.cssW, this.cssH);
    gl.uniform1f(this.u(prog, "u_half"), width / 2);
    gl.uniform1f(this.u(prog, "u_px"), 1 / this.scale);
    gl.uniform1f(this.u(prog, "u_fade"), screen ? 1 : 0);
    gl.uniform4f(this.u(prog, "u_color"), color[0], color[1], color[2], color[3]);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuffer);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, first * 16);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  /**
   * Draws shapes (see SHAPE_STRIDE) straight onto the canvas after `present`: the first
   * `quads` are discs and glows, the `rings` after them are rings. Added as light on dark
   * grounds, laid over like paint on paper.
   */
  shapes(data: Float32Array, quads: number, rings: number, additive: boolean) {
    const count = quads + rings;
    if (!this.ready() || count <= 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
    const bytes = count * SHAPE_STRIDE * 4;
    if (bytes > this.shapeCapacity) {
      this.shapeCapacity = Math.max(bytes, this.shapeCapacity * 2, 16 * 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.shapeCapacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * SHAPE_STRIDE);
    this.bindOutput(true);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    const stride = SHAPE_STRIDE * 4;
    if (quads > 0) {
      const prog = this.programs.shape;
      gl.useProgram(prog);
      gl.uniform2f(this.u(prog, "u_res"), this.cssW, this.cssH);
      gl.uniform1f(this.u(prog, "u_px"), 1 / this.scale);
      gl.bindVertexArray(this.shapeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, quads);
    }
    if (rings > 0) {
      const prog = this.programs.ring;
      gl.useProgram(prog);
      gl.uniform2f(this.u(prog, "u_res"), this.cssW, this.cssH);
      gl.uniform1f(this.u(prog, "u_px"), 1 / this.scale);
      gl.bindVertexArray(this.ringVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuffer);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, quads * stride);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, quads * stride + 16);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (RING_SEGMENTS + 1) * 2, rings);
    }
    gl.bindVertexArray(null);
  }

  /**
   * Paints the finished frame: backdrop, trail (with bloom on dark grounds) and vignette.
   * `backKey` names the backdrop's state; it is only re-rendered when the key changes.
   */
  present(c: Composite, backKey: string) {
    if (!this.ready()) return;
    const gl = this.gl;
    const trail = this.trail!;
    const a = this.glowA!;
    const b = this.glowB!;
    const back = this.back!;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quadVao);
    if (backKey !== this.backKey) {
      this.backKey = backKey;
      const p = this.programs.backdrop;
      gl.bindFramebuffer(gl.FRAMEBUFFER, back.fbo);
      gl.viewport(0, 0, back.w, back.h);
      gl.useProgram(p);
      gl.uniform2f(this.u(p, "u_res"), this.cssW, this.cssH);
      gl.uniform3f(this.u(p, "u_ground"), c.ground[0], c.ground[1], c.ground[2]);
      gl.uniform4f(this.u(p, "u_buy"), c.buy[0], c.buy[1], c.buy[2], c.buy[3]);
      gl.uniform4f(this.u(p, "u_sell"), c.sell[0], c.sell[1], c.sell[2], c.sell[3]);
      gl.uniform3f(this.u(p, "u_atmo"), c.cy, c.reach, c.fx);
      gl.uniform1f(this.u(p, "u_seam"), c.seam);
      gl.uniform1f(this.u(p, "u_vig_from"), c.vignetteFrom);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (c.glow > 0) {
      this.pass(this.programs.down, a, trail.tex, (p) => gl.uniform2f(this.u(p, "u_texel"), 1 / trail.w, 1 / trail.h));
      this.pass(this.programs.blur, b, a.tex, (p) => gl.uniform2f(this.u(p, "u_step"), 1 / a.w, 0));
      this.pass(this.programs.blur, a, b.tex, (p) => gl.uniform2f(this.u(p, "u_step"), 0, 1 / a.h));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const prog = this.programs.present;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, trail.tex);
    gl.uniform1i(this.u(prog, "u_trail"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform1i(this.u(prog, "u_glow"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, back.tex);
    gl.uniform1i(this.u(prog, "u_back"), 2);
    gl.uniform1f(this.u(prog, "u_glow_a"), c.glow);
    gl.uniform1f(this.u(prog, "u_ink"), c.ink ? 1 : 0);
    gl.uniform4f(this.u(prog, "u_vig"), c.vignette[0], c.vignette[1], c.vignette[2], c.vignette[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  private bindOutput(screen: boolean) {
    const gl = this.gl;
    if (screen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail!.fbo);
      gl.viewport(0, 0, this.trail!.w, this.trail!.h);
    }
  }

  private ready() {
    return !this.lost && !!this.trail && !this.gl.isContextLost();
  }

  private pass(prog: WebGLProgram, out: Target, src: WebGLTexture, set: (p: WebGLProgram) => void) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.u(prog, "u_tex"), 0);
    set(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private fill(r: number, g: number, b: number, a: number) {
    const gl = this.gl;
    const prog = this.programs.fill;
    gl.useProgram(prog);
    gl.uniform4f(this.u(prog, "u_color"), r, g, b, a);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private target(w: number, h: number, wide = true): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.half && wide) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (this.half && wide && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this.half = false;
      return this.target(w, h);
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }

  private dispose(t: Target) {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private program(vs: string, fs: string) {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
    }
    return prog;
  }

  private u(prog: WebGLProgram, name: string) {
    let table = this.uniforms.get(prog);
    if (!table) {
      table = new Map();
      this.uniforms.set(prog, table);
    }
    if (!table.has(name)) table.set(name, this.gl.getUniformLocation(prog, name));
    return table.get(name)!;
  }
}
