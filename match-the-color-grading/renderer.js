// WebGL renderer: applies all eight adjustments to the photo in one GPU pass.

const PARAMS = [
  'brightness', 'contrast', 'highlights', 'midtones', 'shadows', 'saturation', 'temp', 'noise',
  'tintSx', 'tintSy', 'tintMx', 'tintMy', 'tintHx', 'tintHy',
];
const GRAIN_CELLS = 800; // grain cells along the photo's long edge

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_img;
uniform vec2 u_grain;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_midtones;
uniform float u_shadows;
uniform float u_saturation;
uniform float u_temp;
uniform float u_noise;
uniform float u_tintSx;
uniform float u_tintSy;
uniform float u_tintMx;
uniform float u_tintMy;
uniform float u_tintHx;
uniform float u_tintHy;
varying vec2 v_uv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// A colour-wheel position as an RGB shift: red at 0 degrees, green at 120, blue at 240,
// with the brightness change removed so a tint only changes colour.
vec3 tint(float x, float y) {
  vec3 rgb = x * vec3(1.0, -0.5, -0.5) + y * vec3(0.0, 0.866, -0.866);
  return rgb - dot(rgb, LUMA);
}

// Random values on a grid, blended smoothly between cells so grains have soft edges.
float soft(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}

void main() {
  vec3 c = texture2D(u_img, v_uv).rgb;

  // White balance and exposure in linear light.
  vec3 lin = pow(c, vec3(2.2));
  vec3 gain = vec3(1.0 + 0.3 * u_temp, 1.0, 1.0 - 0.3 * u_temp);
  gain /= dot(gain, LUMA);
  lin *= gain * exp2(u_brightness);
  c = pow(lin, vec3(1.0 / 2.2));

  // Tonal adjustments in gamma space, where they match what the eye sees.
  c = (c - 0.5) * (1.0 + 0.5 * u_contrast) + 0.5;
  float l = clamp(dot(c, LUMA), 0.0, 1.0);
  float sm = 1.0 - smoothstep(0.0, 0.5, l);
  float hm = smoothstep(0.5, 1.0, l);
  float mm = 4.0 * l * (1.0 - l);
  c += 0.25 * u_shadows * sm + 0.2 * u_midtones * mm + 0.25 * u_highlights * hm;

  // Colour wheels: a tint for each of the same three tonal ranges.
  c += 0.15 * (sm * tint(u_tintSx, u_tintSy) + mm * tint(u_tintMx, u_tintMy) + hm * tint(u_tintHx, u_tintHy));

  // Saturation around the pixel's own brightness.
  l = dot(c, LUMA);
  c = mix(vec3(l), c, max(0.0, 1.0 + u_saturation));

  // Film-style grain, fixed to the photo: fine grains plus larger rotated clumps,
  // mostly brightness with a little colour, strongest in the midtones.
  vec2 p = v_uv * u_grain;
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p * 0.55;
  float g = (soft(p) + soft(p + 57.3) - 1.0) + 0.35 * (soft(q) - 0.5);
  vec3 chroma = vec3(soft(p + 11.7), soft(p + 23.1), soft(p + 37.9)) - 0.5;
  l = clamp(dot(c, LUMA), 0.0, 1.0);
  float tone = 0.4 + 0.6 * 4.0 * l * (1.0 - l);
  c += u_noise * tone * (0.306 * g + 0.068 * chroma);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
  if (!gl) throw new Error('WebGL is not available in this browser.');

  let uniforms = {};
  let image = null;
  let params = {};
  let grain = [1, 1];
  let queued = false;

  function init() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    uniforms = { grain: gl.getUniformLocation(program, 'u_grain') };
    for (const name of PARAMS) {
      uniforms[name] = gl.getUniformLocation(program, 'u_' + name);
    }

    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  function upload() {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  function draw() {
    queued = false;
    if (!image || gl.isContextLost()) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.grain, grain[0], grain[1]);
    for (const name of PARAMS) {
      gl.uniform1f(uniforms[name], params[name] || 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Coalesce updates so the image is drawn at most once per frame.
  function requestDraw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    init();
    if (image) upload();
    requestDraw();
  });

  init();

  return {
    setImage(img) {
      image = img;
      // Square grain cells counted along the photo, so the grain scales with it.
      const scale = GRAIN_CELLS / Math.max(img.naturalWidth, img.naturalHeight);
      grain = [img.naturalWidth * scale, img.naturalHeight * scale];
      upload();
      requestDraw();
    },
    setParams(next) {
      params = next;
      requestDraw();
    },
    // Draws immediately with the given settings and returns the canvas pixels as RGBA bytes.
    read(next) {
      params = next;
      draw();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    },
    // cssWidth/cssHeight are the displayed size.
    resize(cssWidth, cssHeight) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      requestDraw();
    },
  };
}
