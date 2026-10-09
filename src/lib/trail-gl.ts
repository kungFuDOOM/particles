/**
 * WebGL2 trail layer. Every particle streak is one instanced quad, so a whole lane is a
 * single draw call instead of thousands of Canvas2D path segments. Trails accumulate in a
 * half-float framebuffer, which fades smoothly all the way to the ground with no 8-bit
 * residue, and the bloom is a quarter-resolution separable blur done on the GPU.
 */

export type Rgba = readonly [number, number, number, number];

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
out vec4 o;
void main() {
  float t = v_local.x - clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(t, v_local.y));
  float cover = clamp((u_half - dist) / u_px + 0.5, 0.0, 1.0);
  o = vec4(u_color.rgb, u_color.a * cover);
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

const PRESENT_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_glow;
uniform float u_glow_a;
out vec4 o;
void main() {
  vec3 c = texture(u_trail, v_uv).rgb + texture(u_glow, v_uv).rgb * u_glow_a;
  o = vec4(min(c, vec3(1.0)), 1.0);
}`;

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

type Programs = {
  fill: WebGLProgram;
  seg: WebGLProgram;
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
  private trail: Target | null = null;
  private glowA: Target | null = null;
  private glowB: Target | null = null;
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
      this.trail = this.glowA = this.glowB = null;
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
    this.glowA = this.target(gw, gh);
    this.glowB = this.target(gw, gh);
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

  /** Draws `count` uploaded streaks starting at `first`, `width` CSS pixels wide. */
  strokes(first: number, count: number, color: Rgba, width: number, additive: boolean) {
    if (!this.ready() || count <= 0) return;
    const gl = this.gl;
    const prog = this.programs.seg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail!.fbo);
    gl.viewport(0, 0, this.trail!.w, this.trail!.h);
    gl.useProgram(prog);
    gl.uniform2f(this.u(prog, "u_res"), this.cssW, this.cssH);
    gl.uniform1f(this.u(prog, "u_half"), width / 2);
    gl.uniform1f(this.u(prog, "u_px"), 1 / this.scale);
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

  /** Puts the trail (and, on dark grounds, its bloom) on screen. */
  present(glow: number) {
    if (!this.ready()) return;
    const gl = this.gl;
    const trail = this.trail!;
    const a = this.glowA!;
    const b = this.glowB!;
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quadVao);
    if (glow > 0) {
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
    gl.uniform1f(this.u(prog, "u_glow_a"), glow);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
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

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (this.half && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
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
